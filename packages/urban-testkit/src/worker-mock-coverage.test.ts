// e2e coverage for the S4 mock↔coverage-gate interplay (epic #296).
//
// A mocked worker is still a DECLARED worker (`manifest.workers[].taskType`), so it must not
// become a silently-hidden coverage gap. This proves the honest contract:
//   • a mocked-but-exercised worker counts toward coverage (assertFullCoverage passes) AND is
//     flagged `SurfaceReport.mocked` so a reader sees the coverage came via a mock, not real code;
//   • a declared worker that is never exercised at all is still a RED gap (mocking is opt-in and
//     never hides a genuinely un-driven worker).

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

// A real handler that would explode if actually run — proving the mock stood in for it.
const HANDLERS = `export const handlers = {
  "order.pack": async () => { throw new Error("real order.pack must not run when mocked"); },
};`;

const MIGRATION = `CREATE TABLE orders (id INTEGER PRIMARY KEY, item TEXT, status TEXT);`;

const CREATE_ORDER = `export default async ({ body }, app) => {
  const item = String((body && body.item) || "").trim();
  if (!item) return { status: 400, body: { error: "item is required" } };
  await app.data.table("orders", "item").insert({ item, status: "active" });
  await app.engine.createInstance({ processDefinitionId: "order", variables: { item } });
  return { status: 202, body: { item } };
};`;

const OPENAPI = {
  openapi: "3.0.3",
  info: { title: "Mock Coverage Fixture", version: "1.0.0" },
  paths: {
    "/orders": {
      post: {
        operationId: "createOrder",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { type: "object", properties: { item: { type: "string" } }, required: ["item"] },
            },
          },
        },
        responses: { "202": { description: "started" } },
      },
    },
  },
};

/** A minimal app with one operation (`createOrder`) and one worker (`order.pack`). */
async function makeFixture(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "urban-testkit-mockcov-"));
  await mkdir(join(dir, "processes"), { recursive: true });
  await mkdir(join(dir, "workers"), { recursive: true });
  await mkdir(join(dir, "operations"), { recursive: true });
  await mkdir(join(dir, "db", "migrations"), { recursive: true });
  await writeFile(join(dir, "processes", "order.bpmn"), ORDER_BPMN);
  await writeFile(join(dir, "workers", "handlers.ts"), HANDLERS);
  await writeFile(join(dir, "operations", "createOrder.ts"), CREATE_ORDER);
  await writeFile(join(dir, "db", "migrations", "001_init.sql"), MIGRATION);
  await writeFile(join(dir, "openapi.json"), JSON.stringify(OPENAPI, null, 2));
  const manifest = {
    schemaVersion: 1,
    id: "testkit-mockcov-fixture",
    name: "Testkit Mock Coverage Fixture",
    models: { processes: ["processes/*.bpmn"] },
    data: {
      default: "app",
      sources: { app: { driver: "sqlite", url: "file:./db/app.db", migrations: "db/migrations" } },
    },
    workers: [{ taskType: "order.pack", handler: "workers/handlers.ts" }],
    api: { spec: "openapi.json", dir: "operations", validateResponses: "never" },
  };
  await writeFile(join(dir, "nano.app.json"), JSON.stringify(manifest, null, 2));
  return dir;
}

test("mock+coverage: a mocked-but-exercised worker counts toward coverage AND is flagged as mocked", async () => {
  const dir = await makeFixture();
  const app = await bootTestApp(dir, { coverage: true });
  try {
    assert.ok(app.api && app.coverage);
    // Mock the worker so the (exploding) real handler never runs.
    app.mockWorker("order.pack").completeWith({ packed: true, via: "mock" });

    // Drive createOrder → starts the `order` process → the mocked `order.pack` job is dispatched.
    const created = await app.api.call<{ item: string }>("createOrder", { body: { item: "widget" } });
    assert.equal(created.status, 202, "the real handler would have thrown; the mock stood in");

    const report = app.coverage.report();
    const workers = report.surfaces.find((s) => s.surface === "workers");
    assert.ok(workers);
    assert.deepEqual(workers.declared, ["order.pack"], "the worker is still a declared surface element");
    assert.deepEqual(workers.exercised, ["order.pack"], "a mocked dispatch still counts as exercised — no hidden gap");
    assert.deepEqual(workers.missing, [], "nothing declared is un-exercised");
    assert.deepEqual(workers.mocked, ["order.pack"], "the coverage is honestly flagged as mock-satisfied");
    assert.equal(workers.complete, true);

    // The gate passes for the workers surface: a mocked, exercised worker is not a gap.
    app.coverage.assertFullCoverage({ surfaces: ["workers"] });
  } finally {
    await app.stop();
    await rm(dir, { recursive: true, force: true });
  }
});

test("mock+coverage: a declared worker never exercised at all is still a RED gap (mocking hides nothing)", async () => {
  const dir = await makeFixture();
  const app = await bootTestApp(dir, { coverage: true });
  try {
    assert.ok(app.coverage);
    // Register a mock but never dispatch anything to it — the worker is declared yet never exercised.
    app.mockWorker("order.pack").completeWith({ packed: true });

    const report = app.coverage.report();
    const workers = report.surfaces.find((s) => s.surface === "workers");
    assert.deepEqual(workers?.exercised, [], "nothing was dispatched");
    assert.deepEqual(workers?.missing, ["order.pack"], "the un-driven worker is a genuine gap");
    assert.deepEqual(workers?.mocked, [], "a never-dispatched mock does not fabricate coverage");
    assert.throws(
      () => app.coverage?.assertFullCoverage({ surfaces: ["workers"] }),
      /Coverage incomplete/,
      "merely registering a mock must not satisfy the gate",
    );
  } finally {
    await app.stop();
    await rm(dir, { recursive: true, force: true });
  }
});
