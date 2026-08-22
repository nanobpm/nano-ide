// open-user-tasks-store — the canonical engine-truth projection of "which process instances are
// parked on a human" (ADR 0065, proposal point #1). A framework-level, per-source sidecar (exactly
// like the lineage store) that materialises the set of currently-open (CREATED-state) user tasks per
// process instance from engine truth — the same `openUserTasks` / `searchUserTasks({state:"CREATED"})`
// query the `instanceTracking` reconciler already runs.
//
// This ABSORBS nano-workforce's hand-rolled `user_tasks` table: it is the ONE authoritative projection
// a read model can `EXISTS`-over to derive the "waiting-on-human" status edge, instead of an app
// hand-maintaining a stored `awaiting_operator` column (the tearing surface of nano-workforce#422).
//
// It is framework bookkeeping, so the physical table is `_urban_`-prefixed to stay hidden from the
// domain model / DB Manager (see `SqliteGateway.schema()`), like the lineage tables — and it is NEVER
// app-written. Recording is idempotent and authoritative-per-instance: {@link OpenUserTasksStore.syncInstance}
// replaces an instance's rows with exactly the engine's current open set, so an answered/closed task
// disappears on the next poll and the derived edge re-flips by construction (No Drift Surfaces).

import type { SqliteDb } from "../host.ts";
import type { UserTaskSummary } from "../host.ts";
import { type Clock, systemClock } from "./lineage-store.ts";

/** The open-user-tasks projection table. Framework bookkeeping, so `_urban_`-prefixed to stay hidden
 *  from the domain model / DB Manager (see `SqliteGateway.schema()`), like the lineage tables. */
export const OPEN_USER_TASKS_TABLE = "_urban_open_user_tasks";

/** The stable DSL projection NAME a `defineReadModel` `exists(...)` references (registered in the
 *  `projectionRegistry`, mapped to {@link OPEN_USER_TASKS_TABLE}). The DSL name is unprefixed so a read
 *  model reads `EXISTS(urban_open_user_tasks WHERE process_instance_key = base.process_instance_key)`. */
export const OPEN_USER_TASKS_PROJECTION = "urban_open_user_tasks";

/**
 * The canonical open-user-tasks DDL — the single source of truth applied by
 * {@link OpenUserTasksStore.ensureSchema}, mirrored verbatim by the boot migration
 * `db/migrations/006_urban_open_user_tasks.sql` (a drift-guard test asserts they match).
 *
 * Forward-only and additive. Keyed by `user_task_key` so a re-record of the same open task is a no-op;
 * `process_instance_key` carries an index so a read model's correlated `EXISTS(... WHERE
 * process_instance_key = …)` and the reconciler's per-instance sync read only that instance's rows.
 */
export const OPEN_USER_TASKS_SCHEMA_SQL = `CREATE TABLE IF NOT EXISTS ${OPEN_USER_TASKS_TABLE} (
  process_instance_key TEXT NOT NULL,
  user_task_key        TEXT NOT NULL,
  element_id           TEXT,
  created_at           TEXT NOT NULL,
  PRIMARY KEY (user_task_key)
);
CREATE INDEX IF NOT EXISTS idx_${OPEN_USER_TASKS_TABLE}_instance ON ${OPEN_USER_TASKS_TABLE} (process_instance_key);`;

export interface OpenUserTasksStoreOptions {
  readonly clock?: Clock;
}

/** One projected open-user-task row, as {@link OpenUserTasksStore.openTasks} returns it. */
export interface OpenUserTaskRow {
  readonly processInstanceKey: string;
  readonly userTaskKey: string;
  readonly elementId?: string;
}

interface OpenTaskDbRow {
  process_instance_key: string;
  user_task_key: string;
  element_id: string | null;
}

/**
 * The per-source sidecar behind the `urban_open_user_tasks` projection. A thin, idempotent
 * persistence + query layer over the engine's open-user-task truth; it interprets no app schema.
 */
export class OpenUserTasksStore {
  readonly #db: SqliteDb;
  readonly #clock: Clock;

  constructor(db: SqliteDb, options: OpenUserTasksStoreOptions = {}) {
    this.#db = db;
    this.#clock = options.clock ?? systemClock;
  }

  /** Apply the canonical DDL (idempotent). Callers whose app DataLayer applies the boot migration
   *  `db/migrations/006_urban_open_user_tasks.sql` do not need this; the runtime calls it so the store
   *  is usable against a bare source too. The DDL is identical to the migration (drift-guarded). */
  ensureSchema(): void {
    this.#db.exec(OPEN_USER_TASKS_SCHEMA_SQL);
  }

  /**
   * Record one open user task for an instance, idempotently. A re-record of the same `userTaskKey` is
   * a no-op. A blank `processInstanceKey` or `userTaskKey` is ignored. Prefer {@link syncInstance} to
   * record an instance's WHOLE current open set (which also retires closed tasks); this single-row
   * form is the idempotent building block.
   */
  recordOpenTask(processInstanceKey: string, task: UserTaskSummary): boolean {
    if (!processInstanceKey || !task.userTaskKey) return false;
    const { changes } = this.#db.run(
      `INSERT OR IGNORE INTO ${OPEN_USER_TASKS_TABLE}
         (process_instance_key, user_task_key, element_id, created_at)
       VALUES (?, ?, ?, ?)`,
      [processInstanceKey, task.userTaskKey, task.elementId ?? null, new Date(this.#clock.now()).toISOString()],
    );
    return changes > 0;
  }

  /**
   * Make the projection reflect an instance's CURRENT open set exactly: insert the engine's open tasks
   * and delete any previously-projected task for the instance that is no longer open. This is the
   * authoritative record from engine truth (`openUserTasks({ processInstanceKey })`), the operation the
   * reconciler drives each poll — so an answered/closed task disappears and the derived
   * "waiting-on-human" edge re-flips by construction (nano-workforce#422). Idempotent: syncing the same
   * open set twice leaves the table unchanged. A blank `processInstanceKey` is ignored.
   */
  syncInstance(processInstanceKey: string, openTasks: readonly UserTaskSummary[]): void {
    if (!processInstanceKey) return;
    // Wrap the insert+delete replace in a SAVEPOINT so the whole sync is atomic: no reader observes a
    // transient mixed state mid-sync, and a mid-loop failure rolls back cleanly instead of leaving the
    // instance with a torn open set. SAVEPOINT (not BEGIN) so this also composes when called inside an
    // existing transaction, e.g. a reconciler poll that batches many instances.
    this.#db.exec("SAVEPOINT urban_sync_open_tasks");
    try {
      const keep = new Set<string>();
      for (const task of openTasks) {
        if (!task.userTaskKey) continue;
        keep.add(task.userTaskKey);
        this.recordOpenTask(processInstanceKey, task);
      }
      const existing = this.#db.all<{ user_task_key: string }>(
        `SELECT user_task_key FROM ${OPEN_USER_TASKS_TABLE} WHERE process_instance_key = ?`,
        [processInstanceKey],
      );
      for (const row of existing) {
        if (!keep.has(row.user_task_key)) {
          this.#db.run(`DELETE FROM ${OPEN_USER_TASKS_TABLE} WHERE user_task_key = ?`, [row.user_task_key]);
        }
      }
      this.#db.exec("RELEASE urban_sync_open_tasks");
    } catch (err) {
      this.#db.exec("ROLLBACK TO urban_sync_open_tasks");
      this.#db.exec("RELEASE urban_sync_open_tasks");
      throw err;
    }
  }

  /** Retire every projected open task for an instance (e.g. it terminated). Idempotent. */
  clearInstance(processInstanceKey: string): void {
    if (!processInstanceKey) return;
    this.#db.run(`DELETE FROM ${OPEN_USER_TASKS_TABLE} WHERE process_instance_key = ?`, [processInstanceKey]);
  }

  /** True iff the instance currently has any open user task — the "parked on a human" predicate. */
  hasOpenTask(processInstanceKey: string): boolean {
    if (!processInstanceKey) return false;
    // Existence predicate: `SELECT 1 … LIMIT 1` short-circuits on the first matching row rather than
    // counting every open task for the instance.
    const rows = this.#db.all<{ one: number }>(
      `SELECT 1 AS one FROM ${OPEN_USER_TASKS_TABLE} WHERE process_instance_key = ? LIMIT 1`,
      [processInstanceKey],
    );
    return rows.length > 0;
  }

  /** The projected open tasks for an instance, in insertion order. */
  openTasks(processInstanceKey: string): OpenUserTaskRow[] {
    const rows = this.#db.all<OpenTaskDbRow>(
      `SELECT process_instance_key, user_task_key, element_id
         FROM ${OPEN_USER_TASKS_TABLE} WHERE process_instance_key = ? ORDER BY rowid`,
      [processInstanceKey],
    );
    return rows.map((r) => ({
      processInstanceKey: r.process_instance_key,
      userTaskKey: r.user_task_key,
      ...(r.element_id ? { elementId: r.element_id } : {}),
    }));
  }
}
