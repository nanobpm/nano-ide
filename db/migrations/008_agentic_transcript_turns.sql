-- 008_agentic_transcript_turns.sql — turn-structured transcript view
-- (Nano agentic protocol, issue #475).
--
-- Forward-only, additive migration: gives the agent transcript a turn structure
-- mirroring Camunda's AgentHistoryRecordValue — loopIteration (turn counter),
-- role, typed content blocks (TEXT/DOCUMENT/OBJECT), toolCalls (toolCallId,
-- toolName, elementId, arguments) and per-turn metrics (input/output/reasoning/
-- cache tokens, durationMs). It layers OVER the raw chunk stream from 002 — that
-- stream is untouched (additive, no regression to existing readers).
--
-- This migration MIRRORS the canonical turn DDL — `TRANSCRIPT_TURN_SCHEMA_SQL`
-- in @nanobpm/agentic's transcript `schema.ts`, which is the single source of
-- truth and is applied by TranscriptStore.ensureSchema() alongside the chunk-
-- stream DDL. The app applies this identical statement set on boot via the
-- DataLayer migration runner. A drift-guard test (schema.test.ts) fails if the
-- two ever diverge — edit the canonical schema.ts and update this mirror together.
--
-- Migration numbering (a shared epic surface): this slice simply takes the next
-- free prefix (008) after 007. Expand-and-contract: additive only, no drops.
CREATE TABLE IF NOT EXISTS agentic_transcript_turn (
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
);
