import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createNodeHost } from "../../adapters/node.ts";
import type { SqliteDb } from "../host.ts";
import type { UserTaskSummary } from "../host.ts";
import { makeGateway } from "./gateway.ts";
import {
  OPEN_USER_TASKS_PROJECTION,
  OPEN_USER_TASKS_SCHEMA_SQL,
  OPEN_USER_TASKS_TABLE,
  OpenUserTasksStore,
} from "./open-user-tasks-store.ts";

async function withStore(fn: (store: OpenUserTasksStore, db: SqliteDb) => void | Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "urban-open-tasks-"));
  const host = createNodeHost({ cwd: dir, log: () => {} });
  const db = host.openSqlite(join(dir, "test.db"));
  const store = new OpenUserTasksStore(db, { clock: { now: () => 0 } });
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

const task = (userTaskKey: string, elementId?: string): UserTaskSummary => ({ userTaskKey, elementId });

const migrationPath = fileURLToPath(
  new URL("../../../../../../db/migrations/006_urban_open_user_tasks.sql", import.meta.url),
);

test("the open-user-tasks projection table is framework bookkeeping — `_urban_`-prefixed and hidden from the domain model", async () => {
  assert.match(OPEN_USER_TASKS_TABLE, /^_urban_/, "projection table must be `_urban_`-prefixed to stay hidden");
  await withStore(async (_store, db) => {
    const surfaced = (await makeGateway(db).schema()).map((t) => t.name);
    assert.ok(!surfaced.includes(OPEN_USER_TASKS_TABLE), "projection table must not surface in the domain model");
  });
});

test("the boot migration and OpenUserTasksStore's DDL do not drift", () => {
  const migrationSql = readFileSync(migrationPath, "utf8");
  assert.equal(
    normaliseSql(migrationSql),
    normaliseSql(OPEN_USER_TASKS_SCHEMA_SQL),
    "db/migrations/006_urban_open_user_tasks.sql must match OPEN_USER_TASKS_SCHEMA_SQL — update both together",
  );
});

test("the boot migration is forward-only and additive (IF NOT EXISTS, no drops/alters)", () => {
  const migrationSql = readFileSync(migrationPath, "utf8");
  assert.match(migrationSql, /CREATE TABLE IF NOT EXISTS _urban_open_user_tasks/);
  assert.doesNotMatch(migrationSql, /\bDROP\b/i);
  assert.doesNotMatch(migrationSql, /\bALTER\b/i);
  assert.match(migrationPath, /[/\\]006_urban_open_user_tasks\.sql$/);
});

test("ensureSchema creates the projection table idempotently", async () => {
  await withStore((store, db) => {
    store.ensureSchema();
    store.ensureSchema();
    const tables = db
      .all<{ name: string }>("SELECT name FROM sqlite_master WHERE type='table' AND name = ?", [OPEN_USER_TASKS_TABLE])
      .map((r) => r.name);
    assert.deepEqual(tables, [OPEN_USER_TASKS_TABLE]);
  });
});

test("recordOpenTask is idempotent (a re-record of the same user task is a no-op)", async () => {
  await withStore((store) => {
    assert.equal(store.recordOpenTask("pi-1", task("ut-1", "Approve")), true);
    assert.equal(store.recordOpenTask("pi-1", task("ut-1", "Approve")), false, "re-record collapses to a no-op");
    assert.equal(store.openTasks("pi-1").length, 1);
    assert.equal(store.recordOpenTask("", task("ut-x")), false, "blank instance key is ignored");
    assert.equal(store.recordOpenTask("pi-1", task("")), false, "blank user task key is ignored");
  });
});

test("syncInstance makes the projection reflect the engine's CURRENT open set (retiring closed tasks)", async () => {
  await withStore((store) => {
    // Two open tasks initially.
    store.syncInstance("pi-1", [task("ut-1", "Approve"), task("ut-2", "Review")]);
    assert.deepEqual(store.openTasks("pi-1").map((t) => t.userTaskKey).sort(), ["ut-1", "ut-2"]);
    assert.equal(store.hasOpenTask("pi-1"), true);

    // ut-1 answered/closed, a new ut-3 created → engine now reports {ut-2, ut-3}.
    store.syncInstance("pi-1", [task("ut-2", "Review"), task("ut-3", "Sign")]);
    assert.deepEqual(store.openTasks("pi-1").map((t) => t.userTaskKey).sort(), ["ut-2", "ut-3"]);

    // All answered → no open tasks: the instance is no longer parked on a human (nano-workforce#422).
    store.syncInstance("pi-1", []);
    assert.equal(store.hasOpenTask("pi-1"), false);
    assert.deepEqual(store.openTasks("pi-1"), []);
  });
});

test("syncInstance is idempotent and scoped to one instance", async () => {
  await withStore((store) => {
    store.syncInstance("pi-1", [task("ut-1")]);
    store.syncInstance("pi-2", [task("ut-2")]);
    // Re-syncing pi-1's unchanged open set must not touch pi-2.
    store.syncInstance("pi-1", [task("ut-1")]);
    assert.deepEqual(store.openTasks("pi-1").map((t) => t.userTaskKey), ["ut-1"]);
    assert.deepEqual(store.openTasks("pi-2").map((t) => t.userTaskKey), ["ut-2"]);
  });
});

test("clearInstance retires every open task for an instance", async () => {
  await withStore((store) => {
    store.syncInstance("pi-1", [task("ut-1"), task("ut-2")]);
    store.clearInstance("pi-1");
    assert.equal(store.hasOpenTask("pi-1"), false);
  });
});

test("syncInstance is atomic — it composes inside an existing transaction and rolls back on failure", async () => {
  await withStore((store, db) => {
    // Composes inside an outer transaction (SAVEPOINT, not BEGIN): the whole replace commits as one unit.
    db.exec("BEGIN");
    store.syncInstance("pi-1", [task("ut-1"), task("ut-2")]);
    db.exec("COMMIT");
    assert.deepEqual(store.openTasks("pi-1").map((t) => t.userTaskKey).sort(), ["ut-1", "ut-2"]);

    // A failure mid-sync must roll the whole operation back, leaving the prior open set intact rather
    // than a torn partial state. A subclass that throws from recordOpenTask forces a mid-loop failure.
    const boom = new Error("boom");
    class ThrowingStore extends OpenUserTasksStore {
      override recordOpenTask(): boolean {
        throw boom;
      }
    }
    const broken = new ThrowingStore(db, { clock: { now: () => 0 } });
    assert.throws(() => broken.syncInstance("pi-1", [task("ut-9")]), boom);
    // The prior open set is unchanged — nothing was half-written or half-deleted.
    assert.deepEqual(store.openTasks("pi-1").map((t) => t.userTaskKey).sort(), ["ut-1", "ut-2"]);
  });
});

test("the DSL projection name is stable and unprefixed (usable in `exists(...)`)", () => {
  assert.equal(OPEN_USER_TASKS_PROJECTION, "urban_open_user_tasks");
});

test("instanceKeys returns each distinct instance with ≥1 open task (and drops one when cleared)", async () => {
  await withStore((store) => {
    assert.deepEqual(store.instanceKeys(), []); // empty projection
    store.syncInstance("pi-1", [task("ut-1"), task("ut-2")]); // two tasks, one instance
    store.syncInstance("pi-2", [task("ut-3")]);
    assert.deepEqual(store.instanceKeys().sort(), ["pi-1", "pi-2"]); // distinct, not per-task
    store.clearInstance("pi-1"); // answered/terminated
    assert.deepEqual(store.instanceKeys(), ["pi-2"]); // retired key no longer listed
  });
});
