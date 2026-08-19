// Red/Green coverage for `assertThatDb` — each matcher (`hasRow`, `rowCount`,
// `isEmpty`) is proven to PASS on its positive case and FAIL (throw an
// `AssertionError`) on its negative case, driven against a REAL app booted with
// `bootTestApp` and its provisioned SQLite (`app.db`).

import { test } from "node:test";
import assert from "node:assert/strict";
import { AssertionError } from "node:assert";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bootTestApp, type TestApp } from "../boot-app.ts";
import { assertThatDb } from "./db.ts";

const ORDER_BPMN = `<?xml version="1.0" encoding="UTF-8"?>
<definitions xmlns="http://www.omg.org/spec/BPMN/20100524/MODEL"
             targetNamespace="http://nanobpm/testkit">
  <process id="order" isExecutable="true">
    <startEvent id="s"/>
    <sequenceFlow id="f" sourceRef="s" targetRef="e"/>
    <endEvent id="e"/>
  </process>
</definitions>`;

const MIGRATION = `CREATE TABLE orders (
  id INTEGER PRIMARY KEY,
  item TEXT,
  status TEXT
);
CREATE TABLE audit (
  id INTEGER PRIMARY KEY,
  entry TEXT
);`;

async function makeFixture(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "urban-testkit-db-"));
  await mkdir(join(dir, "processes"), { recursive: true });
  await mkdir(join(dir, "db", "migrations"), { recursive: true });
  await writeFile(join(dir, "processes", "order.bpmn"), ORDER_BPMN);
  await writeFile(join(dir, "db", "migrations", "001_init.sql"), MIGRATION);
  const manifest = {
    schemaVersion: 1,
    id: "testkit-db-fixture",
    name: "Testkit DB Fixture",
    models: { processes: ["processes/*.bpmn"] },
    data: {
      default: "app",
      sources: { app: { driver: "sqlite", url: "file:./db/app.db", migrations: "db/migrations" } },
    },
  };
  await writeFile(join(dir, "nano.app.json"), JSON.stringify(manifest, null, 2));
  return dir;
}

/** Boot the fixture, seed two `orders` rows (leaving `audit` empty), run `body`, then tear down. */
async function withApp(body: (app: TestApp) => Promise<void>): Promise<void> {
  const dir = await makeFixture();
  const app = await bootTestApp(dir);
  try {
    const orders = app.db.table<{ item: string; status: string }>("orders");
    await orders.insert({ item: "widget", status: "packed" });
    await orders.insert({ item: "gadget", status: "active" });
    await body(app);
  } finally {
    await app.stop();
    await rm(dir, { recursive: true, force: true });
  }
}

test("assertThatDb().hasRow passes on a matching subset and fails otherwise", async () => {
  await withApp(async (app) => {
    // GREEN: a row whose columns are a superset of the subset matches.
    await assertThatDb(app).table("orders").hasRow({ item: "widget", status: "packed" });
    await assertThatDb(app).table("orders").hasRow({ status: "active" });

    // RED: no row has this combination.
    await assert.rejects(
      () => assertThatDb(app).table("orders").hasRow({ item: "widget", status: "active" }),
      (err: unknown) => err instanceof AssertionError && /hasRow/.test(err.message),
    );
  });
});

test("assertThatDb().rowCount passes on the exact count and fails otherwise", async () => {
  await withApp(async (app) => {
    // GREEN
    await assertThatDb(app).table("orders").rowCount(2);
    // RED
    await assert.rejects(
      () => assertThatDb(app).table("orders").rowCount(5),
      (err: unknown) =>
        err instanceof AssertionError && /rowCount/.test(err.message) && /found 2/.test(err.message),
    );
  });
});

test("assertThatDb().isEmpty passes on an empty table and fails on a populated one", async () => {
  await withApp(async (app) => {
    // GREEN: nothing was seeded into `audit`.
    await assertThatDb(app).table("audit").isEmpty();
    // RED: `orders` has rows.
    await assert.rejects(
      () => assertThatDb(app).table("orders").isEmpty(),
      (err: unknown) => err instanceof AssertionError && /isEmpty/.test(err.message),
    );
  });
});

test("assertThatDb() matchers chain via await", async () => {
  await withApp(async (app) => {
    const table = assertThatDb(app).table("orders");
    await (await (await table.rowCount(2)).hasRow({ item: "gadget" })).hasRow({ item: "widget" });
  });
});
