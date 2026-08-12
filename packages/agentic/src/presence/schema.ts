/**
 * The canonical presence-registry schema.
 *
 * The DDL here is the single source of truth the {@link PresenceStore} applies
 * through {@link PresenceStore.ensureSchema}. The very same statements are
 * mirrored in the app-boot migration `db/migrations/001_agentic_presence.sql`
 * (applied by the DataLayer migration runner). To keep those two application
 * paths from drifting, `schema.test.ts` normalises both and asserts they are
 * statement-for-statement identical — divergence is a red test, not a silent
 * production/boot mismatch.
 */

/** The presence & registry table name. */
export const PRESENCE_TABLE = "agentic_presence";

/**
 * The canonical presence-registry DDL. Forward-only and additive; every column
 * added here must also be added to the boot migration (the drift guard enforces
 * it). Capability (cognition/weight/family/host) is stored as an ENROLMENT
 * attribute — never a routing token.
 */
export const PRESENCE_SCHEMA_SQL = `CREATE TABLE IF NOT EXISTS ${PRESENCE_TABLE} (
  instance      TEXT PRIMARY KEY,
  connection_id TEXT NOT NULL,
  identity      TEXT NOT NULL,
  cognition     TEXT,
  weight        REAL,
  family        TEXT,
  host          TEXT,
  registered_at TEXT NOT NULL,
  last_seen     INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_${PRESENCE_TABLE}_last_seen ON ${PRESENCE_TABLE} (last_seen);
CREATE INDEX IF NOT EXISTS idx_${PRESENCE_TABLE}_connection ON ${PRESENCE_TABLE} (connection_id);`;
