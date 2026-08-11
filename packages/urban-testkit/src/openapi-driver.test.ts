// e2e + unit coverage for the S3 spec-driven HTTP operations driver (issue #157).
//
// The driver reads the booted app's OWN OpenAPI document and lets a test call operations by
// `operationId` — never a hard-coded route. These tests boot a real Urban app with an `api` binding
// (both a JSON and a YAML spec, since a real app like nano-workforce authors `openapi.yaml`), drive
// its operations end-to-end (HTTP → operation delegate → engine + SQLite), and pin the driver's
// pure enumeration/error surfaces.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stringify as toYaml } from "yaml";
import { bootTestApp } from "./boot-app.ts";
import { collectOperations, parseOpenApi } from "./openapi-driver.ts";

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
    // Project onto the business row the operation inserted before starting us (keyed by \`item\`),
    // stamping the process key. The WASM engine drives this worker synchronously within
    // createInstance, so the operation must insert the row FIRST — exactly as a real app does.
    await app.data.table("orders", "item").update(String(job.variables.item), {
      process_key: String(job.processInstanceKey),
      status: "packed",
    });
    return { packed: true };
  },
};`;

const MIGRATION = `CREATE TABLE orders (
  id INTEGER PRIMARY KEY,
  item TEXT,
  process_key TEXT,
  status TEXT
);`;

// A start operation: FLAT body (no engine "variables" envelope), inserts the business row FIRST,
// then starts the \`order\` process — the ADR-0058/0059 "one door" pattern nano-workforce's
// startConvergenceLoop uses (insert the aggregate row, then create the instance). Returns 202.
const CREATE_ORDER = `export default async ({ body }, app) => {
  const item = String((body && body.item) || "").trim();
  if (!item) return { status: 400, body: { error: "item is required" } };
  await app.data.table("orders", "item").insert({ item, process_key: null, status: "active" });
  const { processInstanceKey } = await app.engine.createInstance({
    processDefinitionId: "order",
    variables: { item },
  });
  return { status: 202, body: { processInstanceKey: String(processInstanceKey), item } };
};`;

// A read operation with a PATH parameter — exercises template filling.
const GET_ORDER = `export default async ({ params }, app) => {
  const row = await app.data.table("orders", "item").findOne({ item: params.item });
  if (!row) return { status: 404, body: { error: "not found" } };
  return { status: 200, body: row };
};`;

function openApiDoc(): unknown {
  const orderSchema = {
    type: "object",
    properties: {
      id: { type: "integer" },
      process_key: { type: "string" },
      item: { type: "string" },
      status: { type: "string" },
    },
  };
  return {
    openapi: "3.0.3",
    info: { title: "Testkit API Fixture", version: "1.0.0" },
    paths: {
      "/orders": {
        post: {
          operationId: "createOrder",
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: { item: { type: "string" } },
                  required: ["item"],
                },
              },
            },
          },
          responses: {
            "202": {
              description: "started",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: { processInstanceKey: { type: "string" }, item: { type: "string" } },
                  },
                },
              },
            },
            "400": { description: "bad request" },
          },
        },
      },
      "/orders/{item}": {
        get: {
          operationId: "getOrder",
          parameters: [{ name: "item", in: "path", required: true, schema: { type: "string" } }],
          responses: {
            "200": {
              description: "the order",
              content: { "application/json": { schema: orderSchema } },
            },
            "404": { description: "not found" },
          },
        },
      },
    },
  };
}

/** Build a fixture app whose HTTP surface is an OpenAPI `api` binding. `specFile` selects the spec
 *  format written to disk (`openapi.json` or `openapi.yaml`) so both parser paths are exercised. */
async function makeApiFixture(specFile: "openapi.json" | "openapi.yaml"): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "urban-testkit-api-"));
  await mkdir(join(dir, "processes"), { recursive: true });
  await mkdir(join(dir, "workers"), { recursive: true });
  await mkdir(join(dir, "operations"), { recursive: true });
  await mkdir(join(dir, "db", "migrations"), { recursive: true });
  await writeFile(join(dir, "processes", "order.bpmn"), ORDER_BPMN);
  await writeFile(join(dir, "workers", "handlers.ts"), HANDLERS);
  await writeFile(join(dir, "operations", "createOrder.ts"), CREATE_ORDER);
  await writeFile(join(dir, "operations", "getOrder.ts"), GET_ORDER);
  await writeFile(join(dir, "db", "migrations", "001_init.sql"), MIGRATION);
  const doc = openApiDoc();
  await writeFile(join(dir, specFile), specFile.endsWith(".yaml") ? toYaml(doc) : JSON.stringify(doc, null, 2));
  const manifest = {
    schemaVersion: 1,
    id: "testkit-api-fixture",
    name: "Testkit API Fixture",
    models: { processes: ["processes/*.bpmn"] },
    data: {
      default: "app",
      sources: { app: { driver: "sqlite", url: "file:./db/app.db", migrations: "db/migrations" } },
    },
    workers: [{ taskType: "order.pack", handler: "workers/handlers.ts" }],
    api: { spec: specFile, dir: "operations", validateResponses: "never" },
  };
  await writeFile(join(dir, "nano.app.json"), JSON.stringify(manifest, null, 2));
  return dir;
}

test("api driver: enumerates the app's operations from its own spec", async () => {
  const dir = await makeApiFixture("openapi.json");
  const app = await bootTestApp(dir);
  try {
    assert.ok(app.api, "an app with an `api` binding exposes the driver");
    assert.deepEqual(app.api.operationIds().sort(), ["createOrder", "getOrder"]);
    const getOrder = app.api.operation("getOrder");
    assert.equal(getOrder?.method, "get");
    assert.deepEqual(getOrder?.pathParams, ["item"]);
  } finally {
    await app.stop();
    await rm(dir, { recursive: true, force: true });
  }
});

test("api driver: call(operationId) drives HTTP → operation → engine + SQLite", async () => {
  const dir = await makeApiFixture("openapi.json");
  const app = await bootTestApp(dir);
  try {
    assert.ok(app.api);
    // POST createOrder: JSON body is serialized, /app/api base + path are derived from the spec.
    // The operation inserts the row, then starts the process; the WASM engine drives the service
    // task's worker synchronously within createInstance, so the projection is already applied here.
    const created = await app.api.call<{ processInstanceKey: string; item: string }>("createOrder", {
      body: { item: "widget" },
    });
    assert.equal(created.status, 202);
    assert.equal(created.body.item, "widget");
    const key = created.body.processInstanceKey;
    assert.ok(key, "the operation returned the started instance key");

    // GET getOrder with a PATH parameter — the driver fills `{item}` from `params`.
    const fetched = await app.api.call<{ status: string; item: string; process_key: string }>(
      "getOrder",
      { params: { item: "widget" } },
    );
    assert.equal(fetched.status, 200);
    assert.equal(fetched.body.item, "widget");
    assert.equal(fetched.body.status, "packed", "worker projection is visible through the operation");
    assert.equal(fetched.body.process_key, key, "worker stamped the started instance's key");
  } finally {
    await app.stop();
    await rm(dir, { recursive: true, force: true });
  }
});

test("api driver: a request-validation failure surfaces as the operation's own error", async () => {
  const dir = await makeApiFixture("openapi.json");
  const app = await bootTestApp(dir);
  try {
    assert.ok(app.api);
    // `item` is required by both the schema and the delegate; an empty item is a 400, not a throw.
    const res = await app.api.call<{ error: string }>("createOrder", { body: { item: "" } });
    assert.ok(res.status === 400, `empty item rejected (status ${res.status})`);
  } finally {
    await app.stop();
    await rm(dir, { recursive: true, force: true });
  }
});

test("api driver: unknown operationId and missing path param throw a test-bug error", async () => {
  const dir = await makeApiFixture("openapi.json");
  const app = await bootTestApp(dir);
  try {
    assert.ok(app.api);
    await assert.rejects(() => app.api!.call("noSuchOp"), /unknown operationId "noSuchOp"/);
    await assert.rejects(() => app.api!.call("getOrder", {}), /missing path parameter "item"/);
  } finally {
    await app.stop();
    await rm(dir, { recursive: true, force: true });
  }
});

test("api driver: parses a YAML spec (openapi.yaml), matching real-app authoring", async () => {
  const dir = await makeApiFixture("openapi.yaml");
  const app = await bootTestApp(dir);
  try {
    assert.ok(app.api, "a YAML-spec app still exposes the driver");
    assert.deepEqual(app.api.operationIds().sort(), ["createOrder", "getOrder"]);
    const created = await app.api.call<{ processInstanceKey: string }>("createOrder", {
      body: { item: "gadget" },
    });
    assert.equal(created.status, 202);
    assert.ok(created.body.processInstanceKey);
  } finally {
    await app.stop();
    await rm(dir, { recursive: true, force: true });
  }
});

test("api driver: callRoute drives a raw path and parses the JSON response", async () => {
  const dir = await makeApiFixture("openapi.json");
  const app = await bootTestApp(dir);
  try {
    // callRoute takes an EXACT path (no /app/api base added) — here the operation's full route.
    const res = await app.callRoute<{ error: string }>({
      method: "POST",
      path: "/app/api/orders",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ item: "" }),
    });
    assert.equal(res.status, 400);
    assert.equal(res.body.error, "item is required");
  } finally {
    await app.stop();
    await rm(dir, { recursive: true, force: true });
  }
});

test("api driver: absent when the app declares no `api` binding, but callRoute still works", async () => {
  const dir = await mkdtemp(join(tmpdir(), "urban-testkit-noapi-"));
  await mkdir(join(dir, "processes"), { recursive: true });
  await writeFile(join(dir, "processes", "order.bpmn"), ORDER_BPMN);
  const manifest = {
    schemaVersion: 1,
    id: "testkit-noapi-fixture",
    name: "No API",
    models: { processes: ["processes/*.bpmn"] },
    triggers: [
      { id: "h", type: "webhook", path: "/hooks/order", action: { start: "order", variables: "= body" } },
    ],
  };
  await writeFile(join(dir, "nano.app.json"), JSON.stringify(manifest, null, 2));
  const app = await bootTestApp(dir);
  try {
    assert.equal(app.api, undefined, "no `api` binding → no driver");
    const res = await app.callRoute({
      method: "POST",
      path: "/hooks/order",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ item: "x" }),
    });
    assert.ok((res.status ?? 200) < 300, "callRoute still drives raw routes without an api binding");
  } finally {
    await app.stop();
    await rm(dir, { recursive: true, force: true });
  }
});

// --- pure-function coverage (no boot): the enumerator + parser, the driver's source of truth. ---

test("collectOperations: enumerates operationId/method/path and path params, sorted", () => {
  const ops = collectOperations(openApiDoc());
  assert.deepEqual(
    ops.map((o) => `${o.method} ${o.path} ${o.operationId}`),
    ["post /orders createOrder", "get /orders/{item} getOrder"],
  );
  assert.deepEqual(ops.find((o) => o.operationId === "getOrder")?.pathParams, ["item"]);
});

test("collectOperations: skips operations without an operationId and non-object paths", () => {
  const ops = collectOperations({
    paths: {
      "/a": { get: { operationId: "a" }, post: { summary: "no id" } },
      "/b": "not an object",
    },
  });
  assert.deepEqual(ops.map((o) => o.operationId), ["a"]);
});

test("parseOpenApi: reads JSON and YAML, and throws a clear error on garbage", () => {
  const readOpenApiVersion = (doc: unknown): unknown =>
    doc !== null && typeof doc === "object" ? Reflect.get(doc, "openapi") : undefined;
  assert.equal(readOpenApiVersion(parseOpenApi('{"openapi":"3.0.3"}')), "3.0.3");
  assert.equal(readOpenApiVersion(parseOpenApi("openapi: 3.0.3")), "3.0.3");
  assert.throws(() => parseOpenApi("{ this: is: not: valid"), /not valid JSON or YAML/);
});
