// Slice S4 (retrieval) — SEAM ONLY for a future opt-in derived embedding index.
//
// The MVP retrieval is git-only: structured/path-scoped queries, frontmatter
// filtering, and substring text search over the git system-of-record, with a
// disposable hot cache. Semantic (vector) retrieval — an OpenMemory / mem0-style
// derived embedding index — is deliberately NOT built here. This file only
// declares the seam it would plug into, so a later slice can add it without
// reshaping the retriever or its public API.
//
// Like the hot cache, any such embedding index MUST be DERIVED and disposable:
// rebuildable purely from git, never authoritative. Nothing in this file
// performs embedding, network I/O, or persistence — it is a type contract.

import type { RetrievalQuery } from "./query.ts";
import type { StoredRecord } from "./source.ts";

/** A semantic match: a stored record plus the backend's similarity score. */
export interface SemanticMatch {
  readonly stored: StoredRecord;
  /** Backend-defined similarity score; higher is more similar. */
  readonly score: number;
}

/**
 * The seam a future opt-in embedding index would implement. A retriever could
 * accept one and offer `semanticQuery`, but the MVP neither ships nor requires
 * an implementation — retrieval is fully correct git-only without it.
 *
 * Implementations must treat the embedding store as a derived projection of git:
 * {@link reindex} rebuilds it from the authoritative records, and a cold/missing
 * embedding index must degrade to the git-backed lexical path, never to wrong
 * or stale results.
 */
export interface EmbeddingIndex {
  /** (Re)build the derived vector index from the authoritative git records. */
  reindex(records: readonly StoredRecord[]): Promise<void>;
  /**
   * Return the semantically nearest records to `query.text`, honouring the
   * structured/frontmatter clauses of `query` as pre/post filters.
   */
  semanticSearch(
    query: RetrievalQuery,
    k: number,
  ): Promise<readonly SemanticMatch[]>;
}
