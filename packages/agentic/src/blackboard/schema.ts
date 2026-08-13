/**
 * The canonical blackboard schema.
 *
 * The DDL here is the single source of truth the {@link BlackboardStore} applies
 * through {@link BlackboardStore.ensureSchema}. The very same statements are
 * mirrored in the app-boot migration `db/migrations/003_agentic_blackboard.sql`
 * (applied by the DataLayer migration runner). To keep those two application
 * paths from drifting, `schema.test.ts` normalises both and asserts they are
 * statement-for-statement identical — divergence is a red test, not a silent
 * production/boot mismatch.
 *
 * The table promotes nano-workforce's per-plan `plan_blackboard` HTTP hook to a
 * first-class channel-family store: the same idempotent-append (`dedupe_key`),
 * conflict-of-intent (`file-claim`) and incremental-read (`id`/cursor) semantics,
 * generalised from a hard-wired `plan_key` to a capability-derived `scope` so any
 * Urban app gets it for free.
 */

/** The blackboard table name. */
export const BLACKBOARD_TABLE = "agentic_blackboard";

/**
 * The canonical blackboard DDL. Forward-only and additive; every column added
 * here must also be added to the boot migration (the drift guard enforces it).
 *
 * Idempotency: the partial UNIQUE index over `(scope, dedupe_key)` (NULLs
 * excluded, so a dedupe-less note always appends) collapses a re-POST carrying a
 * stable `dedupe_key` to one row — the engine may re-activate a job on retry, so
 * a repeated append must be a no-op. `(scope, id)` lists a board's entries in
 * write order and drives the `since`/cursor incremental read.
 */
export const BLACKBOARD_SCHEMA_SQL = `CREATE TABLE IF NOT EXISTS ${BLACKBOARD_TABLE} (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  scope       TEXT NOT NULL,
  author_task TEXT NOT NULL DEFAULT 'system',
  kind        TEXT NOT NULL DEFAULT 'note',
  files       TEXT,
  body        TEXT NOT NULL,
  wave        INTEGER,
  dedupe_key  TEXT,
  created_at  TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_${BLACKBOARD_TABLE}_dedupe ON ${BLACKBOARD_TABLE} (scope, dedupe_key) WHERE dedupe_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_${BLACKBOARD_TABLE}_scope ON ${BLACKBOARD_TABLE} (scope, id);`;
