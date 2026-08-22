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
  INSTANCE_STATE_PROJECTION,
  INSTANCE_STATE_SCHEMA_SQL,
  INSTANCE_STATE_TABLE,
  InstanceStateStore,
} from "./instance-state-store.ts";

async function withStore(fn: (store: InstanceStateStore, db: SqliteDb) => void | Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "urban-instance-state-"));
  const host = createNodeHost({ cwd: dir, log: () => {} });
  const db = host.openSqlite(join(dir, "test.db"));
  const store = new InstanceStateStore(db, { clock: { now: () => 0 } });
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

const migrationPath = fileURLToPath(
  new URL("../../../../../../db/migrations/007_urban_instance_state.sql", import.meta.url),
);

test("the instance-state projection table is framework bookkeeping — `_urban_`-prefixed and hidden from the domain model", async () => {
  assert.match(INSTANCE_STATE_TABLE, /^_urban_/, "projection table must be `_urban_`-prefixed to stay hidden");
  await withStore(async (_store, db) => {
    const surfaced = (await makeGateway(db).schema()).map((t) => t.name);
    assert.ok(!surfaced.includes(INSTANCE_STATE_TABLE), "projection table must not surface in the domain model");
  });
});

test("the boot migration and InstanceStateStore's DDL do not drift", () => {
  const migrationSql = readFileSync(migrationPath, "utf8");
  assert.equal(
    normaliseSql(migrationSql),
    normaliseSql(INSTANCE_STATE_SCHEMA_SQL),
    "db/migrations/007_urban_instance_state.sql must match INSTANCE_STATE_SCHEMA_SQL — update both together",
  );
});

test("the boot migration is forward-only and additive (IF NOT EXISTS, no drops/alters)", () => {
  const migrationSql = readFileSync(migrationPath, "utf8");
  assert.match(migrationSql, /CREATE TABLE IF NOT EXISTS _urban_instance_state/);
  assert.doesNotMatch(migrationSql, /\bDROP\b/i);
  assert.doesNotMatch(migrationSql, /\bALTER\b/i);
  assert.match(migrationPath, /[/\\]007_urban_instance_state\.sql$/);
});

test("ensureSchema creates the projection table idempotently", async () => {
  await withStore((store, db) => {
    store.ensureSchema();
    store.ensureSchema();
    const tables = db
      .all<{ name: string }>("SELECT name FROM sqlite_master WHERE type='table' AND name = ?", [INSTANCE_STATE_TABLE])
      .map((r) => r.name);
    assert.deepEqual(tables, [INSTANCE_STATE_TABLE]);
  });
});

test("recordState upserts one canonical state per instance and is idempotent", async () => {
  await withStore((store) => {
    assert.equal(store.recordState("pi-1", "ACTIVE"), true);
    assert.equal(store.recordState("pi-1", "ACTIVE"), false, "re-record of the same state is a no-op");
    assert.deepEqual(store.getState("pi-1"), {
      processInstanceKey: "pi-1",
      state: "ACTIVE",
      waitingOnHuman: false,
    });

    // A lifecycle transition upserts in place (still one row).
    assert.equal(store.recordState("pi-1", "TERMINATED"), true);
    assert.deepEqual(store.getState("pi-1"), {
      processInstanceKey: "pi-1",
      state: "TERMINATED",
      waitingOnHuman: false,
    });
    assert.equal(store.recordState("", "ACTIVE"), false, "blank instance key is ignored");
  });
});

test("recordState tracks the waiting-on-human flag", async () => {
  await withStore((store) => {
    store.recordState("pi-1", "ACTIVE", true);
    assert.equal(store.getState("pi-1")?.waitingOnHuman, true);
    // Flipping only the flag (state unchanged) is a real change.
    assert.equal(store.recordState("pi-1", "ACTIVE", false), true);
    assert.equal(store.getState("pi-1")?.waitingOnHuman, false);
  });
});

test("recordFromSnapshot records from an engine ProcessInstanceSnapshot", async () => {
  await withStore((store) => {
    store.recordFromSnapshot({ processInstanceKey: "pi-9", state: "COMPLETED" });
    assert.deepEqual(store.getState("pi-9"), {
      processInstanceKey: "pi-9",
      state: "COMPLETED",
      waitingOnHuman: false,
    });
  });
});

test("getState returns undefined for an unrecorded instance", async () => {
  await withStore((store) => {
    assert.equal(store.getState("unknown"), undefined);
  });
});

test("the DSL projection name is stable and unprefixed (usable in `exists(...)`)", () => {
  assert.equal(INSTANCE_STATE_PROJECTION, "urban_instance_state");
});
