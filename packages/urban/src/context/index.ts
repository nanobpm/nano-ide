// @nanobpm/urban/context — the Urban context layer (epic #303).
//
// This is the SCAFFOLD-OWNED top barrel. It re-exports the public surface of
// each slice subdirectory so consumers can `import { … } from
// "@nanobpm/urban/context"`. Every slice owns exactly ONE subdirectory and
// replaces only its own `index.ts`; nobody but the scaffold task edits this
// file or packages/urban/package.json. See ./README.md for the seam contract.
//
// While the scaffold is empty every subdir barrel is `export {};`, so this
// aggregate typechecks and builds cleanly. Slice barrels are re-exported here
// as they land; the adversarial slice (S7) is test-only and is intentionally
// NOT part of the published surface.

export * from "./binding/index.ts";
export * from "./schema/index.ts";
export * from "./pii/index.ts";
export * from "./git/index.ts";
export * from "./retrieval/index.ts";
export * from "./conformance/index.ts";
