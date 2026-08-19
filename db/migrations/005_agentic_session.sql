-- 005_agentic_session.sql — ADR 0062 slice 1 (durable agent-session resume,
-- issue nanobpm/nano-ide#365).
--
-- Forward-only, additive migration: the authoritative per-activation session log
-- backing the @nanobpm/agentic/session contract. It PROMOTES the advisory relay
-- substrate (ADR 0056 §12: bounded replay ring + generation/incarnation fencing,
-- and the S6 transcript's retention-by-lifecycle) into an authoritative log the
-- mind tap appends to, checkpoints join to a push boundary, and a re-leased
-- incarnation restores from.
--
-- This migration MIRRORS the canonical session DDL — `SESSION_SCHEMA_SQL` in
-- @nanobpm/agentic/session's `schema.ts`, which is the single source of truth and
-- is applied by SqliteSessionLog.ensureSchema(). The app applies this identical
-- statement set on boot via the DataLayer migration runner. A drift-guard test
-- (session/schema.test.ts) fails if the two ever diverge — edit the canonical
-- schema.ts and update this mirror together.
--
-- Migration numbering (a shared epic surface): this takes the next free prefix
-- (005) after 004_urban_lineage.sql. Expand-and-contract: additive only, no drops.
CREATE TABLE IF NOT EXISTS agentic_session_log (
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
CREATE TABLE IF NOT EXISTS agentic_session_event (
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
CREATE TABLE IF NOT EXISTS agentic_session_checkpoint (
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
CREATE INDEX IF NOT EXISTS idx_agentic_session_checkpoint_offset ON agentic_session_checkpoint (process_instance_key, element_id, checkpoint_offset);
CREATE INDEX IF NOT EXISTS idx_agentic_session_log_retention ON agentic_session_log (lifecycle, status, completed_at);
