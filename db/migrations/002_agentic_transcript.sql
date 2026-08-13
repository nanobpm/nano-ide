-- 002_agentic_transcript.sql — S6 (Nano agentic protocol, ADR 0056, issue #132).
--
-- Forward-only, additive migration: the transcript store backing retention-by-
-- lifecycle over the app DataLayer. An ephemeral run flushes the S5 relay ring to
-- a durable, readable transcript on job completion; a long-lived stream retains
-- its chunks so a consumer can resume-from-offset (reattach) after a reconnect.
--
-- This migration MIRRORS the canonical transcript DDL — `TRANSCRIPT_SCHEMA_SQL`
-- in @nanobpm/agentic-transcript's `schema.ts`, which is the single source of
-- truth and is applied by TranscriptStore.ensureSchema(). The app applies this
-- identical statement set on boot via the DataLayer migration runner. A drift-
-- guard test (schema.test.ts) fails if the two ever diverge — edit the canonical
-- schema.ts and update this mirror together.
--
-- Migration numbering (a shared epic surface): this slice is sequenced AFTER S2's
-- 001_agentic_presence.sql has landed and BEFORE S7 (#133), so it simply takes
-- the next free prefix (002). Expand-and-contract: additive only, no drops.
CREATE TABLE IF NOT EXISTS agentic_transcript_stream (
  stream        TEXT PRIMARY KEY,
  lifecycle     TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'open',
  created_at    TEXT NOT NULL,
  completed_at  TEXT,
  first_offset  INTEGER,
  next_offset   INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS agentic_transcript_chunk (
  stream        TEXT NOT NULL,
  chunk_offset  INTEGER NOT NULL,
  chunk         TEXT NOT NULL,
  appended_at   TEXT NOT NULL,
  PRIMARY KEY (stream, chunk_offset)
);
CREATE INDEX IF NOT EXISTS idx_agentic_transcript_stream_retention ON agentic_transcript_stream (lifecycle, status, completed_at);
