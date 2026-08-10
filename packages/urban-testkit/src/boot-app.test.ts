// e2e coverage for `bootTestApp` (issue #157, S2). Boots a real Urban app in-process
// against the WASM engine + a virtual clock, and drives all four surfaces the harness
// exposes: HTTP/UI, workers, SQLite, and the instance-tracking reconciler.
//
// The reconciler case is the reason this kit exists: a cancelled instance is TERMINATED,
// and the poll loop must patch the tracking row. Here that whole loop runs deterministically
// — no 15s wall-clock wait, no flaky poll — because `advanceTime` drives the virtual clock.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bootTestApp } from "./boot-app.ts";

const ORDER_BPMN = `<?xml version="1.0" encoding="UTF-8"?>
<definitions xmlns="http://www.omg.org/spec/BPMN/20100524/MODEL"
             xmlns:zeebe="http://camunda.org/schema/zeebe/1.0"
             targetNamespace="http://nanobpm/testkit">
  <process id="order" isExecutable="true">
    <startEvent id="s"/>
    <sequenceFlow id="f1" sourceRef="s" targetRef="pack"/>
    <serviceTask id="pack">
      <extensionElements><zeebe:taskDefinition type="order.pack"/></extensionElements>
    </serviceTask>
    <sequenceFlow id="f2" sourceRef="pack" targetRef="e"/>
    <endEvent id="e"/>
  </process>
</definitions>`;

const REVIEW_BPMN = `<?xml version="1.0" encoding="UTF-8"?>
<definitions xmlns="http://www.omg.org/spec/BPMN/20100524/MODEL"
             xmlns:zeebe="http://camunda.org/schema/zeebe/1.0"
             targetNamespace="http://nanobpm/testkit">
  <process id="review" isExecutable="true">
    <startEvent id="s"/>
    <sequenceFlow id="f1" sourceRef="s" targetRef="approve"/>
    <userTask id="approve"><extensionElements><zeebe:userTask/></extensionElements></userTask>
    <sequenceFlow id="f2" sourceRef="approve" targetRef="e"/>
    <endEvent id="e"/>
  </process>
</definitions>`;

const HANDLERS = `export const handlers = {
  "order.pack": async (job, app) => {
    await app.data.table("orders", "process_key").insert({
      process_key: job.processInstanceKey,
      status: "packed",
      note: job.variables.orderId ?? null,
    });
    return { packed: true };
  },
};`;

const MIGRATION = `CREATE TABLE orders (
  id INTEGER PRIMARY KEY,
  process_key TEXT,
  status TEXT,
  note TEXT
);`;

/** Build a minimal but complete Urban app on disk: two processes, a worker, a SQLite
 *  source with one migration, a webhook that starts `order`, and an instanceTracking
 *  binding that abandons a tracked row when its instance terminates. */
async function makeFixture(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "urban-testkit-boot-"));
  await mkdir(join(dir, "processes"), { recursive: true });
  await mkdir(join(dir, "workers"), { recursive: true });
  await mkdir(join(dir, "db", "migrations"), { recursive: true });
  await writeFile(join(dir, "processes", "order.bpmn"), ORDER_BPMN);
  await writeFile(join(dir, "processes", "review.bpmn"), REVIEW_BPMN);
  await writeFile(join(dir, "workers", "handlers.ts"), HANDLERS);
  await writeFile(join(dir, "db", "migrations", "001_init.sql"), MIGRATION);
  const manifest = {
    schemaVersion: 1,
    id: "testkit-boot-fixture",
    name: "Testkit Boot Fixture",
    models: { processes: ["processes/*.bpmn"] },
    data: {
      default: "app",
      sources: { app: { driver: "sqlite", url: "file:./db/app.db", migrations: "db/migrations" } },
    },
    workers: [{ taskType: "order.pack", handler: "workers/handlers.ts" }],
    triggers: [
      {
        id: "order-hook",
        type: "webhook",
        path: "/hooks/order",
        action: { start: "order", variables: "= body" },
      },
    ],
    instanceTracking: [
      {
        table: "orders",
        keyField: "process_key",
        statusField: "status",
        activeStatuses: ["active"],
        onTerminated: { set: { status: "abandoned" } },
        pollMs: 1000,
      },
    ],
  };
  await writeFile(join(dir, "nano.app.json"), JSON.stringify(manifest, null, 2));
  return dir;
}

test("bootTestApp drives HTTP → worker → SQLite in-process and deterministically", async () => {
  const dir = await makeFixture();
  const app = await bootTestApp(dir);
  try {
    // HTTP surface: post to the webhook trigger, which starts the `order` process.
    const res = await app.ui.call({
      method: "POST",
      path: "/hooks/order",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ orderId: "ord-1" }),
    });
    assert.ok((res.status ?? 200) < 300, `webhook accepted (status ${res.status})`);

    // No worker has run yet at this instant — settle drains the engine's queued job.
    await app.settle();

    // SQLite surface: the worker's insert is now visible through the data layer.
    const orders = app.db.table<{ process_key: string; status: string; note: string }>(
      "orders",
      "process_key",
    );
    const rows = await orders.all();
    assert.equal(rows.length, 1, "one order row written by the worker");
    assert.equal(rows[0].status, "packed");
    assert.equal(rows[0].note, "ord-1", "worker projected the webhook body variable");
  } finally {
    await app.stop();
    await rm(dir, { recursive: true, force: true });
  }
});

test("bootTestApp stops the in-process server so routes are no longer callable", async () => {
  const dir = await makeFixture();
  const app = await bootTestApp(dir);
  await app.stop();
  await rm(dir, { recursive: true, force: true });
  await assert.rejects(
    () => app.ui.call({ method: "GET", path: "/hooks/order" }),
    /no router mounted/,
    "a stopped app's captured handler is cleared, so a route call throws",
  );
});

test("bootTestApp reconciles a terminated instance's tracking row on advanceTime", async () => {
  const dir = await makeFixture();
  const app = await bootTestApp(dir);
  try {
    // Start a long-running instance (parks at the user task → ACTIVE) and track it.
    const { processInstanceKey } = await app.engine.createInstance({ processDefinitionId: "review" });
    const orders = app.db.table<{ process_key: string; status: string }>("orders", "process_key");
    await orders.insert({ process_key: processInstanceKey, status: "active" });

    // Terminate it. The row is still "active" — the reconciler poll hasn't fired yet.
    await app.engine.cancelInstance({ processInstanceKey });
    let row = await orders.findOne({ process_key: processInstanceKey });
    assert.equal(row?.status, "active", "row not yet reconciled before any poll fires");

    // Advance past the poll interval: the reconciler observes TERMINATED and patches the row.
    await app.advanceTime(1000);
    row = await orders.findOne({ process_key: processInstanceKey });
    assert.equal(row?.status, "abandoned", "reconciler abandoned the terminated instance's row");
  } finally {
    await app.stop();
    await rm(dir, { recursive: true, force: true });
  }
});
