// The gen orchestrator: the one impure edge of the toolkit. It reads an app's manifest and
// models, runs the pure derivers, and either writes the artifacts to disk (`urban gen`) or
// compares them against what's on disk and reports drift (`urban gen --check`). The derivers stay
// pure; all IO is confined here behind a tiny FS port so the same code runs on Node and Deno.

import type { DerivedArtifact } from "./artifact.ts";
import { sortArtifacts } from "./artifact.ts";
import { deriveMigrations, type ToolkitManifest } from "./derivers/migrations.ts";
import { deriveDomain } from "./derivers/domain.ts";
import { deriveWorkerBindings, type ModelSource } from "./derivers/worker-io.ts";
import { deriveMeta } from "./derivers/meta.ts";
import { deriveMessageBindings } from "./derivers/messages.ts";
import { deriveApi } from "./derivers/api.ts";
import { parseSpec } from "../openapi/spec.ts";
import { deriveModels, type DerivedModels, type ModelError, MODEL_PROVENANCE } from "./models.ts";

/** Minimal filesystem port. Node/Deno impls live in `fsio.ts`. */
export interface GenIO {
  readText(path: string): Promise<string>;
  writeText(path: string, content: string): Promise<void>;
  /** File names (not paths) in a directory; empty if it does not exist. */
  listDir(path: string): Promise<string[]>;
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
  /** True if any code-first workflow failed to import/derive. */
  incomplete: boolean;
  /** Per-file model-derivation errors (empty on success). */
  modelErrors: ModelError[];
}

function join(root: string, rel: string): string {
  // Trim either separator so callers may pass Windows-style paths; GenIO
  // implementations accept forward slashes on all platforms.
  return `${root.replace(/[/\\]+$/, "")}/${rel.replace(/^[/\\]+/, "")}`;
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

/** Read + resolve the app's process models from the manifest's `models.processes` patterns. */
export async function readModels(
  root: string,
  io: GenIO,
  manifest: { models?: { processes?: string[] } },
): Promise<ModelSource[]> {
  const procPatterns = manifest.models?.processes ?? [];
  const models: ModelSource[] = [];
  for (const pat of procPatterns) {
    for (const rel of await expandPattern(root, io, pat)) {
      models.push({ path: rel, xml: await io.readText(join(root, rel)) });
    }
  }
  return models;
}

/** Collect all artifacts a run would produce, without touching disk beyond reads. */
export async function collectArtifacts(opts: GenOptions): Promise<DerivedArtifact[]> {
  return (await collectAll(opts)).artifacts;
}

/** Internal: collect artifacts AND the model-derivation details (needed by `runGen` for the
 * incomplete signal + the provenance-scoped stale sweep). */
async function collectAll(opts: GenOptions): Promise<{ artifacts: DerivedArtifact[]; derived: DerivedModels }> {
  const { root, io } = opts;
  const emitModels = opts.emitModels ?? true;
  const manifestPath = join(root, opts.manifestFile ?? "nano.app.json");
  const manifest: ToolkitManifest & {
    models?: { processes?: string[]; workflows?: string[] };
    api?: { spec?: string };
  } = JSON.parse(await io.readText(manifestPath));

  const artifacts: DerivedArtifact[] = [];

  // 1. types → migrations + domain row types (DomainTables spine + DomainTypes registry)
  if (!opts.modelsOnly && manifest.types && Object.keys(manifest.types).length > 0) {
    artifacts.push(...deriveMigrations(manifest));
    artifacts.push(...deriveDomain(manifest));
  }

  // 2. code-first models → derive BPMN from `workflows/*.ts` (executes the app's TS). The derived
  //    `.bpmn` are emitted only when `emitModels` (default), but always fed to the type-contract
  //    derivers below so worker I/O works for a code-first app even on a `--no-models` run.
  const derived = await deriveModels(root, io, manifest);
  if (emitModels) artifacts.push(...derived.artifacts);

  // 3. models (authored on-disk + derived) → worker I/O index + meta accessor + message map.
  //    Drop any on-disk model whose path a derived model already covers, to avoid double-counting.
  if (!opts.modelsOnly) {
    const derivedPaths = new Set(derived.artifacts.map((a) => a.path));
    const diskModels = (await readModels(root, io, manifest)).filter((m) => !derivedPaths.has(m.path));
    const models = [...diskModels, ...derived.models];
    if (models.length > 0) {
      const declaredTypeIds = Object.keys(manifest.types ?? {});
      artifacts.push(...deriveWorkerBindings(models, declaredTypeIds));
      artifacts.push(...deriveMeta(models));
      artifacts.push(...deriveMessageBindings(models, declaredTypeIds));
    }
  }

  // 4. OpenAPI `api` binding → typed endpoint contracts (ADR 0058). Fail-closed: a declared spec
  //    that is missing or malformed throws here so `urban gen`/`urban check` surfaces it.
  if (!opts.modelsOnly && typeof manifest.api?.spec === "string" && manifest.api.spec.length > 0) {
    const specText = await io.readText(join(root, manifest.api.spec));
    artifacts.push(...deriveApi(parseSpec(specText)));
  }

  return { artifacts: sortArtifacts(artifacts), derived };
}

/** Run the derivers and write artifacts (or, with `check`, report drift without writing). */
export async function runGen(opts: GenOptions & { check?: boolean }): Promise<GenResult> {
  const { artifacts, derived } = await collectAll(opts);
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

  return { artifacts, drift, incomplete: derived.incomplete, modelErrors: derived.errors };
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
