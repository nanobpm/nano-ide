-- 003_agentic_blackboard.sql — S7 (Nano agentic protocol, ADR 0056, issue #133).
--
-- Forward-only, additive migration: the blackboard store backing the first-class
-- `blackboard` channel-message family. It promotes nano-workforce's per-plan
-- `plan_blackboard` HTTP hook to a capability-scoped channel family — the same
-- idempotent append (`dedupe_key`), file-claim conflict reporting, and
-- `since`/cursor incremental reads — generalised from a hard-wired `plan_key` to
-- a `scope` derived from the connection's capability credential, so any Urban app
-- gets it for free.
--
-- This migration MIRRORS the canonical blackboard DDL — `BLACKBOARD_SCHEMA_SQL`
-- in @nanobpm/agentic-blackboard's `schema.ts`, which is the single source of
-- truth and is applied by BlackboardStore.ensureSchema(). The app applies this
-- identical statement set on boot via the DataLayer migration runner. A drift-
-- guard test (schema.test.ts) fails if the two ever diverge — edit the canonical
-- schema.ts and update this mirror together.
--
-- Migration numbering (a shared epic surface): three slices in this epic add
-- migrations — S2 presence (001), S6 transcript (002) and this one. They are
-- sequenced into distinct waves so their branches each fork off an epic where the
-- prior migration has already landed; this slice is held until BOTH S2 and S6 have
-- merged, so it simply takes the next free prefix (003) after them. Do NOT reuse
-- or renumber an existing migration. Expand-and-contract: additive only, no drops.
CREATE TABLE IF NOT EXISTS agentic_blackboard (
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
CREATE UNIQUE INDEX IF NOT EXISTS ux_agentic_blackboard_dedupe ON agentic_blackboard (scope, dedupe_key) WHERE dedupe_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_agentic_blackboard_scope ON agentic_blackboard (scope, id);
