// Slice S4 (retrieval) — the DERIVED hot read cache/index.
//
// Git is the system of record; this index is a disposable, rebuildable-from-git
// projection kept hot for fast repeated reads. It is NEVER authoritative:
//   - a cold (never-built) index transparently reads through to the source on
//     first use, so retrieval is correct even before any rebuild;
//   - `invalidate()` drops the projection so the next read re-reads from git;
//   - `rebuild()` re-reads the whole store eagerly.
// Because it holds nothing git does not, throwing it away can never lose data.

import type { NamespaceSelector, RecordSource, StoredRecord } from "./source.ts";

/**
 * A derived, in-memory index over a {@link RecordSource}. Holds a full snapshot
 * of the store once warmed; cold reads and namespace-scoped reads fall back to
 * the source directly so a cold/empty index is always correct.
 */
export class DerivedRecordIndex {
  readonly #source: RecordSource;
  // `undefined` == cold (never loaded / invalidated). An empty array is a valid
  // WARM state (a store that genuinely has no records), distinct from cold.
  #snapshot: readonly StoredRecord[] | undefined;

  constructor(source: RecordSource) {
    this.#source = source;
  }

  /** `true` once a full snapshot is loaded; `false` when cold/invalidated. */
  get isWarm(): boolean {
    return this.#snapshot !== undefined;
  }

  /** The read source this index is derived from (git, by default). */
  get source(): RecordSource {
    return this.#source;
  }

  /**
   * Eagerly (re)load the full store snapshot from the source, replacing any
   * existing projection. Cheap to call and idempotent — the whole point is that
   * rebuilding is always safe because git remains the source of truth.
   */
  async rebuild(): Promise<readonly StoredRecord[]> {
    const snapshot = await this.#source.list();
    this.#snapshot = snapshot;
    return snapshot;
  }

  /** Drop the projection so the next read re-reads from git. */
  invalidate(): void {
    this.#snapshot = undefined;
  }

  /**
   * Return the full store, warming the index on a cold read. After this the
   * index is warm; subsequent calls serve the cached snapshot without touching
   * the filesystem until {@link invalidate} or {@link rebuild} is called.
   */
  async all(): Promise<readonly StoredRecord[]> {
    if (this.#snapshot !== undefined) {
      return this.#snapshot;
    }
    return this.rebuild();
  }

  /**
   * Return the records in one namespace partition. When the index is already
   * warm this filters the in-memory snapshot (no I/O); when cold it does a
   * cheap, path-scoped read of JUST that partition from the source WITHOUT
   * warming the whole index — so a targeted query never pays to load the store.
   */
  async namespace(
    selector: NamespaceSelector,
  ): Promise<readonly StoredRecord[]> {
    if (this.#snapshot !== undefined) {
      return this.#snapshot.filter((stored) =>
        inNamespace(stored, selector),
      );
    }
    return this.#source.list(selector);
  }
}

/** `true` iff a stored record belongs to the given namespace partition. */
function inNamespace(
  stored: StoredRecord,
  selector: NamespaceSelector,
): boolean {
  if (stored.record.scope !== selector.scope) {
    return false;
  }
  return (
    selector.scopeRef === undefined || stored.record.scopeRef === selector.scopeRef
  );
}
