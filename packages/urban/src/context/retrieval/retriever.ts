// Slice S4 (retrieval) — the public retriever over the git system-of-record.
//
// `ContextRetriever` composes the three pieces of this slice into one API:
//   - a RecordSource (git read seam, default GitRecordSource over a resolved
//     substrate working copy),
//   - a DerivedRecordIndex (disposable hot cache, rebuildable from git),
//   - the pure query model (path-scoped + frontmatter + text search).
//
// Correctness does not depend on the cache: every query works from a cold/empty
// index by reading through to git, and a query narrowed to one namespace reads
// only that partition (a cheap, path-scoped read) without warming the whole
// index. Callers keep the cache honest by calling `invalidate()` after a write
// (git remains the source of truth); nothing here silently serves stale data
// beyond what the caller has chosen to keep warm.

import { DerivedRecordIndex } from "./cache.ts";
import type { EmbeddingIndex } from "./embedding.ts";
import {
  compileQuery,
  type CompiledQuery,
  matchesQuery,
  type RetrievalQuery,
} from "./query.ts";
import {
  GitRecordSource,
  type NamespaceSelector,
  type RecordSource,
  type ResolvedReadHandle,
  type StoredRecord,
} from "./source.ts";

/** Options for {@link ContextRetriever}. All optional; the defaults are safe. */
export interface ContextRetrieverOptions {
  /**
   * Override the read source (seam for a future mutable/PII backend). Defaults
   * to a {@link GitRecordSource} over the resolved handle's working copy.
   */
  readonly source?: RecordSource;
  /**
   * A future opt-in derived embedding index. Purely a forward-compat seam — the
   * MVP does not build or require one, and no method here depends on it.
   */
  readonly embeddingIndex?: EmbeddingIndex;
}

/**
 * Retrieval over the git-backed context store. Bind one to a resolved substrate
 * handle (the local checkout S1 produces) and query it; the derived hot cache is
 * built lazily and can be invalidated/rebuilt at will.
 */
export class ContextRetriever {
  readonly #source: RecordSource;
  readonly #index: DerivedRecordIndex;
  readonly #embeddingIndex?: EmbeddingIndex;

  constructor(
    handle: ResolvedReadHandle | string,
    options: ContextRetrieverOptions = {},
  ) {
    this.#source = options.source ?? new GitRecordSource(handle);
    this.#index = new DerivedRecordIndex(this.#source);
    this.#embeddingIndex = options.embeddingIndex;
  }

  /** The derived hot cache (for explicit warm/invalidate/rebuild control). */
  get cache(): DerivedRecordIndex {
    return this.#index;
  }

  /** The read source this retriever reads git through. */
  get source(): RecordSource {
    return this.#source;
  }

  /**
   * A future opt-in embedding index, if one was supplied. `undefined` in the
   * MVP — retrieval is fully functional without it.
   */
  get embeddingIndex(): EmbeddingIndex | undefined {
    return this.#embeddingIndex;
  }

  /**
   * Run a retrieval query. Structured/path-scoped clauses (`scope` + a single
   * `scopeRef`) narrow the read to one layout partition when the cache is cold,
   * so a targeted query is cheap and never forces a full index build; otherwise
   * the frontmatter + text clauses filter the candidate set in memory. Results
   * are ordered by layout path for determinism and capped by `limit`.
   */
  async query(query: RetrievalQuery = {}): Promise<readonly StoredRecord[]> {
    const compiled = compileQuery(query);
    const candidates = await this.#candidates(compiled);
    const matched = candidates.filter((stored) =>
      matchesQuery(stored.record, compiled),
    );
    return applyLimit(matched, compiled);
  }

  /**
   * Path-scoped structured query: every record in one namespace partition
   * (`scope` + optional `scopeRef`), read cheaply from just that subtree when
   * the cache is cold. Equivalent to `query({ scope, scopeRef })` but expresses
   * the S3-partition intent directly.
   */
  async byNamespace(
    scope: NamespaceSelector["scope"],
    scopeRef?: string,
  ): Promise<readonly StoredRecord[]> {
    return this.#index.namespace({ scope, scopeRef });
  }

  /**
   * Free-text search across record bodies, optionally combined with structured
   * frontmatter filters. Convenience over {@link query} for the common case.
   */
  async search(
    text: string,
    filters: Omit<RetrievalQuery, "text"> = {},
  ): Promise<readonly StoredRecord[]> {
    return this.query({ ...filters, text });
  }

  /** Every record in the store, warming the cache. */
  async all(): Promise<readonly StoredRecord[]> {
    return this.#index.all();
  }

  /** Read a single record by its S3 layout path (bypasses the cache). */
  async get(relPath: string): Promise<StoredRecord | undefined> {
    return this.#source.read(relPath);
  }

  /** Drop the derived cache so the next query re-reads from git. */
  invalidate(): void {
    this.#index.invalidate();
  }

  /** Eagerly rebuild the derived cache from git. */
  async rebuild(): Promise<readonly StoredRecord[]> {
    return this.#index.rebuild();
  }

  /**
   * The candidate set to filter: when a query pins exactly one namespace
   * partition we read only that partition (cheap path-scoped read, cold-cache
   * friendly); otherwise we read the whole (cached) store.
   */
  async #candidates(query: CompiledQuery): Promise<readonly StoredRecord[]> {
    const selector = singleNamespace(query);
    if (selector !== undefined) {
      return this.#index.namespace(selector);
    }
    return this.#index.all();
  }
}

/**
 * If a compiled query pins exactly ONE scope (and at most one scopeRef), return
 * the namespace partition it lives in so retrieval can read just that subtree.
 * Returns `undefined` when the query spans multiple scopes/refs (or none), in
 * which case the whole store is the candidate set.
 */
function singleNamespace(query: CompiledQuery): NamespaceSelector | undefined {
  const scope = onlyMember(query.scope);
  if (scope === undefined) {
    return undefined;
  }
  const scopeRef = onlyMember(query.scopeRef);
  return { scope, ...(scopeRef === undefined ? {} : { scopeRef }) };
}

/** The sole member of a set of exactly one element, else `undefined`. */
function onlyMember<T>(set: ReadonlySet<T> | undefined): T | undefined {
  if (set === undefined || set.size !== 1) {
    return undefined;
  }
  for (const value of set) {
    return value;
  }
  return undefined;
}

function applyLimit(
  records: readonly StoredRecord[],
  query: CompiledQuery,
): readonly StoredRecord[] {
  if (query.limit === undefined || query.limit < 0) {
    return records;
  }
  return records.slice(0, query.limit);
}
