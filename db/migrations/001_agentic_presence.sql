-- 001_agentic_presence.sql — S2 (Nano agentic protocol, ADR 0056, issue #128).
--
-- Forward-only, additive migration: the presence & registry table backing the
-- REGISTER/heartbeat/deregister family. A worker that registers over the agentic
-- channel appears here with its presence + host/family capability, its liveness
-- (`last_seen`) refreshed on every heartbeat, and ages out on the presence TTL.
--
-- This migration MIRRORS the canonical presence DDL — `PRESENCE_SCHEMA_SQL` in
-- @nanobpm/agentic-presence's `schema.ts`, which is the single source of truth
-- and is applied by PresenceStore.ensureSchema(). The app applies this identical
-- statement set on boot via the DataLayer migration runner. A drift-guard test
-- (schema.test.ts) fails if the two ever diverge — edit the canonical schema.ts
-- and update this mirror together.
--
-- Expand-and-contract: additive only. Later epic slices that add migrations
-- (S6 transcript store #132, S7 blackboard #133) are sequenced into later waves
-- and take the next free prefix after this one.
CREATE TABLE IF NOT EXISTS agentic_presence (
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
CREATE INDEX IF NOT EXISTS idx_agentic_presence_last_seen ON agentic_presence (last_seen);
CREATE INDEX IF NOT EXISTS idx_agentic_presence_connection ON agentic_presence (connection_id);
