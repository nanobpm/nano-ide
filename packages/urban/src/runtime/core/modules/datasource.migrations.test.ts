import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createNodeHost } from "../../adapters/node.ts";
import { provisionData } from "./datasource.ts";
import type { RuntimeContext } from "../context.ts";
import type { EngineClient } from "../host.ts";
import type { AppManifest } from "../manifest.ts";

// provisionData never touches the engine — a bare stub is enough for these datasource tests.
const noEngine: EngineClient = {
  deployResources: async () => ({ deployed: 0 }),
  createInstance: async () => ({ processInstanceKey: "pi" }),
  cancelInstance: async () => {},
  publishMessage: async () => {},
  searchUserTasks: async () => [],
  openUserTasks: async () => [],
  getForm: async () => null,
  completeUserTask: async () => {},
  searchProcessInstances: async () => [],
  registerWorker: async (jobType) => ({ jobType, unsubscribe: async () => {} }),
  close: async () => {},
};

async function fixture(migrations: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "urban-mig-"));
  await mkdir(join(dir, "db", "migrations"), { recursive: true });
  for (const [name, sql] of Object.entries(migrations)) {
    await writeFile(join(dir, "db", "migrations", name), sql);
  }
  return dir;
}

function ctx(dir: string): RuntimeContext {
  const manifest: AppManifest = {
    schemaVersion: 1,
    id: "mig-fixture",
    name: "Migration Fixture",
    data: {
      default: "app",
      sources: { app: { driver: "sqlite", url: "file:./app.db", migrations: "db/migrations" } },
    },
  };
  return { manifest, host: createNodeHost({ cwd: dir, log: () => {} }), engine: noEngine, root: "." };
}

function columns(dir: string, table: string): string[] {
  const db = createNodeHost({ cwd: dir, log: () => {} }).openSqlite(join(dir, "app.db"));
  try {
    return db.all<{ name: string }>(`PRAGMA table_info(${table})`).map((r) => r.name);
  } finally {
    db.close();
  }
}

function ledger(dir: string): string[] {
  const db = createNodeHost({ cwd: dir, log: () => {} }).openSqlite(join(dir, "app.db"));
  try {
    return db.all<{ name: string }>("SELECT name FROM _urban_migrations ORDER BY name").map((r) => r.name);
  } finally {
    db.close();
  }
}

test("migrations apply once and are skipped on the next boot (idempotent)", async () => {
  const dir = await fixture({
    "001_init.sql": "CREATE TABLE rounds (id INTEGER PRIMARY KEY, summary TEXT);",
    "002_transcript.sql": "ALTER TABLE rounds ADD COLUMN transcript TEXT;",
  });
  try {
    const first = await provisionData(ctx(dir));
    assert.deepEqual(first.source("app").migrationsApplied, ["001_init.sql", "002_transcript.sql"]);
    first.closeAll();

    assert.deepEqual(ledger(dir), ["001_init.sql", "002_transcript.sql"]);
    assert.ok(columns(dir, "rounds").includes("transcript"));

    // Second boot: everything is already recorded, so nothing re-runs (no "duplicate column").
    const second = await provisionData(ctx(dir));
    assert.deepEqual(second.source("app").migrationsApplied, []);
    second.closeAll();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a failing migration rolls back atomically — schema is never left ahead of the ledger", async () => {
  // Models the real urban-pr-review failure: an interrupted/failing migration must NOT leave a
  // column present while its `_urban_migrations` row is missing, or every future boot re-applies
  // it and dies with "duplicate column name". 002 adds `transcript`, then hits an error.
  const dir = await fixture({
    "001_init.sql": "CREATE TABLE rounds (id INTEGER PRIMARY KEY, summary TEXT);",
    "002_transcript.sql":
      "ALTER TABLE rounds ADD COLUMN transcript TEXT;\nINSERT INTO does_not_exist VALUES (1);",
  });
  try {
    await assert.rejects(
      provisionData(ctx(dir)),
      /migration "002_transcript.sql" failed and was rolled back/,
    );

    // The whole migration rolled back: 001 is applied, but 002 left NO trace.
    assert.deepEqual(ledger(dir), ["001_init.sql"]);
    assert.ok(
      !columns(dir, "rounds").includes("transcript"),
      "the partially-applied ALTER must have been rolled back",
    );

    // Repair the migration and re-boot: because the earlier attempt left no partial state,
    // `transcript` applies cleanly instead of colliding — the poisoned state can never arise.
    await writeFile(
      join(dir, "db", "migrations", "002_transcript.sql"),
      "ALTER TABLE rounds ADD COLUMN transcript TEXT;",
    );
    const repaired = await provisionData(ctx(dir));
    assert.deepEqual(repaired.source("app").migrationsApplied, ["002_transcript.sql"]);
    repaired.closeAll();

    assert.deepEqual(ledger(dir), ["001_init.sql", "002_transcript.sql"]);
    assert.ok(columns(dir, "rounds").includes("transcript"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
