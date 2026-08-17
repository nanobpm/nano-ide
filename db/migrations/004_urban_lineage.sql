-- 004_urban_lineage.sql — the framework-level lineage primitive read-model (issue #254).
--
-- Forward-only, additive migration: the lineage projection tables backing the SDK's
-- `_urban.lineage` envelope + the generic `getLineage(rootRequestKey)` read surface. It lets
-- any Urban app stitch user intent → progress (a root request → the instances, PRs, tasks and
-- sub-loops it causes) without hand-rolling correlation.
--
-- This migration MIRRORS the canonical lineage DDL — `LINEAGE_SCHEMA_SQL` in
-- `packages/urban/src/runtime/core/modules/lineage-store.ts`, which is the single source of truth
-- applied by `LineageStore.ensureSchema()`. A drift-guard test (lineage-store.test.ts) fails if the
-- two ever diverge — edit the canonical schema and update this mirror together.
--
-- Two edge sources are unioned by the projection: the WEAK causal edge carried by the
-- `_urban.lineage` envelope, and — where the engine emits it — the STRONG execution edge
-- (`parentProcessInstanceKey`, Magikcraft/nano-bpm#808). The `(instance_key, edge_type)` primary
-- key holds both for one node and makes a re-record idempotent. Expand-and-contract: additive only,
-- no drops. Numbering takes the next free prefix (004) after 001/002/003.
CREATE TABLE IF NOT EXISTS _urban_lineage_edges (
  root_request_key       TEXT NOT NULL,
  instance_key           TEXT NOT NULL,
  caused_by_instance_key TEXT,
  edge_type              TEXT NOT NULL DEFAULT 'weak',
  created_at             TEXT NOT NULL,
  PRIMARY KEY (instance_key, edge_type)
);
CREATE INDEX IF NOT EXISTS idx__urban_lineage_edges_root ON _urban_lineage_edges (root_request_key);
CREATE TABLE IF NOT EXISTS _urban_lineage_attachments (
  root_request_key TEXT NOT NULL,
  node_key         TEXT NOT NULL,
  kind             TEXT NOT NULL,
  ref              TEXT NOT NULL,
  label            TEXT,
  created_at       TEXT NOT NULL,
  PRIMARY KEY (node_key, kind, ref)
);
CREATE INDEX IF NOT EXISTS idx__urban_lineage_attachments_root ON _urban_lineage_attachments (root_request_key);
