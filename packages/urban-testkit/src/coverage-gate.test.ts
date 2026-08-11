// e2e coverage for the S4 coverage-exhaustive gate (issue #157; issue #189).
//
// Boots a real Urban app with `{ coverage: true }` and proves the gate:
//   • the declared surfaces are derived from the app's OWN manifest + spec (operations from
//     the OpenAPI document, workers from `manifest.workers[].taskType`) — no second list;
//   • exercising a subset leaves the gate RED, naming exactly the un-exercised elements;
//   • exercising the rest turns it GREEN.
// This is the Red/Green guard for "we forgot to test operation X" as a build failure.

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

const HANDLERS = `export const handlers = {
  "order.pack": async (job, app) => {
    await app.data.table("orders", "item").update(String(job.variables.item), { status: "packed" });
    return { packed: true };
  },
};`;

const MIGRATION = `CREATE TABLE orders (id INTEGER PRIMARY KEY, item TEXT, status TEXT);`;

const CREATE_ORDER = `export default async ({ body }, app) => {
  const item = String((body && body.item) || "").trim();
  if (!item) return { status: 400, body: { error: "item is required" } };
  await app.data.table("orders", "item").insert({ item, status: "active" });
  await app.engine.createInstance({ processDefinitionId: "order", variables: { item } });
  return { status: 202, body: { item } };
};`;

const GET_ORDER = `export default async ({ params }, app) => {
  const row = await app.data.table("orders", "item").findOne({ item: params.item });
  if (!row) return { status: 404, body: { error: "not found" } };
  return { status: 200, body: row };
};`;

const OPENAPI = {
  openapi: "3.0.3",
  info: { title: "Coverage Fixture", version: "1.0.0" },
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
    "/orders/{item}": {
      get: {
        operationId: "getOrder",
        parameters: [{ name: "item", in: "path", required: true, schema: { type: "string" } }],
        responses: { "200": { description: "ok" }, "404": { description: "missing" } },
      },
    },
  },
};

/** A minimal app with two operations (`createOrder`, `getOrder`) and one worker (`order.pack`). */
async function makeFixture(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "urban-testkit-coverage-"));
  await mkdir(join(dir, "processes"), { recursive: true });
  await mkdir(join(dir, "workers"), { recursive: true });
  await mkdir(join(dir, "operations"), { recursive: true });
  await mkdir(join(dir, "db", "migrations"), { recursive: true });
  await writeFile(join(dir, "processes", "order.bpmn"), ORDER_BPMN);
  await writeFile(join(dir, "workers", "handlers.ts"), HANDLERS);
  await writeFile(join(dir, "operations", "createOrder.ts"), CREATE_ORDER);
  await writeFile(join(dir, "operations", "getOrder.ts"), GET_ORDER);
  await writeFile(join(dir, "db", "migrations", "001_init.sql"), MIGRATION);
  await writeFile(join(dir, "openapi.json"), JSON.stringify(OPENAPI, null, 2));
  const manifest = {
    schemaVersion: 1,
    id: "testkit-coverage-fixture",
    name: "Testkit Coverage Fixture",
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

test("coverage: declares the app's surfaces from its own manifest + spec", async () => {
  const dir = await makeFixture();
  const app = await bootTestApp(dir, { coverage: true });
  try {
    assert.ok(app.coverage, "coverage:true exposes the gate");
    const report = app.coverage.report();
    const ops = report.surfaces.find((s) => s.surface === "operations");
    const workers = report.surfaces.find((s) => s.surface === "workers");
    assert.deepEqual(ops?.declared, ["createOrder", "getOrder"], "operations from the spec");
    assert.deepEqual(workers?.declared, ["order.pack"], "workers from the manifest");
    // Nothing exercised yet → the gate is red.
    assert.equal(report.complete, false);
    assert.throws(() => app.coverage?.assertFullCoverage(), /Coverage incomplete/);
  } finally {
    await app.stop();
    await rm(dir, { recursive: true, force: true });
  }
});

test("coverage: exercising a subset leaves the gate RED naming the gap, then GREEN once all are driven", async () => {
  const dir = await makeFixture();
  const app = await bootTestApp(dir, { coverage: true });
  try {
    assert.ok(app.api && app.coverage);

    // Drive createOrder — which starts the `order` process, whose service task runs the
    // `order.pack` worker synchronously. So this single call exercises BOTH the createOrder
    // operation AND the order.pack worker, but NOT the getOrder operation.
    const created = await app.api.call<{ item: string }>("createOrder", { body: { item: "widget" } });
    assert.equal(created.status, 202);

    const afterCreate = app.coverage.report();
    const ops = afterCreate.surfaces.find((s) => s.surface === "operations");
    const workers = afterCreate.surfaces.find((s) => s.surface === "workers");
    assert.deepEqual(ops?.exercised, ["createOrder"]);
    assert.deepEqual(ops?.missing, ["getOrder"], "getOrder not yet driven");
    assert.equal(workers?.complete, true, "the worker ran inside createInstance");

    // The gate fails, naming exactly the un-exercised operation (and NOT the covered worker surface).
    assert.throws(
      () => app.coverage?.assertFullCoverage(),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.match(err.message, /operations: 1 un-exercised → getOrder/);
        assert.doesNotMatch(err.message, /workers:/);
        return true;
      },
    );

    // Drive the remaining operation → full coverage, gate passes.
    const fetched = await app.api.call<{ status: string }>("getOrder", { params: { item: "widget" } });
    assert.equal(fetched.status, 200);
    assert.equal(app.coverage.report().complete, true);
    assert.doesNotThrow(() => app.coverage?.assertFullCoverage());
  } finally {
    await app.stop();
    await rm(dir, { recursive: true, force: true });
  }
});

test("coverage: an un-driven worker keeps the gate RED even when all operations are covered", async () => {
  const dir = await makeFixture();
  const app = await bootTestApp(dir, { coverage: true });
  try {
    assert.ok(app.api && app.coverage);
    // Call getOrder for a missing item (404): a read that touches neither the process nor the worker.
    const missing = await app.api.call("getOrder", { params: { item: "nope" } });
    assert.equal(missing.status, 404);
    // createOrder still un-driven AND order.pack never ran → both surfaces incomplete.
    assert.throws(
      () => app.coverage?.assertFullCoverage(),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.match(err.message, /operations: 1 un-exercised → createOrder/);
        assert.match(err.message, /workers: 1 un-exercised → order\.pack/);
        return true;
      },
    );
  } finally {
    await app.stop();
    await rm(dir, { recursive: true, force: true });
  }
});

test("coverage: off by default — app.coverage is undefined", async () => {
  const dir = await makeFixture();
  const app = await bootTestApp(dir);
  try {
    assert.equal(app.coverage, undefined, "no coverage overhead unless opted in");
  } finally {
    await app.stop();
    await rm(dir, { recursive: true, force: true });
  }
});
