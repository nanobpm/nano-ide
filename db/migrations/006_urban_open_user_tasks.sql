-- 006_urban_open_user_tasks.sql — the canonical "open user tasks" engine-truth projection (ADR 0065).
--
-- Forward-only, additive migration: the framework projection of which process instances are currently
-- parked on a human (their open, CREATED-state user tasks). It is populated idempotently from engine
-- truth (`openUserTasks` / `searchUserTasks({state:"CREATED"})`) by the per-source sidecar, and it
-- absorbs nano-workforce's hand-rolled `user_tasks` table: it is the ONE authoritative source a read
-- model `EXISTS`-derives the "waiting-on-human" status edge from, instead of an app storing it.
--
-- This migration MIRRORS the canonical DDL — `OPEN_USER_TASKS_SCHEMA_SQL` in
-- `packages/urban/src/runtime/core/modules/open-user-tasks-store.ts`, the single source of truth
-- applied by `OpenUserTasksStore.ensureSchema()`. A drift-guard test (open-user-tasks-store.test.ts)
-- fails if the two ever diverge — edit the canonical schema and update this mirror together.
--
-- Framework bookkeeping, so `_urban_`-prefixed to stay hidden from the domain model / DB Manager
-- (like the lineage/migrations tables). Keyed by `user_task_key` so a re-record is idempotent; the
-- `process_instance_key` index scopes a correlated `EXISTS(... WHERE process_instance_key = …)` read.
-- Numbering takes the next free prefix (006) after 001–005.
CREATE TABLE IF NOT EXISTS _urban_open_user_tasks (
  process_instance_key TEXT NOT NULL,
  user_task_key        TEXT NOT NULL,
  element_id           TEXT,
  created_at           TEXT NOT NULL,
  PRIMARY KEY (user_task_key)
);
CREATE INDEX IF NOT EXISTS idx__urban_open_user_tasks_instance ON _urban_open_user_tasks (process_instance_key);
