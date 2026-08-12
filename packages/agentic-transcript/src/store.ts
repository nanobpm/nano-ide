/**
 * The transcript store — S6's retention-by-lifecycle durable layer over the app
 * DataLayer.
 *
 * The S5 relay ({@link https://npmjs.com/package/@nanobpm/agentic-relay | ReplayRing})
 * keeps a *bounded* in-memory resume window per live stream. S6 layers a *durable*
 * transcript on top, with retention differentiated by the stream's lifecycle:
 *
 *  - **ephemeral** — a short run (e.g. one job). Its ring is flushed to a durable
 *    transcript on job completion ({@link TranscriptStore.flush}); the completed
 *    transcript is readable ({@link TranscriptStore.read}) and ages out only on an
 *    explicit retention sweep ({@link TranscriptStore.sweep}) — never while a
 *    consumer might still fetch it.
 *  - **long-lived** — a durable stream that outlives any single ring. Chunks are
 *    recorded incrementally ({@link TranscriptStore.record}); a reconnecting
 *    consumer reattaches from an offset ({@link TranscriptStore.since}); a rolling
 *    retention window is applied by {@link TranscriptStore.truncateBefore}, after
 *    which a reattach before the truncation point reports a `gap` (exactly the S5
 *    ring's resume-from-offset contract, now over durable storage).
 *
 * The store speaks only the tiny synchronous SQLite subset the runtime exposes
 * ({@link SqliteDb}), so it works against any app DataLayer source without pulling
 * in the whole runtime.
 */
import { TRANSCRIPT_CHUNK_TABLE, TRANSCRIPT_SCHEMA_SQL, TRANSCRIPT_STREAM_TABLE } from "./schema.ts";

/**
 * The minimal synchronous SQLite handle the store needs — structurally the same
 * surface the Urban runtime's DataLayer exposes (`host.openSqlite`). Kept local
 * so the store depends on a shape, not on the runtime package. (Identical to the
 * S2 presence store's `SqliteDb`.)
 */
export interface SqliteDb {
  /** Execute one or more statements with no result (DDL, migrations). */
  exec(sql: string): void;
  /** Run a parameterised statement, returning the changed-row count. */
  run(sql: string, params?: unknown[]): { changes: number; lastInsertRowid: number | bigint };
  /** Run a parameterised query, returning all rows as plain objects. */
  all<T = Record<string, unknown>>(sql: string, params?: unknown[]): T[];
}

/** A monotonic wall clock, injectable for deterministic tests. */
export interface Clock {
  now(): number;
}

/** The default clock: `Date.now()`. */
export const systemClock: Clock = { now: () => Date.now() };

/**
 * A stream's retention lifecycle. `ephemeral` transcripts are flushed once on job
 * completion and retained until a retention sweep; `long-lived` transcripts grow
 * incrementally and are bounded by a rolling offset window.
 */
export type TranscriptLifecycle = "ephemeral" | "long-lived";

/** A stream's transcript status. */
export type TranscriptStatus = "open" | "completed";

/** A single durable transcript chunk and the offset it was assigned. */
export interface TranscriptChunk {
  readonly offset: number;
  readonly chunk: string;
}

/** Per-stream transcript metadata. */
export interface TranscriptStream {
  readonly stream: string;
  readonly lifecycle: TranscriptLifecycle;
  readonly status: TranscriptStatus;
  /** When the stream was first opened, ISO-8601. */
  readonly createdAt: string;
  /** When an ephemeral run was flushed & completed, ISO-8601 (undefined while open). */
  readonly completedAt?: string;
  /** The oldest retained offset, or undefined when the transcript is empty. */
  readonly firstOffset?: number;
  /** One past the highest offset ever recorded (the resume high-water mark). */
  readonly nextOffset: number;
}

/**
 * The result of a {@link TranscriptStore.since} reattach query — the same shape
 * the S5 {@link ReplayRing.since} returns, now served from durable storage.
 */
export interface TranscriptSlice {
  /** The retained chunks with `offset >= from`, in offset order. */
  readonly entries: readonly TranscriptChunk[];
  /**
   * `true` when `from` predates the oldest retained offset: chunks the consumer
   * asked for were already dropped by retention (rolling window / expiry), so the
   * replay is a best-effort resume, not gap-free from `from`.
   */
  readonly gap: boolean;
  /** One past the highest recorded offset (where the live stream continues). */
  readonly nextOffset: number;
}

/**
 * The minimal resume-from-offset source a {@link TranscriptStore.flush} reads.
 * The S5 {@link ReplayRing} satisfies this structurally (`since(0).entries` is the
 * whole retained window; `nextOffset` is its high-water mark), so the store can
 * flush a real relay ring without a compile dependency on the relay package.
 */
export interface TranscriptRing {
  since(from: number): { readonly entries: readonly TranscriptChunk[] };
  readonly nextOffset: number;
}

export interface TranscriptStoreOptions {
  /**
   * How long a *completed ephemeral* transcript is retained after its
   * `completed_at` before {@link TranscriptStore.sweep} may drop it, in ms.
   * Default 86_400_000 (24h). Long-lived streams are never time-swept.
   */
  ephemeralRetentionMs?: number;
  /** Injectable clock for deterministic tests. Default {@link systemClock}. */
  clock?: Clock;
}

const DEFAULT_EPHEMERAL_RETENTION_MS = 86_400_000;

function isNonNegInt(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/**
 * A recordable offset must be a non-negative safe integer that still leaves room
 * for its successor: `#refreshWindow` derives `next_offset = maxOffset + 1`, so an
 * offset of `Number.MAX_SAFE_INTEGER` would make `next_offset` a non-safe integer
 * and break the resume contract (`since()` rejects non-safe integers). Cap one
 * below the safe-integer ceiling.
 */
function isRecordableOffset(value: unknown): value is number {
  return isNonNegInt(value) && value < Number.MAX_SAFE_INTEGER;
}

/** The raw stream metadata row shape (snake_case columns) as read from SQLite. */
interface DbStreamRow {
  stream: string;
  lifecycle: string;
  status: string;
  created_at: string;
  completed_at: string | null;
  first_offset: number | null;
  next_offset: number;
}

/** The raw chunk row shape as read from SQLite. */
interface DbChunkRow {
  chunk_offset: number;
  chunk: string;
}

function toLifecycle(value: string): TranscriptLifecycle {
  if (value === "ephemeral" || value === "long-lived") return value;
  throw new TranscriptCorruptionError(`invalid transcript lifecycle in DB: ${JSON.stringify(value)}`);
}

function toStatus(value: string): TranscriptStatus {
  if (value === "open" || value === "completed") return value;
  throw new TranscriptCorruptionError(`invalid transcript status in DB: ${JSON.stringify(value)}`);
}

function toStream(row: DbStreamRow): TranscriptStream {
  const out: {
    stream: string;
    lifecycle: TranscriptLifecycle;
    status: TranscriptStatus;
    createdAt: string;
    completedAt?: string;
    firstOffset?: number;
    nextOffset: number;
  } = {
    stream: row.stream,
    lifecycle: toLifecycle(row.lifecycle),
    status: toStatus(row.status),
    createdAt: row.created_at,
    nextOffset: row.next_offset,
  };
  if (row.completed_at !== null) out.completedAt = row.completed_at;
  if (row.first_offset !== null) out.firstOffset = row.first_offset;
  return out;
}

/**
 * Raised when a transcript row read back from storage holds a value outside its
 * domain (e.g. an unknown `lifecycle`/`status`), signalling schema corruption or a
 * bad manual write. Fail fast rather than silently coercing to a default, which
 * would mask the corruption and skew retention decisions.
 */
export class TranscriptCorruptionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TranscriptCorruptionError";
  }
}

/**
 * Raised when an operation targets a lifecycle it does not apply to (e.g.
 * completing a `long-lived` stream, which by definition never completes).
 */
export class TranscriptLifecycleError extends Error {
  readonly stream: string;
  constructor(stream: string, message: string) {
    super(message);
    this.name = "TranscriptLifecycleError";
    this.stream = stream;
  }
}

export class TranscriptStore {
  readonly #db: SqliteDb;
  readonly #ephemeralRetentionMs: number;
  readonly #clock: Clock;

  constructor(db: SqliteDb, options: TranscriptStoreOptions = {}) {
    this.#db = db;
    this.#ephemeralRetentionMs = options.ephemeralRetentionMs ?? DEFAULT_EPHEMERAL_RETENTION_MS;
    this.#clock = options.clock ?? systemClock;
  }

  /** The completed-ephemeral retention window in ms. */
  get ephemeralRetentionMs(): number {
    return this.#ephemeralRetentionMs;
  }

  /**
   * Apply the canonical transcript DDL (idempotent). Callers that let the app
   * DataLayer migration runner apply `db/migrations/002_agentic_transcript.sql`
   * do not need this — but it is provided so the store is usable against a bare
   * source too. The DDL is identical to the migration (drift-guarded).
   */
  ensureSchema(): void {
    this.#db.exec(TRANSCRIPT_SCHEMA_SQL);
  }

  /**
   * Open (or fetch) a stream's transcript with the given lifecycle. Idempotent:
   * a first call stamps `created_at` and the lifecycle; later calls return the
   * existing row unchanged (lifecycle is first-wins and never mutates). Returns
   * the stored metadata row.
   */
  open(stream: string, lifecycle: TranscriptLifecycle): TranscriptStream {
    this.#db.run(
      `INSERT INTO ${TRANSCRIPT_STREAM_TABLE} (stream, lifecycle, status, created_at, next_offset)
       VALUES (?, ?, 'open', ?, 0)
       ON CONFLICT(stream) DO NOTHING`,
      [stream, lifecycle, new Date(this.#clock.now()).toISOString()],
    );
    const row = this.get(stream);
    if (row === undefined) {
      throw new Error(`transcript stream row vanished immediately after open: ${stream}`);
    }
    return row;
  }

  /**
   * Record chunks into a stream's durable transcript, idempotently. Each chunk is
   * keyed `(stream, offset)`, so re-recording an already-stored offset (a retry, a
   * re-flush, an overlapping reattach) is a no-op — never a duplicate. Auto-opens
   * the stream with `lifecycle` (default `long-lived`) if it is not open yet; if the
   * stream already exists under a different lifecycle this throws a
   * {@link TranscriptLifecycleError} before writing anything (lifecycle is
   * first-wins), so a mismatched flush cannot leave a partial write.
   * Returns the number of newly-persisted chunks.
   *
   * This is the incremental path a long-lived stream uses; {@link flush} builds on
   * it for the ephemeral completion path.
   */
  record(
    stream: string,
    entries: Iterable<TranscriptChunk>,
    lifecycle: TranscriptLifecycle = "long-lived",
  ): number {
    const meta = this.open(stream, lifecycle);
    if (meta.lifecycle !== lifecycle) {
      throw new TranscriptLifecycleError(
        stream,
        `refusing to record into "${stream}" with lifecycle=${lifecycle}; the stream is ${meta.lifecycle} (lifecycle is first-wins)`,
      );
    }
    const at = new Date(this.#clock.now()).toISOString();
    let written = 0;
    for (const entry of entries) {
      if (!isRecordableOffset(entry.offset)) {
        throw new RangeError(
          `transcript offset must be a non-negative safe integer below Number.MAX_SAFE_INTEGER, got ${entry.offset}`,
        );
      }
      const { changes } = this.#db.run(
        `INSERT INTO ${TRANSCRIPT_CHUNK_TABLE} (stream, chunk_offset, chunk, appended_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(stream, chunk_offset) DO NOTHING`,
        [stream, entry.offset, entry.chunk, at],
      );
      written += changes;
    }
    this.#refreshWindow(stream);
    return written;
  }

  /**
   * Flush a resume-from-offset source (an S5 {@link ReplayRing}) into a stream's
   * durable transcript. Persists the source's entire retained window
   * (`source.since(0)`) idempotently and advances the stream's high-water mark to
   * `source.nextOffset` (so the recorded `nextOffset` reflects everything ever
   * produced, even chunks the ring already evicted). Returns the number of
   * newly-persisted chunks.
   *
   * For an `ephemeral` stream this is the job-completion flush: it also marks the
   * transcript `completed` (stamping `completed_at`), after which {@link read}
   * yields the durable transcript and {@link sweep} may later retire it. For a
   * `long-lived` stream it is a snapshot checkpoint that leaves the stream `open`.
   */
  flush(stream: string, source: TranscriptRing, lifecycle: TranscriptLifecycle): number {
    const written = this.record(stream, source.since(0).entries, lifecycle);
    // Advance the high-water mark to the source's nextOffset. The ring may have
    // evicted early chunks, so its nextOffset can exceed maxStoredOffset+1; the
    // recorded next_offset must reflect the true stream length for a later
    // reattach's gap accounting to be correct.
    if (isNonNegInt(source.nextOffset)) {
      this.#raiseNextOffset(stream, source.nextOffset);
    }
    if (lifecycle === "ephemeral") {
      this.#complete(stream);
    }
    return written;
  }

  /**
   * Reattach a consumer from offset `from` (inclusive). Returns the retained
   * chunks with `offset >= from`, the live `nextOffset`, and a `gap` flag when
   * `from` predates the oldest retained offset (retention dropped chunks the
   * consumer wanted). Mirrors the S5 {@link ReplayRing.since} contract exactly,
   * so a reattach behaves identically whether it resumes from the live ring or
   * the durable transcript.
   */
  since(stream: string, from: number): TranscriptSlice {
    if (!isNonNegInt(from)) {
      throw new RangeError(`since(from) requires a non-negative safe integer, got ${from}`);
    }
    const meta = this.get(stream);
    if (meta === undefined) {
      return { entries: [], gap: false, nextOffset: 0 };
    }
    const entries = this.#db
      .all<DbChunkRow>(
        `SELECT chunk_offset, chunk FROM ${TRANSCRIPT_CHUNK_TABLE}
         WHERE stream = ? AND chunk_offset >= ? ORDER BY chunk_offset`,
        [stream, from],
      )
      .map((r): TranscriptChunk => ({ offset: r.chunk_offset, chunk: r.chunk }));
    // A gap means the consumer asked for an offset older than anything retained.
    // Only meaningful while chunks remain: with an empty (fully-swept or freshly
    // opened) transcript there is nothing to have "lost", so gap is false.
    const gap = meta.firstOffset !== undefined && from < meta.firstOffset;
    return { entries, gap, nextOffset: meta.nextOffset };
  }

  /** Read a stream's whole durable transcript in offset order. */
  read(stream: string): TranscriptChunk[] {
    return this.#db
      .all<DbChunkRow>(
        `SELECT chunk_offset, chunk FROM ${TRANSCRIPT_CHUNK_TABLE} WHERE stream = ? ORDER BY chunk_offset`,
        [stream],
      )
      .map((r): TranscriptChunk => ({ offset: r.chunk_offset, chunk: r.chunk }));
  }

  /**
   * Apply a rolling retention window to a long-lived stream: drop every chunk with
   * `offset < before`. A subsequent {@link since} from an offset older than
   * `before` reports a `gap`. Returns the number of chunks dropped. Refuses to
   * truncate an `ephemeral` transcript (those are retained whole until swept) with
   * a {@link TranscriptLifecycleError}.
   */
  truncateBefore(stream: string, before: number): number {
    if (!isNonNegInt(before)) {
      throw new RangeError(`truncateBefore(before) requires a non-negative safe integer, got ${before}`);
    }
    const meta = this.get(stream);
    if (meta === undefined) return 0;
    if (meta.lifecycle === "ephemeral") {
      throw new TranscriptLifecycleError(
        stream,
        `refusing to truncate ephemeral transcript "${stream}"; ephemeral runs are retained whole until sweep()`,
      );
    }
    const { changes } = this.#db.run(
      `DELETE FROM ${TRANSCRIPT_CHUNK_TABLE} WHERE stream = ? AND chunk_offset < ?`,
      [stream, before],
    );
    if (changes > 0) this.#refreshWindow(stream);
    return changes;
  }

  /**
   * Retention sweep for completed ephemeral transcripts: drop every stream whose
   * `status = 'completed'` and whose `completed_at` is older than the retention
   * window, along with its chunks. Long-lived streams are never time-swept (they
   * are bounded by {@link truncateBefore} instead). Returns the removed stream ids.
   */
  sweep(now: number = this.#clock.now()): string[] {
    const cutoffIso = new Date(now - this.#ephemeralRetentionMs).toISOString();
    const removed = this.#db
      .all<{ stream: string }>(
        `SELECT stream FROM ${TRANSCRIPT_STREAM_TABLE}
         WHERE lifecycle = 'ephemeral' AND status = 'completed'
           AND completed_at IS NOT NULL AND completed_at < ?`,
        [cutoffIso],
      )
      .map((r) => r.stream);
    for (const stream of removed) {
      this.#db.run(`DELETE FROM ${TRANSCRIPT_CHUNK_TABLE} WHERE stream = ?`, [stream]);
      this.#db.run(`DELETE FROM ${TRANSCRIPT_STREAM_TABLE} WHERE stream = ?`, [stream]);
    }
    return removed;
  }

  /** Look up a single stream's transcript metadata. */
  get(stream: string): TranscriptStream | undefined {
    const rows = this.#db.all<DbStreamRow>(
      `SELECT * FROM ${TRANSCRIPT_STREAM_TABLE} WHERE stream = ?`,
      [stream],
    );
    const row = rows[0];
    return row === undefined ? undefined : toStream(row);
  }

  /** Every stream's metadata, ordered by first open then stream id. */
  list(): TranscriptStream[] {
    return this.#db
      .all<DbStreamRow>(`SELECT * FROM ${TRANSCRIPT_STREAM_TABLE} ORDER BY created_at, stream`)
      .map(toStream);
  }

  /** Number of tracked streams. */
  count(): number {
    const rows = this.#db.all<{ n: number }>(`SELECT COUNT(*) AS n FROM ${TRANSCRIPT_STREAM_TABLE}`);
    return rows[0]?.n ?? 0;
  }

  /** Mark an ephemeral stream completed (idempotent), stamping `completed_at`. */
  #complete(stream: string): void {
    const meta = this.get(stream);
    if (meta === undefined) return;
    if (meta.lifecycle !== "ephemeral") {
      throw new TranscriptLifecycleError(
        stream,
        `refusing to complete non-ephemeral transcript "${stream}" (lifecycle=${meta.lifecycle})`,
      );
    }
    if (meta.status === "completed") return;
    this.#db.run(
      `UPDATE ${TRANSCRIPT_STREAM_TABLE} SET status = 'completed', completed_at = ? WHERE stream = ?`,
      [new Date(this.#clock.now()).toISOString(), stream],
    );
  }

  /**
   * Recompute a stream's retained offset window (`first_offset`, and `next_offset`
   * raised to `max(chunk_offset)+1`) from the chunks actually stored. `next_offset`
   * is monotonic — it is never lowered below its recorded high-water mark, so a
   * truncation that drops the tail (there is none — truncation drops the head) or
   * a re-record cannot rewind the resume point.
   */
  #refreshWindow(stream: string): void {
    const agg = this.#db.all<{ mn: number | null; mx: number | null }>(
      `SELECT MIN(chunk_offset) AS mn, MAX(chunk_offset) AS mx FROM ${TRANSCRIPT_CHUNK_TABLE} WHERE stream = ?`,
      [stream],
    )[0];
    const minOffset = agg?.mn ?? null;
    const maxOffset = agg?.mx ?? null;
    const candidateNext = maxOffset === null ? 0 : maxOffset + 1;
    this.#db.run(
      `UPDATE ${TRANSCRIPT_STREAM_TABLE}
       SET first_offset = ?, next_offset = MAX(next_offset, ?)
       WHERE stream = ?`,
      [minOffset, candidateNext, stream],
    );
  }

  /** Raise a stream's `next_offset` high-water mark (never lowers it). */
  #raiseNextOffset(stream: string, nextOffset: number): void {
    this.#db.run(
      `UPDATE ${TRANSCRIPT_STREAM_TABLE} SET next_offset = MAX(next_offset, ?) WHERE stream = ?`,
      [nextOffset, stream],
    );
  }
}
