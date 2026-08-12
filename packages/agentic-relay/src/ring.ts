/**
 * The bounded replay ring — S5's resume-from-offset store for one relay stream.
 *
 * A live terminal stream is an append-only sequence of chunks. Each appended
 * chunk is assigned a monotonic, gap-free `offset` (starting at 0). The ring
 * retains only the most recent `capacity` chunks: older chunks are evicted so a
 * long-running stream cannot grow unbounded.
 *
 * Resume-from-offset (the load-bearing property): when a consumer reconnects it
 * asks for everything from the next offset it still needs. {@link ReplayRing.since}
 * returns exactly the retained tail from that offset, and flags a `gap` when the
 * requested offset predates what is still retained (i.e. the consumer was
 * disconnected long enough that some chunks were evicted before it could resume).
 * The stream itself survives the reconnect — the ring is the durable-enough
 * window that makes resume possible.
 */

/** A single retained chunk and the offset it was assigned. */
export interface ReplayEntry {
  readonly offset: number;
  readonly chunk: string;
}

export interface ReplayRingOptions {
  /** Maximum number of retained chunks. Must be a positive integer. */
  readonly capacity: number;
}

/** The result of a {@link ReplayRing.since} query. */
export interface ReplaySlice {
  /** The retained entries with `offset >= from`, in offset order. */
  readonly entries: readonly ReplayEntry[];
  /**
   * `true` when `from` predates the oldest retained offset: some chunks the
   * consumer asked for were already evicted, so the replay is not gap-free. The
   * consumer should treat the returned tail as a best-effort resume, not a
   * continuous stream from `from`.
   */
  readonly gap: boolean;
}

export class ReplayRing {
  readonly capacity: number;
  readonly #entries: ReplayEntry[] = [];
  #nextOffset = 0;

  constructor(options: ReplayRingOptions) {
    if (!Number.isInteger(options.capacity) || options.capacity < 1) {
      throw new RangeError(`ReplayRing capacity must be a positive integer, got ${options.capacity}`);
    }
    this.capacity = options.capacity;
  }

  /** Number of chunks currently retained. */
  get size(): number {
    return this.#entries.length;
  }

  /** The offset the next {@link append} will assign (also the total ever appended). */
  get nextOffset(): number {
    return this.#nextOffset;
  }

  /** The oldest retained offset, or `undefined` when nothing is retained. */
  get firstOffset(): number | undefined {
    return this.#entries[0]?.offset;
  }

  /**
   * Append a chunk, assigning it the next offset. When the ring is at capacity
   * the oldest retained chunk is evicted first (the offset counter still
   * advances, so offsets stay monotonic and gap-free across eviction).
   */
  append(chunk: string): ReplayEntry {
    const entry: ReplayEntry = { offset: this.#nextOffset, chunk };
    this.#nextOffset += 1;
    this.#entries.push(entry);
    if (this.#entries.length > this.capacity) {
      this.#entries.shift();
    }
    return entry;
  }

  /**
   * Return the retained tail from offset `from` (inclusive), for resume. `from`
   * is clamped to what is retained:
   *  - `from <= firstOffset` → the whole retained window; `gap` is `true` when
   *    `from` is strictly before the oldest retained offset (evicted chunks).
   *  - `firstOffset < from <= nextOffset` → the exact suffix from `from`; no gap.
   *  - `from > nextOffset` → empty (the consumer is ahead of the stream); no gap.
   */
  since(from: number): ReplaySlice {
    if (!Number.isInteger(from) || from < 0) {
      throw new RangeError(`since(from) requires a non-negative integer, got ${from}`);
    }
    const first = this.firstOffset;
    if (first === undefined || from >= this.#nextOffset) {
      // Nothing retained, or the consumer already has everything.
      return { entries: [], gap: first !== undefined && from < first };
    }
    const gap = from < first;
    const startOffset = gap ? first : from;
    const startIndex = startOffset - first;
    return { entries: this.#entries.slice(startIndex), gap };
  }

  /** Drop every retained chunk. The offset counter is NOT reset (offsets stay monotonic). */
  clear(): void {
    this.#entries.length = 0;
  }
}
