// The stub-scaffolder's one impure edge (ADR 0056): read the manifest + models, run the pure
// planner, and — write-if-absent only — create each handler stub and wire it into the manifest.
// Dry-run by default (`write: false`); nothing is touched unless `write` is set. Stubs are
// human-owned, so an existing file is KEPT verbatim, never clobbered (the opposite of `runGen`).

import type { GenIO } from "./gen.ts";
import { joinPath, readModels } from "./gen.ts";
import {
  planWorkerScaffold,
  type ScaffoldWorker,
  type SkippedWorker,
  type StubManifestEntry,
} from "./scaffold/workers.ts";
import { planOperationScaffold } from "./scaffold/operations.ts";
import { parseSpec } from "../openapi/spec.ts";

/**
 * Detect the indentation of a JSON document from its first indented line, so a rewrite can
 * reuse it (`"\t"` or an N-space string) instead of hard-coding one style. Falls back to a tab
 * — the scaffold's Biome default — when the file is empty/single-line or uses no indentation.
 *
 * Any indent — spaces or tabs — is clamped to 10 characters because `JSON.stringify` silently
 * truncates a string `space` argument to 10; returning a wider prefix would promise a fidelity the
 * serializer cannot honor (e.g. an 11+-tab manifest would be rewritten at a different width than
 * its input). Tab indentation (the scaffold default) and any realistic width (2/4 spaces) are
 * unaffected.
 */
export function detectJsonIndent(json: string): string {
  // Anchor on any line terminator, not just `\n`, so the width is detected regardless of the
  // manifest's line endings: LF (`\n`), CRLF (`\r\n`, where `\n` already precedes the indent),
  // bare-CR old-Mac (`\r`), and LFCR (`\n\r`) all resolve to the indentation that follows.
  const m = json.match(/[\r\n]([ \t]+)\S/);
  if (!m) return "\t";
  const indent = m[1];
  return indent.length > 10 ? indent.slice(0, 10) : indent;
}

/** The manifest fields the scaffolder reads. */
interface ScaffoldManifest {
  types?: Record<string, unknown>;
  models?: { processes?: string[] };
  workers?: ScaffoldWorker[];
  externalTaskTypes?: string[];
  api?: { spec?: string; dir?: string };
}

export interface ScaffoldOptions {
  root: string;
  io: GenIO;
  manifestFile?: string;
  /** Apply changes (create files + patch manifest). Default false = dry-run. */
  write?: boolean;
}

export type StubStatus = "created" | "would-create" | "kept";

export interface StubOutcome {
  taskType: string;
  handlerPath: string;
  status: StubStatus;
  typedIn: boolean;
  typedOut: boolean;
}

export interface ScaffoldRun {
  outcomes: StubOutcome[];
  skipped: SkippedWorker[];
  /**
   * Manifest entries that would be appended to `workers[]` — one per planned stub, so this is
   * populated on a dry-run too (letting a caller preview the wiring). They are actually written
   * to the manifest only when `write` is set (see `manifestPatched`).
   */
  wired: StubManifestEntry[];
  manifestPatched: boolean;
  write: boolean;
}

/** Scaffold write-once worker stubs from the model, wiring them into `manifest.workers[]`. */
export async function scaffoldWorkers(opts: ScaffoldOptions): Promise<ScaffoldRun> {
  const { root, io } = opts;
  const write = opts.write ?? false;
  const manifestFile = opts.manifestFile ?? "nano.app.json";
  const manifestPath = joinPath(root, manifestFile);

  const manifestRaw = await io.readText(manifestPath);
  const manifest: ScaffoldManifest = JSON.parse(manifestRaw);
  // Preserve the manifest's own indentation when we patch it back (default tab, matching the
  // scaffold's Biome config), so wiring a worker never reformats the file out from under lint.
  const manifestIndent = detectJsonIndent(manifestRaw);
  const models = await readModels(root, io, manifest);
  const declaredTypeIds = Object.keys(manifest.types ?? {});

  const { plans, skipped } = planWorkerScaffold(
    models,
    manifest.workers ?? [],
    declaredTypeIds,
    manifest.externalTaskTypes ?? [],
  );

  const outcomes: StubOutcome[] = [];
  const wired: StubManifestEntry[] = [];

  for (const plan of plans) {
    const abs = joinPath(root, plan.handlerPath);
    const exists = await io.exists(abs);
    let status: StubStatus;
    if (exists) {
      status = "kept"; // human-owned — never clobber
    } else if (write) {
      await io.writeText(abs, plan.stub);
      status = "created";
    } else {
      status = "would-create";
    }
    outcomes.push({
      taskType: plan.taskType,
      handlerPath: plan.handlerPath,
      status,
      typedIn: plan.typedIn,
      typedOut: plan.typedOut,
    });
    // The planner already excluded already-wired task types, so every plan needs wiring —
    // including an orphan stub file that exists on disk but isn't in the manifest yet.
    wired.push(plan.manifestEntry);
  }

  let manifestPatched = false;
  if (write && wired.length > 0) {
    const withWorkers = {
      ...manifest,
      workers: [...(manifest.workers ?? []), ...wired],
    };
    await io.writeText(manifestPath, `${JSON.stringify(withWorkers, null, manifestIndent)}\n`);
    manifestPatched = true;
  }

  return { outcomes, skipped, wired, manifestPatched, write };
}

/** One planned operation-delegate outcome (write-once). */
export interface OperationStubOutcome {
  operationId: string;
  handlerPath: string;
  status: StubStatus;
}

export interface OperationScaffoldRun {
  outcomes: OperationStubOutcome[];
  write: boolean;
}

/**
 * Scaffold write-once operation-delegate stubs from the app's OpenAPI spec (ADR 0059). One typed
 * `defineOperation` stub per declared `operationId`, created only if absent (human-owned files are
 * kept verbatim). Dry-run by default. A no-op when the app declares no `api.spec`.
 */
export async function scaffoldOperations(opts: ScaffoldOptions): Promise<OperationScaffoldRun> {
  const { root, io } = opts;
  const write = opts.write ?? false;
  const manifestFile = opts.manifestFile ?? "nano.app.json";
  const manifestPath = joinPath(root, manifestFile);

  const manifest: ScaffoldManifest = JSON.parse(await io.readText(manifestPath));
  const specRef = typeof manifest.api?.spec === "string" ? manifest.api.spec.trim() : "";
  if (specRef.length === 0) return { outcomes: [], write };

  const specText = await io.readText(joinPath(root, specRef));
  const dir =
    typeof manifest.api?.dir === "string" && manifest.api.dir.trim().length > 0
      ? manifest.api.dir.trim()
      : undefined;
  const plans = planOperationScaffold(parseSpec(specText), dir);

  const outcomes: OperationStubOutcome[] = [];
  for (const plan of plans) {
    const abs = joinPath(root, plan.handlerPath);
    const exists = await io.exists(abs);
    let status: StubStatus;
    if (exists) {
      status = "kept"; // human-owned — never clobber
    } else if (write) {
      await io.writeText(abs, plan.stub);
      status = "created";
    } else {
      status = "would-create";
    }
    outcomes.push({ operationId: plan.operationId, handlerPath: plan.handlerPath, status });
  }

  return { outcomes, write };
}
