/**
 * The canonical authoritative session-log schema — ADR 0062, slice 1.
 *
 * The DDL here is the single source of truth {@link SqliteSessionLog.ensureSchema}
 * applies, and is mirrored statement-for-statement by the app-boot migration
 * `db/migrations/005_agentic_session.sql`. `schema.test.ts` normalises both and
 * asserts they are identical — drift is a red test, not a silent boot mismatch.
 * This mirrors the S6 transcript store's drift-guard exactly (ADR 0056 §12), the
 * advisory precedent this authoritative log is promoted from.
 *
 * Three tables back the log:
 *  - `agentic_session_log` — one row per **activation** `(processInstanceKey,
 *    elementId)`: its fence high-water (`incarnation`), retention lifecycle,
 *    status, and the retained offset window (`first_offset` … `next_offset`).
 *  - `agentic_session_event` — the durable, authoritative events, keyed
 *    `(process_instance_key, element_id, event_offset)` so a re-lease can replay
 *    from any offset and a resuming incarnation can overwrite an uncommitted tail
 *    idempotently.
 *  - `agentic_session_checkpoint` — the mind/world join points, keyed
 *    `(process_instance_key, element_id, checkpoint_id)` with the pinned offset.
 *
 * `event_offset`/`checkpoint_offset` (not `offset`) is deliberate: `OFFSET` is a
 * SQLite keyword, so the columns are named to avoid quoting it everywhere.
 */

/** The per-activation metadata + fence table name. */
export const SESSION_LOG_TABLE = "agentic_session_log";

/** The durable per-event table name. */
export const SESSION_EVENT_TABLE = "agentic_session_event";

/** The checkpoint table name. */
export const SESSION_CHECKPOINT_TABLE = "agentic_session_checkpoint";

/**
 * The canonical session-log DDL. Forward-only and additive; every column added
 * here must also be added to the boot migration (the drift guard enforces it).
 * Events are immutable once committed under an incarnation; a resume overwrites
 * only the *uncommitted* tail past the last checkpoint (a re-key at the same
 * `(activation, offset)`), never a committed row.
 */
export const SESSION_SCHEMA_SQL = `CREATE TABLE IF NOT EXISTS ${SESSION_LOG_TABLE} (
  process_instance_key  TEXT NOT NULL,
  element_id            TEXT NOT NULL,
  incarnation           INTEGER NOT NULL DEFAULT 0,
  lifecycle             TEXT NOT NULL DEFAULT 'activation',
  status                TEXT NOT NULL DEFAULT 'open',
  created_at            TEXT NOT NULL,
  completed_at          TEXT,
  first_offset          INTEGER,
  next_offset           INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (process_instance_key, element_id)
);
CREATE TABLE IF NOT EXISTS ${SESSION_EVENT_TABLE} (
  process_instance_key  TEXT NOT NULL,
  element_id            TEXT NOT NULL,
  event_offset          INTEGER NOT NULL,
  incarnation           INTEGER NOT NULL,
  event_id              TEXT NOT NULL,
  parent_id             TEXT,
  event_type            TEXT NOT NULL,
  payload               TEXT NOT NULL,
  appended_at           TEXT NOT NULL,
  PRIMARY KEY (process_instance_key, element_id, event_offset)
);
CREATE TABLE IF NOT EXISTS ${SESSION_CHECKPOINT_TABLE} (
  process_instance_key  TEXT NOT NULL,
  element_id            TEXT NOT NULL,
  checkpoint_id         TEXT NOT NULL,
  checkpoint_offset     INTEGER NOT NULL,
  incarnation           INTEGER NOT NULL,
  commit_sha            TEXT NOT NULL,
  effect_ledger         TEXT NOT NULL,
  created_at            TEXT NOT NULL,
  PRIMARY KEY (process_instance_key, element_id, checkpoint_id)
);
CREATE INDEX IF NOT EXISTS idx_${SESSION_CHECKPOINT_TABLE}_offset ON ${SESSION_CHECKPOINT_TABLE} (process_instance_key, element_id, checkpoint_offset);
CREATE INDEX IF NOT EXISTS idx_${SESSION_LOG_TABLE}_retention ON ${SESSION_LOG_TABLE} (lifecycle, status, completed_at);`;
