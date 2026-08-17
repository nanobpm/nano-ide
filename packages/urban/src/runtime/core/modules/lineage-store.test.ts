import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createNodeHost } from "../../adapters/node.ts";
import type { SqliteDb } from "../host.ts";
import { makeGateway } from "./gateway.ts";
import {
  LINEAGE_ATTACHMENTS_TABLE,
  LINEAGE_EDGES_TABLE,
  LINEAGE_SCHEMA_SQL,
  LineageStore,
} from "./lineage-store.ts";

async function withStore(fn: (store: LineageStore, db: SqliteDb) => void | Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "urban-lineage-"));
  const host = createNodeHost({ cwd: dir, log: () => {} });
  const db = host.openSqlite(join(dir, "test.db"));
  const store = new LineageStore(db, { clock: { now: () => 0 } });
  store.ensureSchema();
  try {
    await fn(store, db);
  } finally {
    db.close();
    await rm(dir, { recursive: true, force: true });
  }
}

function normaliseSql(sql: string): string {
  return sql
    .split("\n")
    .map((line) => line.replace(/--.*$/, ""))
    .join("\n")
    .replace(/\s+/g, " ")
    .trim();
}

const migrationPath = fileURLToPath(new URL("../../../../../../db/migrations/004_urban_lineage.sql", import.meta.url));

test("the lineage projection tables are framework bookkeeping — `_urban_`-prefixed and hidden from the domain model", async () => {
  // The gateway hides `_urban_%` / `_nano_%` tables from the domain model / DB Manager. These
  // projection tables are framework sidecars (not user/domain tables), so their names MUST carry
  // that prefix or they would leak into apps' schemas.
  assert.match(LINEAGE_EDGES_TABLE, /^_urban_/, "lineage edge table must be `_urban_`-prefixed to stay hidden");
  assert.match(LINEAGE_ATTACHMENTS_TABLE, /^_urban_/, "lineage attachment table must be `_urban_`-prefixed to stay hidden");
  await withStore(async (_store, db) => {
    const surfaced = (await makeGateway(db).schema()).map((t) => t.name);
    assert.ok(!surfaced.includes(LINEAGE_EDGES_TABLE), "lineage edge table must not surface in the domain model");
    assert.ok(!surfaced.includes(LINEAGE_ATTACHMENTS_TABLE), "lineage attachment table must not surface in the domain model");
  });
});

test("the boot migration and LineageStore's DDL do not drift", () => {
  const migrationSql = readFileSync(migrationPath, "utf8");
  assert.equal(
    normaliseSql(migrationSql),
    normaliseSql(LINEAGE_SCHEMA_SQL),
    "db/migrations/004_urban_lineage.sql must match LINEAGE_SCHEMA_SQL — update both together",
  );
});

test("the boot migration is forward-only and additive (IF NOT EXISTS, no drops/alters)", () => {
  const migrationSql = readFileSync(migrationPath, "utf8");
  assert.match(migrationSql, /CREATE TABLE IF NOT EXISTS _urban_lineage_edges/);
  assert.match(migrationSql, /CREATE TABLE IF NOT EXISTS _urban_lineage_attachments/);
  assert.doesNotMatch(migrationSql, /\bDROP\b/i);
  assert.doesNotMatch(migrationSql, /\bALTER\b/i);
  // Numbering is a shared surface; guard the prefix so a rebase renumber is caught here.
  assert.match(migrationPath, /[/\\]004_urban_lineage\.sql$/);
});

test("ensureSchema creates both lineage tables idempotently", async () => {
  await withStore((store, db) => {
    store.ensureSchema();
    store.ensureSchema();
    const tables = db
      .all<{ name: string }>("SELECT name FROM sqlite_master WHERE type='table' AND name IN (?, ?)", [
        LINEAGE_EDGES_TABLE,
        LINEAGE_ATTACHMENTS_TABLE,
      ])
      .map((r) => r.name)
      .sort();
    assert.deepEqual(tables, [LINEAGE_ATTACHMENTS_TABLE, LINEAGE_EDGES_TABLE].sort());
  });
});

test("recordEdge is idempotent (a re-record of the same node/edge-type is a no-op)", async () => {
  await withStore((store) => {
    const edge = {
      rootRequestKey: "root",
      instanceKey: "child",
      causedByInstanceKey: "root",
      edgeType: "weak" as const,
    };
    assert.equal(store.recordEdge(edge), true);
    assert.equal(store.recordEdge(edge), false, "re-record collapses to a no-op");
    assert.equal(store.edges("root").length, 1);
  });
});

test("recordEnvelope records the weak edge carried by an instance's _urban.lineage", async () => {
  await withStore((store) => {
    const recorded = store.recordEnvelope("child", {
      _urban: { lineage: { rootRequestKey: "root", causedByInstanceKey: "root" } },
    });
    assert.equal(recorded, true);
    assert.deepEqual(store.edges("root"), [
      { rootRequestKey: "root", instanceKey: "child", causedByInstanceKey: "root", edgeType: "weak" },
    ]);
    // No envelope → nothing recorded.
    assert.equal(store.recordEnvelope("x", { plain: 1 }), false);
  });
});

test("recordFromJob records both the weak envelope edge and the strong execution edge (#808)", async () => {
  await withStore((store) => {
    store.recordFromJob({
      processInstanceKey: "child",
      parentProcessInstanceKey: "parent",
      variables: { _urban: { lineage: { rootRequestKey: "root", causedByInstanceKey: "cause" } } },
    });
    const edges = store.edges("root");
    assert.equal(edges.length, 2);
    const strong = edges.find((e) => e.edgeType === "strong");
    assert.deepEqual(strong, {
      rootRequestKey: "root",
      instanceKey: "child",
      causedByInstanceKey: "parent",
      edgeType: "strong",
    });
    // getLineage unions them: the strong execution edge wins for the node.
    const tree = store.getLineage("root");
    const node = tree.nodes.find((n) => n.instanceKey === "child");
    assert.equal(node?.edgeType, "strong");
  });
});

test("attach hangs an app domain row off a node, idempotently, and getLineage returns it", async () => {
  await withStore((store) => {
    store.recordEnvelope("child", { _urban: { lineage: { rootRequestKey: "root", causedByInstanceKey: "root" } } });
    assert.equal(store.attach("root", { nodeKey: "child", kind: "pull_request", ref: "o/r#7", label: "PR 7" }), true);
    assert.equal(store.attach("root", { nodeKey: "child", kind: "pull_request", ref: "o/r#7", label: "PR 7" }), false);
    const tree = store.getLineage("root");
    const child = tree.root.children[0];
    assert.equal(child.instanceKey, "child");
    assert.deepEqual(child.attachments, [{ nodeKey: "child", kind: "pull_request", ref: "o/r#7", label: "PR 7" }]);
  });
});

test("getLineage returns the full descendant tree keyed by rootRequestKey", async () => {
  await withStore((store) => {
    // A root fans out to two children; one child spawns a grandchild.
    store.recordEdge({ rootRequestKey: "root", instanceKey: "root", edgeType: "weak" });
    store.recordEnvelope("c1", { _urban: { lineage: { rootRequestKey: "root", causedByInstanceKey: "root" } } });
    store.recordEnvelope("c2", { _urban: { lineage: { rootRequestKey: "root", causedByInstanceKey: "root" } } });
    store.recordEnvelope("g1", { _urban: { lineage: { rootRequestKey: "root", causedByInstanceKey: "c1" } } });

    const tree = store.getLineage("root");
    assert.equal(tree.rootRequestKey, "root");
    assert.equal(tree.root.instanceKey, "root");
    assert.deepEqual(tree.root.children.map((c) => c.instanceKey).sort(), ["c1", "c2"]);
    const c1 = tree.root.children.find((c) => c.instanceKey === "c1");
    assert.deepEqual(c1?.children.map((c) => c.instanceKey), ["g1"]);
  });
});

test("getLineage returns a lone-root tree for a root with no recorded descendants", async () => {
  await withStore((store) => {
    const tree = store.getLineage("unknown-root");
    assert.equal(tree.root.instanceKey, "unknown-root");
    assert.deepEqual(tree.root.children, []);
    assert.equal(tree.nodes.length, 1);
  });
});
