// The unit of derivation output: a file the derivers produce. Everything a deriver emits is a
// (path, content) pair. Derivers are pure — inputs in, artifacts out, no IO — so they are
// trivially testable and deterministic (the property that makes `urban gen --check` a reliable
// drift gate). IO (reading models, writing artifacts, comparing on --check) lives in `gen.ts`.

/** A single generated file. `path` is relative to the app root. */
export interface DerivedArtifact {
  path: string;
  content: string;
}

/**
 * A deriver: a named, pure function from some input to artifacts. The IDE and the `urban gen`
 * CLI are peer callers of the same derivers (ADR: derivation is a shared library).
 */
export interface Deriver<I> {
  readonly id: string;
  readonly describe: string;
  derive(input: I): DerivedArtifact[];
}

/** Where all derived output lands — the console's `nano-generated/` dir, so the toolkit is a
 * drop-in for the IDE's own codegen (ADR 0053). One drift domain, gitignored, never committed. */
export const GENERATED_DIR = "nano-generated";

/**
 * Files that live in `GENERATED_DIR` but are NOT produced by `urban gen`. These are materialized by
 * a different writer — the runtime SDK shims and the `urban data` / console-host dataops path, which
 * derives the typed wrappers from the *live* DB (something `urban gen` can't do without a running
 * datasource). `urban gen`'s stale-file sweep must own only what it emits, so it protects these by
 * name: it never deletes them even though it didn't (re)write them this run. Basenames, relative to
 * `GENERATED_DIR`. Keep in sync with the emitters' filename constants (DOMAIN_BINDINGS,
 * WORKER_BINDINGS_TS, MESSAGE_BINDINGS_TS, DOMAIN_MODEL_JSON) + the `./data-sdk.ts`/`./worker-sdk.ts`
 * shim imports the generated wrappers reference.
 */
export const RUNTIME_MATERIALIZED_ARTIFACTS: readonly string[] = [
  "domain.ts",
  "workers.ts",
  "messages.ts",
  "domain.json",
  "data-sdk.ts",
  "worker-sdk.ts",
];

/** Stable ordering so artifact lists compare deterministically. */
export function sortArtifacts(a: DerivedArtifact[]): DerivedArtifact[] {
  return [...a].sort((x, y) => (x.path < y.path ? -1 : x.path > y.path ? 1 : 0));
}

/** True when `p` is an absolute path — POSIX root (`/`), a drive-letter root (`C:\` or `C:/`), or a
 *  Windows UNC/drive-root backslash (`\`). The single source of truth for the absolute-path rule,
 *  shared by the toolkit's path join (gen.ts) and the runtime's resolveAppPath so both agree on
 *  whether a manifest path is app-root-relative or absolute (no gen/runtime drift). */
export function isAbsolutePath(p: string): boolean {
  return /^(\/|\\|[A-Za-z]:[/\\])/.test(p);
}
