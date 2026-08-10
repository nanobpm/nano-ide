// Resolve a module path that may have been authored WITHOUT a file extension.
//
// The OpenAPI delegate surface (ADR 0058) builds a delegate import path from `<dir>/<operationId>`
// — and an `operationId` cannot carry a file extension (it must be a single safe path segment, and
// it doubles as a TS type stem). Node's ESM resolver (including `--experimental-strip-types`) and
// Deno both require an explicit extension for a file: URL, so a bare `import(".../operations/getX")`
// fails with a "cannot find module" error even though `.../operations/getX.ts` exists. `actions[]`
// don't hit this because the manifest carries the extension (`"module": "actions/x.ts"`).
//
// This mirrors the connector-SDK shim resolution (`connectorShimUrl` in adapters/node.ts): probe
// the on-disk candidates, PREFERRING a compiled `.js` (the published / `urban run` path, importable
// on plain Node without TypeScript type-stripping) over the from-source `.ts` (node strip-types /
// Deno), so both resolve the same author-written `<dir>/<operationId>` path. Preferring compiled
// first matters in a mixed source+build tree: if both exist and the process has no type-stripping,
// selecting `.ts` would fail even though `.js` was importable.

/**
 * Candidate extensions tried, in order, for an extensionless module path. Compiled outputs come
 * first (matching the connector-SDK precedent) so a mixed source+build tree resolves to the
 * importable `.js` rather than a `.ts` that fails on a runtime without type-stripping; a
 * from-source tree (only `.ts` present) falls through to `.ts`.
 */
export const MODULE_EXTENSION_CANDIDATES = [".js", ".mjs", ".cjs", ".ts"] as const;

/** True when the path already ends in a JS/TS module extension (.ts/.js/.mjs/.cjs). */
function hasModuleExtension(path: string): boolean {
  return /\.[cm]?[jt]s$/i.test(path);
}

/**
 * If `path` already has a JS/TS extension, return it unchanged. Otherwise return the first
 * `${path}${ext}` (ext ∈ {@link MODULE_EXTENSION_CANDIDATES}) that `exists`, so an extensionless
 * delegate path resolves to its real source/compiled file. When none exists, return `path`
 * unchanged so the underlying loader surfaces its own (accurate) "module not found" error rather
 * than a guessed extension masking it.
 */
export function resolveModulePath(path: string, exists: (candidate: string) => boolean): string {
  if (hasModuleExtension(path)) return path;
  for (const ext of MODULE_EXTENSION_CANDIDATES) {
    if (exists(path + ext)) return path + ext;
  }
  return path;
}
