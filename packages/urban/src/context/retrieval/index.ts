// @nanobpm/urban/context/retrieval — slice S4 (retrieval over git).
//
// Read-side of the Urban context layer: query the git system-of-record that S3
// writes, using the exact path/namespace layout S3 publishes. MVP is git-only —
// NO external service:
//
//  1. STRUCTURED / PATH-SCOPED queries by scope/namespace, reading just one
//     layout partition when a query pins it (cheap, cold-cache friendly).
//  2. FRONTMATTER filtering on typed record fields (scope/mode/provenance/
//     authority/id/subject), ANDed clauses with OR-sets per field.
//  3. TEXT SEARCH across record bodies (case-insensitive substring).
//
// Git is the system of record; the hot read cache (DerivedRecordIndex) is a
// DISPOSABLE projection, rebuildable purely from git and never authoritative —
// retrieval is correct even with a cold/empty cache by falling back to the
// source. A future opt-in derived embedding index is left as a documented seam
// (see embedding.ts / EmbeddingIndex) and is NOT built here.

export {
  ContextRetriever,
  type ContextRetrieverOptions,
} from "./retriever.ts";

export { DerivedRecordIndex } from "./cache.ts";

export {
  GitRecordSource,
  type NamespaceSelector,
  type RecordSource,
  RecordSourceError,
  type ResolvedReadHandle,
  selectorSubtree,
  type StoredRecord,
} from "./source.ts";

export {
  compileQuery,
  type CompiledQuery,
  matchesQuery,
  type OneOrMany,
  type RetrievalQuery,
} from "./query.ts";

export {
  type EmbeddingIndex,
  type SemanticMatch,
} from "./embedding.ts";
