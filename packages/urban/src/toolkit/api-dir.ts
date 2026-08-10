// Shared normalization + validation for the OpenAPI surface's `api.dir` (the directory operation
// delegates live in). Used by BOTH the deriver (which bakes `<dir>/<operationId>` into the generated
// controller's static import paths) and the scaffolder (which writes stubs to `<dir>/<operationId>.ts`)
// so the two can never disagree on where a delegate lives — a single rule, one place.
//
// The rule is intentionally strict: `api.dir` must be a safe app-relative directory. An absolute path
// or a `..` segment is REJECTED with a clear error rather than silently rewritten, because a silent
// rewrite would let `urban gen` scaffold into one directory while the runtime resolves delegates
// from another (drift), and a `..` segment could escape the app root when later joined.

/** The default directory operation delegates live in (mirrors the runtime's `api.dir` default). */
export const DEFAULT_OPERATIONS_DIR = "operations";

/**
 * Normalize an `api.dir` to a clean, app-relative directory segment (no leading/trailing slashes,
 * backslashes folded to `/`). An empty value falls back to {@link DEFAULT_OPERATIONS_DIR}.
 *
 * Throws if `dir` is absolute (POSIX `/…` or Windows `C:\…`/`\…`) or contains a `..` traversal
 * segment — both would let the generated controller's import paths or the scaffolder's write target
 * diverge from (or escape) the app root.
 */
export function normalizeApiDir(dir: string): string {
  const raw = dir.trim();
  if (raw.length === 0) return DEFAULT_OPERATIONS_DIR;

  if (isAbsolutePath(raw)) {
    throw new Error(`api.dir must be an app-relative directory, not an absolute path: ${dir}`);
  }

  const cleaned = raw.replace(/\\/g, "/").replace(/^\.?\/+/, "").replace(/\/+$/, "");
  if (cleaned.split("/").some((seg) => seg === "..")) {
    throw new Error(`api.dir must not contain ".." path segments: ${dir}`);
  }

  return cleaned.length > 0 ? cleaned : DEFAULT_OPERATIONS_DIR;
}

/** True for a POSIX absolute path (`/…`) or a Windows absolute/drive path (`C:\…`, `C:/…`, `\…`). */
function isAbsolutePath(path: string): boolean {
  return /^([/\\]|[A-Za-z]:[/\\])/.test(path);
}
