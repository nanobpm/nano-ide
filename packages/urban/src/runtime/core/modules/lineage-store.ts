// lineage-store — the durable read-model projection behind the lineage primitive (issue #254).
//
// A framework-level, per-source sidecar (like the write-provenance table) that materialises the
// lineage edges the SDK auto-threads (`_urban.lineage`) and — where the engine emits it — the
// native execution edge (`parentProcessInstanceKey`, Magikcraft/nano-bpm#808). `getLineage(root)`
// unions both and returns the stitched descendant tree for one root request. Apps attach their own
// domain rows (PRs, tasks) to a node via {@link LineageStore.attach} WITHOUT the framework knowing
// their schema — the extension point that lets intent→progress visualisation be app-agnostic.
//
// The tree assembly itself is the pure {@link buildLineageTree}; this store is only its thin,
// idempotent persistence + query layer, so recording the same instance twice (an engine job
// re-activation) collapses to a no-op.

import type { SqliteDb } from "../host.ts";
import {
  buildLineageTree,
  type LineageAttachment,
  type LineageEdge,
  type LineageEdgeType,
  type LineageTree,
  readLineage,
} from "../lineage.ts";

/** The lineage edge table name. */
export const LINEAGE_EDGES_TABLE = "urban_lineage_edges";
/** The lineage attachment table name (app-registered domain rows on a node). */
export const LINEAGE_ATTACHMENTS_TABLE = "urban_lineage_attachments";

/**
 * The canonical lineage DDL — the single source of truth applied by
 * {@link LineageStore.ensureSchema}, mirrored verbatim by the boot migration
 * `db/migrations/004_urban_lineage.sql` (a drift-guard test asserts they match).
 *
 * Forward-only and additive. `urban_lineage_edges` is keyed by `(instance_key, edge_type)` so a
 * node can hold both its weak (envelope) and strong (execution) edge at once and a re-record is a
 * no-op; `urban_lineage_attachments` is keyed by `(node_key, kind, ref)` so re-attaching the same
 * domain row is idempotent. Both carry `root_request_key` with an index so a `getLineage(root)`
 * reads only that thread.
 */
export const LINEAGE_SCHEMA_SQL = `CREATE TABLE IF NOT EXISTS ${LINEAGE_EDGES_TABLE} (
  root_request_key       TEXT NOT NULL,
  instance_key           TEXT NOT NULL,
  caused_by_instance_key TEXT,
  edge_type              TEXT NOT NULL DEFAULT 'weak',
  created_at             TEXT NOT NULL,
  PRIMARY KEY (instance_key, edge_type)
);
CREATE INDEX IF NOT EXISTS idx_${LINEAGE_EDGES_TABLE}_root ON ${LINEAGE_EDGES_TABLE} (root_request_key);
CREATE TABLE IF NOT EXISTS ${LINEAGE_ATTACHMENTS_TABLE} (
  root_request_key TEXT NOT NULL,
  node_key         TEXT NOT NULL,
  kind             TEXT NOT NULL,
  ref              TEXT NOT NULL,
  label            TEXT,
  created_at       TEXT NOT NULL,
  PRIMARY KEY (node_key, kind, ref)
);
CREATE INDEX IF NOT EXISTS idx_${LINEAGE_ATTACHMENTS_TABLE}_root ON ${LINEAGE_ATTACHMENTS_TABLE} (root_request_key);`;

/** A monotonic wall clock, injectable for deterministic `created_at` in tests. */
export interface Clock {
  now(): number;
}

/** The default clock: `Date.now()`. */
export const systemClock: Clock = { now: () => Date.now() };

/** A minimal job shape {@link LineageStore.recordFromJob} reads — a structural subset of the
 *  runtime's `EngineJob` plus the future engine execution edge (`parentProcessInstanceKey`,
 *  Magikcraft/nano-bpm#808), consumed as a strong edge where present. */
export interface LineageJobLike {
  readonly processInstanceKey?: string;
  readonly variables?: Record<string, unknown>;
  /** The engine-native execution parent, when the engine emits it (#808). */
  readonly parentProcessInstanceKey?: string;
}

export interface LineageStoreOptions {
  readonly clock?: Clock;
}

interface EdgeRow {
  root_request_key: string;
  instance_key: string;
  caused_by_instance_key: string | null;
  edge_type: string;
}

interface AttachmentRow {
  root_request_key: string;
  node_key: string;
  kind: string;
  ref: string;
  label: string | null;
}

function normalizeEdgeType(raw: string): LineageEdgeType {
  return raw === "strong" ? "strong" : "weak";
}

export class LineageStore {
  readonly #db: SqliteDb;
  readonly #clock: Clock;

  constructor(db: SqliteDb, options: LineageStoreOptions = {}) {
    this.#db = db;
    this.#clock = options.clock ?? systemClock;
  }

  /** Apply the canonical lineage DDL (idempotent). Callers whose app DataLayer applies the boot
   *  migration `db/migrations/004_urban_lineage.sql` do not need this; the runtime calls it so the
   *  store is usable against a bare source too. The DDL is identical to the migration (drift-guarded). */
  ensureSchema(): void {
    this.#db.exec(LINEAGE_SCHEMA_SQL);
  }

  /**
   * Record one lineage edge, idempotently. A re-record of the same `(instance_key, edge_type)` is a
   * no-op (an engine may re-activate a job on retry), so recording is safe to drive from any
   * at-least-once observation point. A blank `rootRequestKey` or `instanceKey` is ignored.
   */
  recordEdge(edge: LineageEdge): boolean {
    if (!edge.rootRequestKey || !edge.instanceKey) return false;
    const { changes } = this.#db.run(
      `INSERT OR IGNORE INTO ${LINEAGE_EDGES_TABLE}
         (root_request_key, instance_key, caused_by_instance_key, edge_type, created_at)
       VALUES (?, ?, ?, ?, ?)`,
      [
        edge.rootRequestKey,
        edge.instanceKey,
        edge.causedByInstanceKey ?? null,
        edge.edgeType,
        new Date(this.#clock.now()).toISOString(),
      ],
    );
    return changes > 0;
  }

  /**
   * Record the WEAK edge carried by an instance's `_urban.lineage` envelope. `instanceKey` is the
   * effect/descendant node (a created instance's returned key, or a running job's own instance).
   * A no-op when the variables carry no valid envelope.
   */
  recordEnvelope(instanceKey: string | undefined, variables: unknown): boolean {
    if (!instanceKey) return false;
    const env = readLineage(variables);
    if (!env) return false;
    return this.recordEdge({
      rootRequestKey: env.rootRequestKey,
      instanceKey,
      causedByInstanceKey: env.causedByInstanceKey,
      edgeType: "weak",
    });
  }

  /**
   * Record every edge an activated job reveals about its own instance: the weak envelope edge, and
   * — where the engine supplies `parentProcessInstanceKey` (#808) — the strong execution edge under
   * the same root. The natural single observation point for the worker runtime, since every instance
   * that does work activates a job carrying its envelope. Never throws for a malformed job.
   */
  recordFromJob(job: LineageJobLike): void {
    const env = readLineage(job.variables);
    if (!env || !job.processInstanceKey) return;
    this.recordEnvelope(job.processInstanceKey, job.variables);
    if (job.parentProcessInstanceKey) {
      this.recordEdge({
        rootRequestKey: env.rootRequestKey,
        instanceKey: job.processInstanceKey,
        causedByInstanceKey: job.parentProcessInstanceKey,
        edgeType: "strong",
      });
    }
  }

  /**
   * Attach an app-defined domain row to a lineage node, idempotently. The framework stores it
   * opaquely by `(node_key, kind, ref)` — it never interprets the app's schema. This is the
   * extension point that lets an app hang its PRs/tasks off the lineage tree.
   */
  attach(rootRequestKey: string, attachment: LineageAttachment): boolean {
    if (!rootRequestKey || !attachment.nodeKey || !attachment.kind || !attachment.ref) return false;
    const { changes } = this.#db.run(
      `INSERT OR IGNORE INTO ${LINEAGE_ATTACHMENTS_TABLE}
         (root_request_key, node_key, kind, ref, label, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        rootRequestKey,
        attachment.nodeKey,
        attachment.kind,
        attachment.ref,
        attachment.label ?? null,
        new Date(this.#clock.now()).toISOString(),
      ],
    );
    return changes > 0;
  }

  /** The persisted edges for one root, in insertion order. */
  edges(rootRequestKey: string): LineageEdge[] {
    const rows = this.#db.all<EdgeRow>(
      `SELECT root_request_key, instance_key, caused_by_instance_key, edge_type
         FROM ${LINEAGE_EDGES_TABLE} WHERE root_request_key = ? ORDER BY rowid`,
      [rootRequestKey],
    );
    return rows.map((r) => ({
      rootRequestKey: r.root_request_key,
      instanceKey: r.instance_key,
      causedByInstanceKey: r.caused_by_instance_key ?? undefined,
      edgeType: normalizeEdgeType(r.edge_type),
    }));
  }

  /** The persisted attachments for one root, in insertion order. */
  attachments(rootRequestKey: string): LineageAttachment[] {
    const rows = this.#db.all<AttachmentRow>(
      `SELECT root_request_key, node_key, kind, ref, label
         FROM ${LINEAGE_ATTACHMENTS_TABLE} WHERE root_request_key = ? ORDER BY rowid`,
      [rootRequestKey],
    );
    return rows.map((r) => ({
      nodeKey: r.node_key,
      kind: r.kind,
      ref: r.ref,
      ...(r.label ? { label: r.label } : {}),
    }));
  }

  /**
   * The stitched descendant tree for `rootRequestKey`, unioning the weak (envelope) and strong
   * (engine execution) edges and hanging each app attachment off its node. The generic read
   * surface any Urban app queries for intent→progress.
   */
  getLineage(rootRequestKey: string): LineageTree {
    return buildLineageTree(rootRequestKey, this.edges(rootRequestKey), this.attachments(rootRequestKey));
  }
}
