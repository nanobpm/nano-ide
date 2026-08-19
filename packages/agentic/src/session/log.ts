/**
 * The authoritative session-log store — ADR 0062, slice 1.
 *
 * This **promotes** the advisory relay substrate (ADR 0056 §12: the bounded
 * replay ring's resume-from-offset, plus generation/incarnation fencing) into an
 * *authoritative* per-activation log. Two things change on promotion:
 *
 *  - **Unbounded, durable retention.** The relay ring is a bounded in-memory
 *    resume window that evicts; the authoritative log retains every event of an
 *    activation (lifecycle-bounded like the S6 transcript, swept only when the
 *    activation is retired), so `restore` can always replay from offset 0.
 *  - **Durable fencing.** The relay {@link IncarnationFence} (which this module
 *    reuses verbatim for the in-memory backend) lives in memory; the SQLite
 *    backend persists the same high-water mark in the activation row's
 *    `incarnation` column, so a stale writer is fenced even across a restart.
 *
 * Transport is never re-implemented — this is a storage layer over the app
 * DataLayer (or memory), exactly as the transcript store is. Nothing here rides
 * the Camunda-8 engine (ADR 0056 boundary preserved).
 */
import { IncarnationFence } from "../relay/incarnation.ts";
import {
  type ActivationKey,
  activationKeyString,
  type SessionCheckpoint,
  StaleIncarnationError,
} from "./adapter.ts";
import { type AppendedSessionEvent, parseSessionEvent, type SessionEvent } from "./events.ts";
import {
  SESSION_CHECKPOINT_TABLE,
  SESSION_EVENT_TABLE,
  SESSION_LOG_TABLE,
  SESSION_SCHEMA_SQL,
} from "./schema.ts";

/**
 * The authoritative-log port the {@link SessionBackend} adapter writes through.
 * Two backends implement it: {@link InMemorySessionLog} (the reference/stub) and
 * {@link SqliteSessionLog} (durable, over the app DataLayer). All writes are
 * fenced by `incarnation`; a stale writer throws {@link StaleIncarnationError}.
 */
export interface SessionLog {
  /**
   * Take (or renew) the lease for `key` at `incarnation`, advancing the fence
   * high-water mark. Throws {@link StaleIncarnationError} if a newer incarnation
   * already owns the activation. Called once when an adapter is constructed so a
   * re-lease fences prior incarnations immediately, before any write.
   */
  lease(key: ActivationKey, incarnation: number): void;

  /** The current (highest leased) incarnation for `key`, or `undefined`. */
  currentIncarnation(key: ActivationKey): number | undefined;

  /** The offset the next appended event will occupy (also the event count). */
  nextOffset(key: ActivationKey): number;

  /**
   * Append `event` at `offset` under `incarnation`, returning it stamped as an
   * {@link AppendedSessionEvent}. Fenced. `offset` must be `<= nextOffset`: at
   * `nextOffset` it extends the log; below it (a resume writing back into the log
   * after `restore`) it first drops the now-superseded uncommitted tail
   * `[offset, nextOffset)` — **and every checkpoint pinned above `offset`**, which
   * would otherwise dangle past the rewritten head and mis-seed a later `restore`
   * (a gap `RangeError` on the next `emit`) — and then writes: an idempotent
   * re-key that keeps the authoritative log gap-free. An `offset > nextOffset` is
   * a gap and throws.
   */
  append(
    key: ActivationKey,
    incarnation: number,
    offset: number,
    event: SessionEvent,
  ): AppendedSessionEvent;

  /** Persist a checkpoint (fenced by `incarnation`). Returns it unchanged. */
  putCheckpoint(key: ActivationKey, incarnation: number, checkpoint: SessionCheckpoint): SessionCheckpoint;

  /** The checkpoint with the highest offset (newest), or `undefined`. */
  latestCheckpoint(key: ActivationKey): SessionCheckpoint | undefined;

  /** A specific checkpoint by id, or `undefined`. */
  getCheckpoint(key: ActivationKey, id: string): SessionCheckpoint | undefined;

  /** The events with `from <= offset < to`, in offset order. `to` defaults to the head. */
  replay(key: ActivationKey, from: number, to?: number): AppendedSessionEvent[];
}

function isNonNegInt(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function assertOffset(offset: number): void {
  if (!isNonNegInt(offset)) {
    throw new RangeError(`session log offset must be a non-negative safe integer, got ${offset}`);
  }
}

/**
 * Validate a `replay(from, to)` window: `from` is a normal offset, and when a
 * bounded `to` is given it must itself be a valid offset that is not below
 * `from` — so an out-of-range or inverted bound fails fast instead of silently
 * yielding a surprising `Array.slice`/SQL range.
 */
function assertReplayBounds(from: number, to: number | undefined): void {
  assertOffset(from);
  if (to === undefined) return;
  if (!isNonNegInt(to)) {
    throw new RangeError(`session log replay 'to' must be a non-negative safe integer, got ${to}`);
  }
  if (to < from) {
    throw new RangeError(`session log replay 'to' (${to}) must be >= 'from' (${from})`);
  }
}

/**
 * A checkpoint's own {@link SessionCheckpoint.incarnation} must equal the fence
 * token it is written under — otherwise the row would be fenced with one
 * incarnation but stamped with another, producing inconsistent durable data.
 */
function assertCheckpointIncarnation(incarnation: number, checkpoint: SessionCheckpoint): void {
  if (checkpoint.incarnation !== incarnation) {
    throw new RangeError(
      `checkpoint ${checkpoint.id} incarnation (${checkpoint.incarnation}) must equal the write lease incarnation (${incarnation})`,
    );
  }
}

/**
 * The in-memory reference backend (the stub slices 2–5 code against and the tests
 * exercise). Reuses the relay {@link IncarnationFence} verbatim and keeps each
 * activation's full event array — the authoritative, non-evicting analogue of the
 * relay ring's resume window.
 */
export class InMemorySessionLog implements SessionLog {
  readonly #fence = new IncarnationFence();
  readonly #events = new Map<string, AppendedSessionEvent[]>();
  readonly #checkpoints = new Map<string, SessionCheckpoint[]>();

  #eventsFor(key: ActivationKey): AppendedSessionEvent[] {
    const s = activationKeyString(key);
    let arr = this.#events.get(s);
    if (arr === undefined) {
      arr = [];
      this.#events.set(s, arr);
    }
    return arr;
  }

  #checkpointsFor(key: ActivationKey): SessionCheckpoint[] {
    const s = activationKeyString(key);
    let arr = this.#checkpoints.get(s);
    if (arr === undefined) {
      arr = [];
      this.#checkpoints.set(s, arr);
    }
    return arr;
  }

  #admit(key: ActivationKey, incarnation: number): void {
    const s = activationKeyString(key);
    if (!this.#fence.admit(s, incarnation)) {
      throw new StaleIncarnationError(key, incarnation, this.#fence.current(s) ?? incarnation);
    }
  }

  lease(key: ActivationKey, incarnation: number): void {
    this.#admit(key, incarnation);
  }

  currentIncarnation(key: ActivationKey): number | undefined {
    return this.#fence.current(activationKeyString(key));
  }

  nextOffset(key: ActivationKey): number {
    return this.#eventsFor(key).length;
  }

  append(
    key: ActivationKey,
    incarnation: number,
    offset: number,
    event: SessionEvent,
  ): AppendedSessionEvent {
    assertOffset(offset);
    this.#admit(key, incarnation);
    const arr = this.#eventsFor(key);
    if (offset > arr.length) {
      throw new RangeError(`session log gap: append at offset ${offset} but next offset is ${arr.length}`);
    }
    if (offset < arr.length) {
      // Resuming: drop the now-superseded uncommitted tail before re-keying, and
      // prune any checkpoint pinned above the resume boundary — it now points
      // past the rewritten head and would mis-seed a later restore.
      arr.length = offset;
      this.#pruneCheckpointsAbove(key, offset);
    }
    const appended: AppendedSessionEvent = { ...event, offset, incarnation };
    arr.push(appended);
    return appended;
  }

  /** Drop checkpoints whose offset sits above `offset` (past a rewritten head). */
  #pruneCheckpointsAbove(key: ActivationKey, offset: number): void {
    const arr = this.#checkpointsFor(key);
    for (let i = arr.length - 1; i >= 0; i--) {
      if (arr[i].offset > offset) arr.splice(i, 1);
    }
  }

  putCheckpoint(key: ActivationKey, incarnation: number, checkpoint: SessionCheckpoint): SessionCheckpoint {
    this.#admit(key, incarnation);
    assertCheckpointIncarnation(incarnation, checkpoint);
    const arr = this.#checkpointsFor(key);
    // First-wins on checkpoint.id — mirrors the durable backend's
    // ON CONFLICT(checkpoint_id) DO NOTHING so a retry never duplicates.
    if (arr.some((cp) => cp.id === checkpoint.id)) return checkpoint;
    arr.push(checkpoint);
    return checkpoint;
  }

  latestCheckpoint(key: ActivationKey): SessionCheckpoint | undefined {
    let best: SessionCheckpoint | undefined;
    for (const cp of this.#checkpointsFor(key)) {
      // Highest offset wins; a later insert at the same offset supersedes.
      if (best === undefined || cp.offset >= best.offset) best = cp;
    }
    return best;
  }

  getCheckpoint(key: ActivationKey, id: string): SessionCheckpoint | undefined {
    return this.#checkpointsFor(key).find((cp) => cp.id === id);
  }

  replay(key: ActivationKey, from: number, to?: number): AppendedSessionEvent[] {
    assertReplayBounds(from, to);
    const arr = this.#eventsFor(key);
    const end = to === undefined ? arr.length : to;
    return arr.slice(from, end);
  }
}

/**
 * The minimal synchronous SQLite handle the durable log needs — structurally the
 * same surface the Urban runtime's DataLayer exposes (`host.openSqlite`), and
 * identical to the presence/transcript stores' `SqliteDb`. Kept local so the log
 * depends on a shape, not on the runtime package.
 */
export interface SqliteDb {
  exec(sql: string): void;
  run(sql: string, params?: unknown[]): { changes: number; lastInsertRowid: number | bigint };
  all<T = Record<string, unknown>>(sql: string, params?: unknown[]): T[];
}

/** A monotonic wall clock, injectable for deterministic tests. */
export interface Clock {
  now(): number;
}

/** The default clock: `Date.now()`. */
export const systemClock: Clock = { now: () => Date.now() };

interface DbLogRow {
  incarnation: number;
  next_offset: number;
}

interface DbEventRow {
  event_offset: number;
  incarnation: number;
  payload: string;
}

interface DbCheckpointRow {
  checkpoint_id: string;
  checkpoint_offset: number;
  incarnation: number;
  commit_sha: string;
  effect_ledger: string;
  created_at: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isEffectLedger(value: unknown): value is SessionCheckpoint["effectLedger"] {
  if (!Array.isArray(value)) return false;
  return value.every((entry) => isRecord(entry) && typeof entry.id === "string" && typeof entry.kind === "string");
}

/**
 * The durable authoritative log over the app DataLayer/SQLite. The fence
 * high-water lives in the activation row's `incarnation` column, so fencing
 * survives a process restart — the durable counterpart of the in-memory
 * {@link IncarnationFence}.
 */
export class SqliteSessionLog implements SessionLog {
  readonly #db: SqliteDb;
  readonly #clock: Clock;

  constructor(db: SqliteDb, options: { clock?: Clock } = {}) {
    this.#db = db;
    this.#clock = options.clock ?? systemClock;
  }

  /** Apply the canonical DDL (idempotent). Identical to the boot migration (drift-guarded). */
  ensureSchema(): void {
    this.#db.exec(SESSION_SCHEMA_SQL);
  }

  #logRow(key: ActivationKey): DbLogRow | undefined {
    return this.#db.all<DbLogRow>(
      `SELECT incarnation, next_offset FROM ${SESSION_LOG_TABLE} WHERE process_instance_key = ? AND element_id = ?`,
      [key.processInstanceKey, key.elementId],
    )[0];
  }

  #admit(key: ActivationKey, incarnation: number): void {
    if (!isNonNegInt(incarnation)) {
      throw new RangeError(`incarnation must be a non-negative safe integer, got ${incarnation}`);
    }
    // Insert the activation row if it is missing, or advance its fence high-water when
    // this lease is newer — as one atomic UPSERT. A plain ON CONFLICT DO NOTHING would
    // let a concurrent first-lease race slip through: if another writer created the row
    // between a pre-read and this INSERT, DO NOTHING would neither advance the fence nor
    // reject a stale lease. Re-read and assert afterwards (insert-then-get, mirroring the
    // transcript store) so a lease below the stored high-water is always fenced out.
    this.#db.run(
      `INSERT INTO ${SESSION_LOG_TABLE} (process_instance_key, element_id, incarnation, created_at, next_offset)
       VALUES (?, ?, ?, ?, 0)
       ON CONFLICT(process_instance_key, element_id)
         DO UPDATE SET incarnation = excluded.incarnation
         WHERE excluded.incarnation > ${SESSION_LOG_TABLE}.incarnation`,
      [key.processInstanceKey, key.elementId, incarnation, new Date(this.#clock.now()).toISOString()],
    );
    const row = this.#logRow(key);
    if (row === undefined) {
      throw new Error(`session log row vanished immediately after admit: ${activationKeyString(key)}`);
    }
    if (incarnation < row.incarnation) {
      throw new StaleIncarnationError(key, incarnation, row.incarnation);
    }
  }

  lease(key: ActivationKey, incarnation: number): void {
    this.#admit(key, incarnation);
  }

  currentIncarnation(key: ActivationKey): number | undefined {
    return this.#logRow(key)?.incarnation;
  }

  nextOffset(key: ActivationKey): number {
    return this.#logRow(key)?.next_offset ?? 0;
  }

  append(
    key: ActivationKey,
    incarnation: number,
    offset: number,
    event: SessionEvent,
  ): AppendedSessionEvent {
    assertOffset(offset);
    this.#admit(key, incarnation);
    const next = this.nextOffset(key);
    if (offset > next) {
      throw new RangeError(`session log gap: append at offset ${offset} but next offset is ${next}`);
    }
    const appended: AppendedSessionEvent = { ...event, offset, incarnation };
    return this.#atomic(() => {
      if (offset < next) {
        // Resuming: drop the now-superseded uncommitted tail before re-keying.
        this.#db.run(
          `DELETE FROM ${SESSION_EVENT_TABLE} WHERE process_instance_key = ? AND element_id = ? AND event_offset >= ?`,
          [key.processInstanceKey, key.elementId, offset],
        );
        // Prune checkpoints pinned above the resume boundary: they now point
        // past the rewritten head and would mis-seed a later restore (a gap
        // RangeError on the next emit).
        this.#db.run(
          `DELETE FROM ${SESSION_CHECKPOINT_TABLE} WHERE process_instance_key = ? AND element_id = ? AND checkpoint_offset > ?`,
          [key.processInstanceKey, key.elementId, offset],
        );
      }
      this.#db.run(
        `INSERT INTO ${SESSION_EVENT_TABLE}
           (process_instance_key, element_id, event_offset, incarnation, event_id, parent_id, event_type, payload, appended_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          key.processInstanceKey,
          key.elementId,
          offset,
          incarnation,
          event.id,
          event.parentId,
          event.type,
          JSON.stringify(appended),
          new Date(this.#clock.now()).toISOString(),
        ],
      );
      this.#advanceWindow(key, offset);
      return appended;
    });
  }

  putCheckpoint(key: ActivationKey, incarnation: number, checkpoint: SessionCheckpoint): SessionCheckpoint {
    this.#admit(key, incarnation);
    assertCheckpointIncarnation(incarnation, checkpoint);
    this.#db.run(
      `INSERT INTO ${SESSION_CHECKPOINT_TABLE}
         (process_instance_key, element_id, checkpoint_id, checkpoint_offset, incarnation, commit_sha, effect_ledger, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(process_instance_key, element_id, checkpoint_id) DO NOTHING`,
      [
        key.processInstanceKey,
        key.elementId,
        checkpoint.id,
        checkpoint.offset,
        incarnation,
        checkpoint.commitSha,
        JSON.stringify(checkpoint.effectLedger),
        checkpoint.at,
      ],
    );
    return checkpoint;
  }

  latestCheckpoint(key: ActivationKey): SessionCheckpoint | undefined {
    const row = this.#db.all<DbCheckpointRow>(
      `SELECT checkpoint_id, checkpoint_offset, incarnation, commit_sha, effect_ledger, created_at
       FROM ${SESSION_CHECKPOINT_TABLE}
       WHERE process_instance_key = ? AND element_id = ?
       ORDER BY checkpoint_offset DESC, rowid DESC LIMIT 1`,
      [key.processInstanceKey, key.elementId],
    )[0];
    return row === undefined ? undefined : this.#toCheckpoint(row);
  }

  getCheckpoint(key: ActivationKey, id: string): SessionCheckpoint | undefined {
    const row = this.#db.all<DbCheckpointRow>(
      `SELECT checkpoint_id, checkpoint_offset, incarnation, commit_sha, effect_ledger, created_at
       FROM ${SESSION_CHECKPOINT_TABLE}
       WHERE process_instance_key = ? AND element_id = ? AND checkpoint_id = ?`,
      [key.processInstanceKey, key.elementId, id],
    )[0];
    return row === undefined ? undefined : this.#toCheckpoint(row);
  }

  #toCheckpoint(row: DbCheckpointRow): SessionCheckpoint {
    const ledgerRaw: unknown = JSON.parse(row.effect_ledger);
    if (!isEffectLedger(ledgerRaw)) {
      throw new SessionLogCorruptionError(
        `checkpoint ${row.checkpoint_id} effect_ledger is not a valid EffectLedger`,
      );
    }
    return {
      id: row.checkpoint_id,
      offset: row.checkpoint_offset,
      commitSha: row.commit_sha,
      effectLedger: ledgerRaw,
      incarnation: row.incarnation,
      at: row.created_at,
    };
  }

  replay(key: ActivationKey, from: number, to?: number): AppendedSessionEvent[] {
    assertReplayBounds(from, to);
    const upper = to === undefined ? Number.MAX_SAFE_INTEGER : to;
    return this.#db
      .all<DbEventRow>(
        `SELECT event_offset, incarnation, payload FROM ${SESSION_EVENT_TABLE}
         WHERE process_instance_key = ? AND element_id = ? AND event_offset >= ? AND event_offset < ?
         ORDER BY event_offset`,
        [key.processInstanceKey, key.elementId, from, upper],
      )
      .map((row): AppendedSessionEvent => {
        const parsed: unknown = JSON.parse(row.payload);
        const event: SessionEvent = parseSessionEvent(parsed);
        return { ...event, offset: row.event_offset, incarnation: row.incarnation };
      });
  }

  /**
   * Advance an activation's retained offset window (`first_offset`/`next_offset`,
   * keyed by ActivationKey) to include the offset just appended. `append` always
   * truncates the tail (`event_offset >= offset`) before inserting at `offset`, so
   * the freshly stored offset is necessarily the new maximum (`next_offset =
   * offset + 1`) and the minimum can only move down. Updating incrementally from
   * the appended offset therefore keeps the window exact in O(1) — a full MIN/MAX
   * scan of the event table on every append would be O(n) and make appends O(n²)
   * as the log grows.
   */
  #advanceWindow(key: ActivationKey, offset: number): void {
    this.#db.run(
      `UPDATE ${SESSION_LOG_TABLE}
         SET first_offset = MIN(COALESCE(first_offset, ?), ?), next_offset = ?
       WHERE process_instance_key = ? AND element_id = ?`,
      [offset, offset, offset + 1, key.processInstanceKey, key.elementId],
    );
  }

  #atomic<T>(body: () => T): T {
    this.#db.exec("SAVEPOINT nano_session_atomic");
    try {
      const result = body();
      this.#db.exec("RELEASE SAVEPOINT nano_session_atomic");
      return result;
    } catch (err) {
      this.#db.exec("ROLLBACK TO SAVEPOINT nano_session_atomic");
      this.#db.exec("RELEASE SAVEPOINT nano_session_atomic");
      throw err;
    }
  }
}

/**
 * Raised when a row read back from the durable session log holds a value outside
 * its domain (e.g. a corrupt effect-ledger JSON). Fail fast rather than coercing.
 */
export class SessionLogCorruptionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SessionLogCorruptionError";
  }
}
