/**
 * {@link SessionBackend} — the canonical {@link SessionAdapter} implementation,
 * ADR 0062 slice 1.
 *
 * There is exactly **one** adapter implementation (derivation over duplication):
 * it is bound to a {@link SessionLog} port, so the *same* emit/checkpoint/restore
 * semantics run over either the in-memory reference log ({@link InMemorySessionLog}
 * — the stub slices 2–5 code against) or the durable SQLite log
 * ({@link SqliteSessionLog}). The backend owns the append cursor and the fencing
 * token; the log owns storage and the fence high-water.
 */
import { randomUUID } from "node:crypto";
import {
  type ActivationKey,
  type EffectLedger,
  type SessionAdapter,
  type SessionCheckpoint,
  type SessionSeed,
} from "./adapter.ts";
import type { AppendedSessionEvent, SessionEvent } from "./events.ts";
import { type Clock, InMemorySessionLog, type SessionLog, type SqliteDb, SqliteSessionLog, systemClock } from "./log.ts";

export interface SessionBackendOptions {
  /** Injectable clock for deterministic checkpoint timestamps. Default {@link systemClock}. */
  clock?: Clock;
  /** Injectable checkpoint-id generator (deterministic tests). Default `crypto.randomUUID`. */
  newCheckpointId?: () => string;
}

/**
 * A session adapter bound to one activation and one incarnation. Constructing it
 * takes the lease at `incarnation` (advancing the fence), so a re-lease at a
 * higher incarnation immediately fences every prior one — a subsequent `emit`
 * from an older adapter throws {@link StaleIncarnationError}.
 */
export class SessionBackend implements SessionAdapter {
  readonly key: ActivationKey;
  readonly incarnation: number;
  readonly #log: SessionLog;
  readonly #clock: Clock;
  readonly #newCheckpointId: () => string;
  /** The offset the next `emit` writes at. Advanced by `emit`, repositioned by `restore`. */
  #cursor: number;

  constructor(log: SessionLog, key: ActivationKey, incarnation: number, options: SessionBackendOptions = {}) {
    log.lease(key, incarnation);
    this.#log = log;
    this.key = key;
    this.incarnation = incarnation;
    this.#clock = options.clock ?? systemClock;
    this.#newCheckpointId = options.newCheckpointId ?? randomUUID;
    // Default to appending after whatever is already committed; `restore`
    // repositions the cursor to a checkpoint boundary when resuming.
    this.#cursor = log.nextOffset(key);
  }

  /** The offset the next `emit` will assign. */
  get nextOffset(): number {
    return this.#cursor;
  }

  emit(event: SessionEvent): AppendedSessionEvent {
    const appended = this.#log.append(this.key, this.incarnation, this.#cursor, event);
    this.#cursor = appended.offset + 1;
    return appended;
  }

  checkpoint(commitSha: string, effectLedger: EffectLedger): SessionCheckpoint {
    const checkpoint: SessionCheckpoint = {
      id: this.#newCheckpointId(),
      offset: this.#cursor,
      commitSha,
      effectLedger,
      incarnation: this.incarnation,
      at: new Date(this.#clock.now()).toISOString(),
    };
    return this.#log.putCheckpoint(this.key, this.incarnation, checkpoint);
  }

  restore(fromCheckpoint?: string): SessionSeed {
    // Contract: no argument OR an unknown id resolves the latest checkpoint; a
    // known id restores exactly that checkpoint.
    const checkpoint =
      fromCheckpoint === undefined
        ? this.#log.latestCheckpoint(this.key)
        : (this.#log.getCheckpoint(this.key, fromCheckpoint) ?? this.#log.latestCheckpoint(this.key));
    if (checkpoint === undefined) {
      // No checkpoint to resume from: start the mind fresh at offset 0. The next
      // emit at offset 0 discards any uncommitted events a dead incarnation left.
      this.#cursor = 0;
      return { checkpoint: null, events: [], nextOffset: 0 };
    }
    const events = this.#log.replay(this.key, 0, checkpoint.offset);
    // Reposition the write cursor to the checkpoint boundary: the resumed
    // incarnation continues from there, overwriting any uncommitted tail.
    this.#cursor = checkpoint.offset;
    return { checkpoint, events, nextOffset: checkpoint.offset };
  }
}

/**
 * Open a session adapter over an in-memory reference log. Pass a shared
 * {@link InMemorySessionLog} across incarnations of the same activation so the
 * fence and events persist across a re-lease (the reference resume scenario);
 * omit it for a throwaway single-incarnation log.
 */
export function openInMemorySession(
  key: ActivationKey,
  incarnation: number,
  options: SessionBackendOptions & { log?: InMemorySessionLog } = {},
): { backend: SessionBackend; log: InMemorySessionLog } {
  const log = options.log ?? new InMemorySessionLog();
  const backend = new SessionBackend(log, key, incarnation, options);
  return { backend, log };
}

/** Open a session adapter over the durable SQLite log. Applies the schema idempotently. */
export function openSqliteSession(
  db: SqliteDb,
  key: ActivationKey,
  incarnation: number,
  options: SessionBackendOptions = {},
): { backend: SessionBackend; log: SqliteSessionLog } {
  const log = new SqliteSessionLog(db, { clock: options.clock });
  log.ensureSchema();
  const backend = new SessionBackend(log, key, incarnation, options);
  return { backend, log };
}
