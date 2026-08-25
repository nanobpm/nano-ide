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
 * Three tables back the store:
 *  - `agentic_transcript_stream` — one row per relay stream: its retention
 *    lifecycle (`ephemeral` vs `long-lived`), its status (`open`/`completed`),
 *    and the offset window (`first_offset` … `next_offset`) currently retained.
 *  - `agentic_transcript_chunk` — the durable chunks, keyed `(stream, chunk_offset)`
 *    so a flush/append is idempotent and reattach can slice from any offset.
 *  - `agentic_transcript_turn` — the additive turn-structured view (Camunda
 *    `AgentHistoryRecordValue` parity, issue #475), keyed `(stream, turn_sequence)`.
 *    It is layered over — never a replacement for — the raw chunk stream.
 *
 * `chunk_offset` (not `offset`) is deliberate: `OFFSET` is a SQLite keyword, so
 * the column is named to avoid quoting it in every statement.
 */

/** The per-stream metadata table name. */
export const TRANSCRIPT_STREAM_TABLE = "agentic_transcript_stream";

/** The durable per-chunk table name. */
export const TRANSCRIPT_CHUNK_TABLE = "agentic_transcript_chunk";

/** The durable per-turn (structured-view) table name. */
export const TRANSCRIPT_TURN_TABLE = "agentic_transcript_turn";

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

/**
 * The turn-structured transcript DDL — the additive, Camunda-`AgentHistoryRecordValue`
 * parity view layered over the raw chunk stream (issue #475). It ships as its own
 * forward-only migration `db/migrations/008_agentic_transcript_turns.sql` (the raw
 * chunk stream in {@link TRANSCRIPT_SCHEMA_SQL} is untouched — additive, no regression
 * to existing readers), mirrored here as the single source of truth applied by
 * {@link TranscriptStore.ensureSchema} and kept in lockstep by a drift-guard test.
 *
 * One row per structured turn, keyed `(stream, turn_sequence)` so an append/re-record
 * is idempotent (exactly the `(stream, chunk_offset)` discipline of the chunk table).
 * `turn_sequence` is the stream-local append order and idempotency key;
 * `loop_iteration` is the agent-loop turn counter carried as data (Camunda allows
 * several role-split records — e.g. ASSISTANT then TOOL_RESULT — within one iteration).
 * `content`, `tool_calls` and `metrics` hold the typed content blocks, tool calls and
 * per-turn metrics as JSON.
 */
export const TRANSCRIPT_TURN_SCHEMA_SQL = `CREATE TABLE IF NOT EXISTS ${TRANSCRIPT_TURN_TABLE} (
  stream         TEXT NOT NULL,
  turn_sequence  INTEGER NOT NULL,
  loop_iteration INTEGER NOT NULL,
  role           TEXT NOT NULL,
  content        TEXT NOT NULL,
  tool_calls     TEXT NOT NULL,
  metrics        TEXT,
  produced_at    INTEGER,
  recorded_at    TEXT NOT NULL,
  PRIMARY KEY (stream, turn_sequence)
);`;
