// instance-state-store — the canonical per-instance engine lifecycle-state projection (ADR 0065,
// proposal point #1). A framework-level, per-source sidecar (exactly like the lineage store) that
// records each tracked process instance's engine-truth lifecycle state (ACTIVE / COMPLETED /
// TERMINATED) plus whether it is waiting on a human, from the same `searchProcessInstances` /
// `openUserTasks` truth the `instanceTracking` reconciler already reads.
//
// A read model can then DERIVE an instance's status edge purely from this projection — e.g. the
// terminal edge (`onTerminated`, → `abandoned`) becomes an `EXISTS(urban_instance_state WHERE
// process_instance_key = … AND state = 'TERMINATED')` derivation, instead of a stored `status` write
// that tears from engine truth. This projection PROVIDES that engine-truth source; retiring the
// reconciler's writes is the downstream `writer-source-inversion` task.
//
// It is framework bookkeeping, so the physical table is `_urban_`-prefixed to stay hidden from the
// domain model / DB Manager (see `SqliteGateway.schema()`), like the lineage tables — and NEVER
// app-written. Recording is idempotent: re-recording an unchanged state is a no-op.

import type { ProcessInstanceSnapshot, ProcessInstanceState, SqliteDb } from "../host.ts";
import { type Clock, systemClock } from "./lineage-store.ts";

/** The instance-state projection table. Framework bookkeeping, so `_urban_`-prefixed to stay hidden
 *  from the domain model / DB Manager (see `SqliteGateway.schema()`), like the lineage tables. */
export const INSTANCE_STATE_TABLE = "_urban_instance_state";

/** The stable DSL projection NAME a `defineReadModel` `exists(...)` references (registered in the
 *  `projectionRegistry`, mapped to {@link INSTANCE_STATE_TABLE}). The DSL name is unprefixed so a read
 *  model reads `EXISTS(urban_instance_state WHERE process_instance_key = base.process_instance_key)`. */
export const INSTANCE_STATE_PROJECTION = "urban_instance_state";

/**
 * The canonical instance-state DDL — the single source of truth applied by
 * {@link InstanceStateStore.ensureSchema}, mirrored verbatim by the boot migration
 * `db/migrations/007_urban_instance_state.sql` (a drift-guard test asserts they match).
 *
 * Forward-only and additive. Keyed by `process_instance_key` (one canonical state per instance) so a
 * re-record upserts in place and is idempotent. `waiting_on_human` is 0/1 (SQLite has no boolean).
 */
export const INSTANCE_STATE_SCHEMA_SQL = `CREATE TABLE IF NOT EXISTS ${INSTANCE_STATE_TABLE} (
  process_instance_key TEXT NOT NULL,
  state                TEXT NOT NULL,
  waiting_on_human     INTEGER NOT NULL DEFAULT 0,
  updated_at           TEXT NOT NULL,
  PRIMARY KEY (process_instance_key)
);`;

export interface InstanceStateStoreOptions {
  readonly clock?: Clock;
}

/** One projected instance-state row, as {@link InstanceStateStore.getState} returns it. */
export interface InstanceStateRow {
  readonly processInstanceKey: string;
  readonly state: ProcessInstanceState;
  readonly waitingOnHuman: boolean;
}

interface InstanceStateDbRow {
  process_instance_key: string;
  state: string;
  waiting_on_human: number;
}

function normalizeState(raw: string): ProcessInstanceState {
  return raw === "COMPLETED" ? "COMPLETED" : raw === "TERMINATED" ? "TERMINATED" : "ACTIVE";
}

/**
 * The per-source sidecar behind the `urban_instance_state` projection. A thin, idempotent
 * persistence + query layer over the engine's per-instance lifecycle truth.
 */
export class InstanceStateStore {
  readonly #db: SqliteDb;
  readonly #clock: Clock;

  constructor(db: SqliteDb, options: InstanceStateStoreOptions = {}) {
    this.#db = db;
    this.#clock = options.clock ?? systemClock;
  }

  /** Apply the canonical DDL (idempotent). Callers whose app DataLayer applies the boot migration
   *  `db/migrations/007_urban_instance_state.sql` do not need this; the runtime calls it so the store
   *  is usable against a bare source too. The DDL is identical to the migration (drift-guarded). */
  ensureSchema(): void {
    this.#db.exec(INSTANCE_STATE_SCHEMA_SQL);
  }

  /**
   * Record an instance's canonical engine lifecycle state (and whether it is waiting on a human),
   * upserting the single row keyed by `processInstanceKey`. Idempotent: re-recording the same
   * `(state, waitingOnHuman)` is a no-op (returns `false`). A blank `processInstanceKey` is ignored.
   */
  recordState(processInstanceKey: string, state: ProcessInstanceState, waitingOnHuman = false): boolean {
    if (!processInstanceKey) return false;
    const { changes } = this.#db.run(
      `INSERT INTO ${INSTANCE_STATE_TABLE}
         (process_instance_key, state, waiting_on_human, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT (process_instance_key) DO UPDATE SET
         state = excluded.state,
         waiting_on_human = excluded.waiting_on_human,
         updated_at = excluded.updated_at
       WHERE ${INSTANCE_STATE_TABLE}.state <> excluded.state
          OR ${INSTANCE_STATE_TABLE}.waiting_on_human <> excluded.waiting_on_human`,
      [processInstanceKey, state, waitingOnHuman ? 1 : 0, new Date(this.#clock.now()).toISOString()],
    );
    return changes > 0;
  }

  /** Record from a {@link ProcessInstanceSnapshot} (the engine's `searchProcessInstances` row),
   *  carrying the optional waiting-on-human flag the reconciler probes separately. */
  recordFromSnapshot(snapshot: ProcessInstanceSnapshot, waitingOnHuman = false): boolean {
    return this.recordState(snapshot.processInstanceKey, snapshot.state, waitingOnHuman);
  }

  /** The projected canonical state for an instance, or `undefined` if none recorded. */
  getState(processInstanceKey: string): InstanceStateRow | undefined {
    const rows = this.#db.all<InstanceStateDbRow>(
      `SELECT process_instance_key, state, waiting_on_human
         FROM ${INSTANCE_STATE_TABLE} WHERE process_instance_key = ?`,
      [processInstanceKey],
    );
    const row = rows[0];
    if (!row) return undefined;
    return {
      processInstanceKey: row.process_instance_key,
      state: normalizeState(row.state),
      waitingOnHuman: row.waiting_on_human !== 0,
    };
  }
}
