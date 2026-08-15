// The gen orchestrator: the one impure edge of the toolkit. It reads an app's manifest and
// models, runs the pure derivers, and either writes the artifacts to disk (`urban gen`) or
// compares them against what's on disk and reports drift (`urban gen --check`). The derivers stay
// pure; all IO is confined here behind a tiny FS port so the same code runs on Node and Deno.

import type { DerivedArtifact } from "./artifact.ts";
import { GENERATED_DIR, isAbsolutePath, RUNTIME_MATERIALIZED_ARTIFACTS, sortArtifacts } from "./artifact.ts";
import { deriveMigrations, type ToolkitManifest } from "./derivers/migrations.ts";
import { emitDomainModel, registryFromManifest, sourcesFromManifest } from "./derivers/domain.ts";
import { byModelPath, deriveWorkerBindings, detectEnvelopeConflicts, DOMAIN_DTS, formatEnvelopeConflict, type ModelSource, scanModelWorkers } from "./derivers/worker-io.ts";
import { deriveMeta } from "./derivers/meta.ts";
import { deriveMessageBindings } from "./derivers/messages.ts";
import { resolveShapes, scanModelShapes } from "./derivers/shapes.ts";
import { deriveApi } from "./derivers/api.ts";
import { parseSpec, sharedRequestBodySchemas } from "../openapi/spec.ts";
import { deriveModels, type DerivedModels, type ModelError, MODEL_PROVENANCE } from "./models.ts";

/** Minimal filesystem port. Node/Deno impls live in `fsio.ts`. */
export interface GenIO {
  readText(path: string): Promise<string>;
  writeText(path: string, content: string): Promise<void>;
  /** File names (not paths) in a directory; empty if it does not exist. */
  listDir(path: string): Promise<string[]>;
  /**
   * Sub-directory names (not files) in a directory; empty if it does not exist. Optional: the
   * deploy-by-convention model scan uses it to descend one level into `resources/<subdir>/`. When
   * absent, only files directly under `resources/` are scanned.
   */
  listSubdirs?(path: string): Promise<string[]>;
  exists(path: string): Promise<boolean>;
  /**
   * Import an app module and return its exports. Optional: only present when the caller runs on
   * a runtime that can load the app's TypeScript (Node with type-stripping, or Deno). Code-first
   * model derivation (`workflows/*.ts` → BPMN) needs it; when absent, gen still derives everything
   * else (migrations, domain, worker I/O from authored/derived models).
   */
  importModule?(path: string): Promise<Record<string, unknown>>;
  /** Delete a file. Optional: enables the provenance-scoped stale-model sweep (skipped when absent). */
  remove?(path: string): Promise<void>;
}

export interface GenOptions {
  root: string;
  io: GenIO;
  manifestFile?: string;
  /**
   * Whether to emit (write) derived `.bpmn` models. Default true. When false, code-first models
   * are still derived *in-memory* to feed the type-contract derivers (worker I/O, meta, messages)
   * — they are just not written to disk or swept. This is the `urban gen --no-models` path, so
   * the console's type-contract regen never mutates `processes/*.bpmn`.
   */
  emitModels?: boolean;
  /** Derive ONLY the models (skip migrations/domain/worker-I/O). The `urban derive` path. */
  modelsOnly?: boolean;
}

export interface GenResult {
  artifacts: DerivedArtifact[];
  /** Paths that differ from disk (only populated by `check`). */
  drift: string[];
  /** App-relative paths of stale files removed from `nano-generated/` (only populated in write mode). */
  swept: string[];
  /** True if any code-first workflow failed to import/derive. */
  incomplete: boolean;
  /** Per-file model-derivation errors (empty on success). */
  modelErrors: ModelError[];
  /** Non-fatal spec-hygiene warnings (e.g. a requestBody schema shared by >1 operation). Empty on
   *  a clean spec. Surfaced by the CLI but never fail gen/check — advisory only. */
  warnings: string[];
}

function join(root: string, rel: string): string {
  // Normalize Windows-style separators to forward slashes (GenIO uses forward slashes on all
  // platforms — matching the runtime's resolveAppPath) and trim edge separators, so callers may
  // pass either style without gen/runtime drift over where a file resolves.
  const norm = (s: string): string => s.replace(/\\/g, "/");
  // An absolute `rel` resolves to itself — never prefixed with `root` — mirroring the runtime's
  // resolveAppPath (isAbsolutePath is the shared SoT in artifact.ts). Without this an absolute
  // manifest path (e.g. "/abs/openapi.json") would be stripped to root-relative and gen would
  // read/derive a different file than the runtime resolves. Trailing edge separators are still
  // trimmed for stable, comparable artifact keys.
  if (isAbsolutePath(rel)) return norm(rel).replace(/\/+$/, "");
  return `${norm(root).replace(/\/+$/, "")}/${norm(rel).replace(/^\/+/, "")}`;
}

function dirOf(p: string): string {
  const i = p.lastIndexOf("/");
  return i <= 0 ? "." : p.slice(0, i);
}

/** Resolve a `dir/*.ext` (or literal) manifest pattern to file paths relative to root. */
export async function expandPattern(root: string, io: GenIO, pattern: string): Promise<string[]> {
  const star = pattern.indexOf("*");
  if (star === -1) {
    return (await io.exists(join(root, pattern))) ? [pattern] : [];
  }
  const slash = pattern.lastIndexOf("/", star);
  const dir = slash === -1 ? "." : pattern.slice(0, slash);
  const tail = pattern.slice(slash + 1); // e.g. "*.bpmn"
  const ext = tail.startsWith("*") ? tail.slice(1) : tail;
  const names = await io.listDir(join(root, dir));
  return names
    .filter((n) => n.endsWith(ext))
    .map((n) => (dir === "." ? n : `${dir}/${n}`))
    .sort();
}

/** The deploy-by-convention directory (ADR 0062): when the manifest declares no `models`, both the
 *  runtime deploy and this codegen scan discover deployables/models under it — shallow, one level
 *  deep (`resources/*` and `resources/<subdir>/*`). Deploy-only by convention. */
export const RESOURCES_DIR = "resources";

/** Model file extensions the `nano:shape`/code-first scan reads by convention (BPMN + DMN). */
const MODEL_EXTS = [".bpmn", ".dmn"];

/**
 * Discover model files under `resources/` by convention — shallow, one level deep (`resources/*`
 * and `resources/<subdir>/*`), never deeper — mirroring the runtime deploy walk so the codegen scan
 * and the deploy see the same set. Returns root-relative paths, sorted. Descending one level needs
 * `io.listSubdirs`; without it only the files directly under `resources/` are scanned.
 */
export async function discoverResourceModels(root: string, io: GenIO): Promise<string[]> {
  const isModel = (n: string): boolean => MODEL_EXTS.some((e) => n.endsWith(e));
  const out: string[] = [];
  for (const n of await io.listDir(join(root, RESOURCES_DIR))) {
    if (isModel(n)) out.push(`${RESOURCES_DIR}/${n}`);
  }
  const subdirs = io.listSubdirs ? await io.listSubdirs(join(root, RESOURCES_DIR)) : [];
  for (const sub of subdirs.slice().sort()) {
    for (const n of await io.listDir(join(root, `${RESOURCES_DIR}/${sub}`))) {
      if (isModel(n)) out.push(`${RESOURCES_DIR}/${sub}/${n}`);
    }
  }
  return out.sort();
}

/**
 * Read + resolve the app's process models. Convention is keyed off the *absence* of the entire
 * `models` block — mirroring the runtime deploy (ADR 0062): with no `models` block, models are
 * discovered by convention under `resources/`; with a `models` block declared, `models.processes`
 * is the explicit override (used verbatim, possibly empty). Keying off a missing `models.processes`
 * alone would fall back to convention even when a `models` block is present for other overrides
 * (e.g. forms), letting gen scan/derive process models the runtime deploy will never deploy —
 * gen/runtime drift.
 */
export async function readModels(
  root: string,
  io: GenIO,
  manifest: { models?: { processes?: string[] } },
): Promise<ModelSource[]> {
  const byConvention = manifest.models === undefined;
  let rels: string[];
  if (byConvention) {
    rels = await discoverResourceModels(root, io);
  } else {
    rels = [];
    for (const pat of manifest.models?.processes ?? []) {
      rels.push(...(await expandPattern(root, io, pat)));
    }
  }
  const models: ModelSource[] = [];
  const seen = new Set<string>();
  for (const rel of rels) {
    if (seen.has(rel)) continue;
    seen.add(rel);
    models.push({ path: rel, xml: await io.readText(join(root, rel)) });
  }
  return models;
}

/** Collect all artifacts a run would produce, without touching disk beyond reads. */
export async function collectArtifacts(opts: GenOptions): Promise<DerivedArtifact[]> {
  return (await collectAll(opts)).artifacts;
}

/** Internal: collect artifacts AND the model-derivation details (needed by `runGen` for the
 * incomplete signal + the provenance-scoped stale sweep). */
async function collectAll(opts: GenOptions): Promise<{ artifacts: DerivedArtifact[]; derived: DerivedModels; warnings: string[] }> {
  const { root, io } = opts;
  const emitModels = opts.emitModels ?? true;
  const manifestPath = join(root, opts.manifestFile ?? "nano.app.json");
  const manifest: ToolkitManifest & {
    models?: { processes?: string[]; workflows?: string[] };
    api?: { spec?: string; dir?: string; eject?: boolean };
  } = JSON.parse(await io.readText(manifestPath));

  const artifacts: DerivedArtifact[] = [];
  const warnings: string[] = [];

  // 1. Resolve the app's models first (code-first `workflows/*.ts` → BPMN, plus authored on-disk
  //    `.bpmn`): the fused domain model (below) lifts `nano:shape` envelopes *from* the models, so
  //    they must be in hand before the domain + worker/message type-contracts are derived.
  const derived = await deriveModels(root, io, manifest);
  //    The derived `.bpmn` are emitted only when `emitModels` (default), but always fed to the
  //    type-contract derivers so worker I/O works for a code-first app even on a `--no-models` run.
  if (emitModels) artifacts.push(...derived.artifacts);
  const derivedPaths = new Set(derived.artifacts.map((a) => a.path));
  const diskModels = (await readModels(root, io, manifest)).filter((m) => !derivedPaths.has(m.path));
  const models = [...diskModels, ...derived.models];

  // 2. Fused domain model (ADR 0040): the `DomainTypes` registry is the union of the manifest
  //    `types` registry and the model-authored `nano:shape` envelopes, resolved through the same
  //    fuse the console reifier (`envelope_scan.rs`) uses. Without this the standalone `urban gen`
  //    would honour only `manifest.types` and silently ignore every model-authored data envelope,
  //    so worker/message I/O against those envelopes would fall back to the untyped `WorkerVars`.
  const manifestRegistry = registryFromManifest(manifest);
  const sources = sourcesFromManifest(manifest);
  const shapeDecls = models.flatMap((m) => scanModelShapes(m.xml));
  const shapeResolution = resolveShapes(shapeDecls, manifestRegistry, sources);
  const fusedTypes = { ...manifestRegistry, ...shapeResolution.types };
  for (const d of shapeResolution.diagnostics) {
    warnings.push(`data-envelope shape "${d.shape}" (${d.kind}): ${d.message}`);
  }

  // 3. types → migrations (persisted `manifest.types` only — shapes are transient wire envelopes,
  //    never tables) + the fused domain row types (`DomainTables` spine + `DomainTypes` registry).
  if (!opts.modelsOnly && manifest.types && Object.keys(manifest.types).length > 0) {
    artifacts.push(...deriveMigrations(manifest));
  }
  if (!opts.modelsOnly && Object.keys(fusedTypes).length > 0) {
    artifacts.push({
      path: `${GENERATED_DIR}/${DOMAIN_DTS}`,
      content: emitDomainModel(sources, manifest.data?.default ?? "app", fusedTypes),
    });
  }

  // 4. models (authored on-disk + derived) → worker I/O index + meta accessor + message map. The
  //    declared type ids include the fused shapes, so an envelope ref to a model-authored shape
  //    resolves to its `DomainTypes[...]` entry instead of degrading to the untyped fallback.
  if (!opts.modelsOnly) {
    if (models.length > 0) {
      const declaredTypeIds = Object.keys(fusedTypes);
      artifacts.push(...deriveWorkerBindings(models, declaredTypeIds));
      artifacts.push(...deriveMeta(models));
      artifacts.push(...deriveMessageBindings(models, declaredTypeIds));
      // Surface genuine data-envelope conflicts: a taskType whose variants disagree on a field's
      // TYPE. The emitted contract is the union of the variants (sound for a shared handler), so a
      // type clash would silently widen to `A | B` — warn instead so the author unifies the envelope.
      const scannedWorkers = [...models]
        .sort(byModelPath)
        .flatMap((m) => scanModelWorkers(m.xml))
        .map((w) => ({ taskType: w.taskType, inputType: w.in, outputType: w.out }));
      for (const c of detectEnvelopeConflicts(scannedWorkers, fusedTypes)) {
        warnings.push(formatEnvelopeConflict(c));
      }
    }
  }

  // 4. OpenAPI `api` binding → typed endpoint contracts (ADR 0058). Fail-closed: a declared spec
  //    that is missing or malformed throws here so `urban gen`/`urban check` surfaces it. Trim the
  //    spec path so benign whitespace matches the runtime's readApiBinding (no gen/runtime drift).
  const specRef = typeof manifest.api?.spec === "string" ? manifest.api.spec.trim() : "";
  if (!opts.modelsOnly && specRef.length > 0) {
    const specText = await io.readText(join(root, specRef));
    const opsDir = typeof manifest.api?.dir === "string" && manifest.api.dir.trim().length > 0
      ? manifest.api.dir.trim()
      : undefined;
    const doc = parseSpec(specText);
    artifacts.push(...deriveApi(doc, opsDir, manifest.api?.eject === true));
    // Non-fatal spec-hygiene: a requestBody schema reused by >1 operation can't be tightened into
    // per-operation discriminated variants — flag it so the author can split it (never fail gen).
    for (const { ref, operationIds } of sharedRequestBodySchemas(doc)) {
      warnings.push(
        `requestBody schema ${ref} is shared by ${operationIds.length} operations ` +
          `(${operationIds.join(", ")}). A single schema can't model per-operation discriminants — ` +
          "consider splitting it into named variants + oneOf (additionalProperties:false) per operation.",
      );
    }
  }

  return { artifacts: sortArtifacts(artifacts), derived, warnings };
}

/** Run the derivers and write artifacts (or, with `check`, report drift without writing). */
export async function runGen(opts: GenOptions & { check?: boolean }): Promise<GenResult> {
  const { artifacts, derived, warnings } = await collectAll(opts);
  const { root, io } = opts;
  const emitModels = opts.emitModels ?? true;
  const drift: string[] = [];

  for (const a of artifacts) {
    const abs = join(root, a.path);
    if (opts.check) {
      const current = (await io.exists(abs)) ? await io.readText(abs) : null;
      if (current !== a.content) drift.push(a.path);
    } else {
      await io.writeText(abs, a.content);
    }
  }

  // Provenance-scoped stale sweep: delete derived `.bpmn` for flows that no longer exist. Only
  // in write mode, only when we emitted models, only on a complete derivation (never delete when
  // a workflow failed to load), and only files bearing our marker (authored models are untouched).
  if (!opts.check && emitModels && derived.attempted && !derived.incomplete && io.remove) {
    const keep = new Set(derived.artifacts.map((a) => a.path));
    for (const name of await io.listDir(join(root, derived.outDir))) {
      if (!name.endsWith(".bpmn")) continue;
      const rel = `${derived.outDir}/${name}`;
      if (keep.has(rel)) continue;
      const content = await io.readText(join(root, rel));
      if (content.includes(MODEL_PROVENANCE)) await io.remove(join(root, rel));
    }
  }

  // Stale-artifact sweep of `nano-generated/` (clean break, nano-bpm#: gen owns its output dir).
  // The dir is gitignored and fully codegen-owned, so any file this run did not (re)write is stale
  // from a prior gen — a renamed or removed artifact (e.g. an old `data_sdk.ts`) whose orphan the
  // app might still import. Remove it. The one exception is the runtime-materialized set: the SDK
  // shims + the `urban data`/console dataops wrappers gen does NOT emit but the app needs at runtime
  // (RUNTIME_MATERIALIZED_ARTIFACTS). Protect those by name. Write mode only; skipped when io.remove
  // is absent (the sweep is best-effort, mirroring the `.bpmn` sweep above). NOT on `modelsOnly`
  // (`urban derive`): that path derives only models, so `artifacts` carries no `nano-generated/*` and
  // sweeping would wrongly wipe the type-contract outputs a prior `urban gen` wrote.
  const swept: string[] = [];
  if (!opts.check && !opts.modelsOnly && !derived.incomplete && io.remove) {
    const keep = new Set(
      artifacts.map((a) => a.path).filter((p) => p.startsWith(`${GENERATED_DIR}/`)),
    );
    for (const name of RUNTIME_MATERIALIZED_ARTIFACTS) keep.add(`${GENERATED_DIR}/${name}`);
    for (const name of await io.listDir(join(root, GENERATED_DIR))) {
      const rel = `${GENERATED_DIR}/${name}`;
      if (keep.has(rel)) continue;
      await io.remove(join(root, rel));
      swept.push(rel);
    }
  }

  return { artifacts, drift, swept: swept.sort(), incomplete: derived.incomplete, modelErrors: derived.errors, warnings };
}

export { dirOf, join as joinPath };

/** Derive code-first models in-memory (no writes) — backs `urban derive --stdout`, the
 * non-mutating preview the console's read-only model viewer uses. */
export async function previewModels(opts: GenOptions): Promise<DerivedModels> {
  const { root, io } = opts;
  const manifestPath = join(root, opts.manifestFile ?? "nano.app.json");
  const manifest: {
    models?: { processes?: string[]; workflows?: string[] };
  } = JSON.parse(await io.readText(manifestPath));
  return deriveModels(root, io, manifest);
}
