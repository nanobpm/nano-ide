/**
 * The canonical transcript-store schema.
 *
 * The DDL here is the single source of truth the {@link TranscriptStore} applies
 * through {@link TranscriptStore.ensureSchema}. The very same statements are
 * mirrored in the app-boot migration `db/migrations/002_agentic_transcript.sql`
 * (applied by the DataLayer migration runner). To keep those two application
 * paths from drifting, `schema.test.ts` normalises both and asserts they are
 * statement-for-statement identical — divergence is a red test, not a silent
 * production/boot mismatch.
 *
 * Two tables back the store:
 *  - `agentic_transcript_stream` — one row per relay stream: its retention
 *    lifecycle (`ephemeral` vs `long-lived`), its status (`open`/`completed`),
 *    and the offset window (`first_offset` … `next_offset`) currently retained.
 *  - `agentic_transcript_chunk` — the durable chunks, keyed `(stream, chunk_offset)`
 *    so a flush/append is idempotent and reattach can slice from any offset.
 *
 * `chunk_offset` (not `offset`) is deliberate: `OFFSET` is a SQLite keyword, so
 * the column is named to avoid quoting it in every statement.
 */

/** The per-stream metadata table name. */
export const TRANSCRIPT_STREAM_TABLE = "agentic_transcript_stream";

/** The durable per-chunk table name. */
export const TRANSCRIPT_CHUNK_TABLE = "agentic_transcript_chunk";

/**
 * The canonical transcript-store DDL. Forward-only and additive; every column
 * added here must also be added to the boot migration (the drift guard enforces
 * it). Chunks are immutable once written — retention drops whole windows/streams,
 * it never rewrites a chunk.
 */
export const TRANSCRIPT_SCHEMA_SQL = `CREATE TABLE IF NOT EXISTS ${TRANSCRIPT_STREAM_TABLE} (
  stream        TEXT PRIMARY KEY,
  lifecycle     TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'open',
  created_at    TEXT NOT NULL,
  completed_at  TEXT,
  first_offset  INTEGER,
  next_offset   INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS ${TRANSCRIPT_CHUNK_TABLE} (
  stream        TEXT NOT NULL,
  chunk_offset  INTEGER NOT NULL,
  chunk         TEXT NOT NULL,
  appended_at   TEXT NOT NULL,
  PRIMARY KEY (stream, chunk_offset)
);
CREATE INDEX IF NOT EXISTS idx_${TRANSCRIPT_STREAM_TABLE}_retention ON ${TRANSCRIPT_STREAM_TABLE} (lifecycle, status, completed_at);`;
