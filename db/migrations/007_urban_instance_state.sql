-- 007_urban_instance_state.sql — the canonical per-instance engine lifecycle-state projection (ADR 0065).
--
-- Forward-only, additive migration: the framework projection of each tracked process instance's
-- engine-truth lifecycle state (ACTIVE / COMPLETED / TERMINATED) plus whether it is waiting on a
-- human. Populated idempotently from engine truth (`searchProcessInstances` / `openUserTasks`) by the
-- per-source sidecar, so a read model can DERIVE an instance's status edge (e.g. the terminal
-- `abandoned` edge) purely from this projection instead of storing a `status` that tears from truth.
--
-- This migration MIRRORS the canonical DDL — `INSTANCE_STATE_SCHEMA_SQL` in
-- `packages/urban/src/runtime/core/modules/instance-state-store.ts`, the single source of truth
-- applied by `InstanceStateStore.ensureSchema()`. A drift-guard test (instance-state-store.test.ts)
-- fails if the two ever diverge — edit the canonical schema and update this mirror together.
--
-- Framework bookkeeping, so `_urban_`-prefixed to stay hidden from the domain model / DB Manager
-- (like the lineage/migrations tables). Keyed by `process_instance_key` (one canonical state per
-- instance) so a re-record upserts in place and is idempotent. `waiting_on_human` is 0/1 (SQLite has
-- no boolean). Numbering takes the next free prefix (007) after 001–006.
CREATE TABLE IF NOT EXISTS _urban_instance_state (
  process_instance_key TEXT NOT NULL,
  state                TEXT NOT NULL,
  waiting_on_human     INTEGER NOT NULL DEFAULT 0,
  updated_at           TEXT NOT NULL,
  PRIMARY KEY (process_instance_key)
);
