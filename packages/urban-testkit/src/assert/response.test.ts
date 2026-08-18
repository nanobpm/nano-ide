// Red/Green coverage for `assertThatResponse` — each matcher (`hasStatus`,
// `hasJson`, `hasHeader`) is proven to PASS on its positive case and FAIL (throw
// an `AssertionError`) on its negative case. The exhaustive matcher cases run
// against constructed `ApiResponse` values (the matcher is a pure, synchronous
// function of an already-resolved response); one integration case boots a REAL
// app and asserts on a genuinely-driven operation response (JSON body + headers).

import { test } from "node:test";
import assert from "node:assert";
import { AssertionError } from "node:assert";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bootTestApp } from "../boot-app.ts";
import type { ApiResponse } from "../openapi-driver.ts";
import { assertThatResponse } from "./response.ts";

function makeResponse<T>(parts: {
  status?: number;
  headers?: Record<string, string>;
  text?: string;
  body: T;
}): ApiResponse<T> {
  return {
    status: parts.status ?? 200,
    headers: new Headers(parts.headers ?? {}),
    text: parts.text ?? "",
    body: parts.body,
  };
}

test("assertThatResponse().hasStatus passes on the exact code and fails otherwise", () => {
  const res = makeResponse({ status: 200, body: { ok: true } });
  // GREEN
  assertThatResponse(res).hasStatus(200);
  // RED
  assert.throws(
    () => assertThatResponse(res).hasStatus(404),
    (err: unknown) =>
      err instanceof AssertionError && /hasStatus/.test(err.message) && /got 200/.test(err.message),
  );
});

test("assertThatResponse().hasJson passes on a subset match and fails otherwise", () => {
  const res = makeResponse({ body: { id: 1, item: "widget", tags: ["a", "b"], nested: { k: 1 } } });
  // GREEN: every key/value in the subset is present and deep-equal; extra keys ignored.
  assertThatResponse(res).hasJson({ item: "widget", nested: { k: 1 } });
  // RED: a value differs.
  assert.throws(
    () => assertThatResponse(res).hasJson({ item: "gadget" }),
    (err: unknown) => err instanceof AssertionError && /hasJson/.test(err.message),
  );
});

test("assertThatResponse().hasHeader passes when present / equal and fails when absent / different", () => {
  const res = makeResponse({
    headers: { "content-type": "application/json", "x-order-id": "ord-42" },
    body: {},
  });
  // GREEN: presence-only, and value equality (header name is case-insensitive via Headers).
  assertThatResponse(res).hasHeader("x-order-id");
  assertThatResponse(res).hasHeader("X-Order-Id", "ord-42");
  assertThatResponse(res).hasHeader("Content-Type", "application/json");

  // RED: header absent.
  assert.throws(
    () => assertThatResponse(res).hasHeader("x-missing"),
    (err: unknown) => err instanceof AssertionError && /to be present/.test(err.message),
  );
  // RED: header present but value differs.
  assert.throws(
    () => assertThatResponse(res).hasHeader("x-order-id", "ord-99"),
    (err: unknown) =>
      err instanceof AssertionError && /hasHeader/.test(err.message) && /ord-99/.test(err.message),
  );
});

test("assertThatResponse() matchers chain synchronously", () => {
  const res = makeResponse({
    status: 201,
    headers: { "x-order-id": "ord-1" },
    body: { item: "widget" },
  });
  assertThatResponse(res).hasStatus(201).hasJson({ item: "widget" }).hasHeader("x-order-id", "ord-1");
});

// --- integration: assert on a REAL operation response driven through the app ---

const ORDER_BPMN = `<?xml version="1.0" encoding="UTF-8"?>
<definitions xmlns="http://www.omg.org/spec/BPMN/20100524/MODEL"
             targetNamespace="http://nanobpm/testkit">
  <process id="order" isExecutable="true">
    <startEvent id="s"/>
    <sequenceFlow id="f" sourceRef="s" targetRef="e"/>
    <endEvent id="e"/>
  </process>
</definitions>`;

const CREATE_ORDER = `export default async ({ body }) => {
  const item = String((body && body.item) || "").trim();
  if (!item) return { status: 400, body: { error: "item is required" } };
  return { status: 201, headers: { "x-order-id": "ord-42" }, body: { id: 42, item } };
};`;

function openApiDoc(): unknown {
  return {
    openapi: "3.0.3",
    info: { title: "Testkit Response Fixture", version: "1.0.0" },
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
          responses: { "201": { description: "created" }, "400": { description: "bad request" } },
        },
      },
    },
  };
}

async function makeApiFixture(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "urban-testkit-res-"));
  await mkdir(join(dir, "processes"), { recursive: true });
  await mkdir(join(dir, "operations"), { recursive: true });
  await writeFile(join(dir, "processes", "order.bpmn"), ORDER_BPMN);
  await writeFile(join(dir, "operations", "createOrder.ts"), CREATE_ORDER);
  await writeFile(join(dir, "openapi.json"), JSON.stringify(openApiDoc(), null, 2));
  const manifest = {
    schemaVersion: 1,
    id: "testkit-response-fixture",
    name: "Testkit Response Fixture",
    models: { processes: ["processes/*.bpmn"] },
    api: { spec: "openapi.json", dir: "operations", validateResponses: "never" },
  };
  await writeFile(join(dir, "nano.app.json"), JSON.stringify(manifest, null, 2));
  return dir;
}

test("assertThatResponse() on a real driven operation response (status + JSON + headers)", async () => {
  const dir = await makeApiFixture();
  const app = await bootTestApp(dir);
  try {
    assert.ok(app.api, "the fixture binds an OpenAPI api surface");
    const res = await app.api.call<{ id: number; item: string }>("createOrder", {
      body: { item: "widget" },
    });
    // The genuinely-driven response carries the operation's status, its JSON body,
    // the runtime's content-type header, and the operation's own custom header.
    assertThatResponse(res)
      .hasStatus(201)
      .hasJson({ item: "widget", id: 42 })
      .hasHeader("content-type", "application/json")
      .hasHeader("x-order-id", "ord-42");

    // RED against the real response too, so the integration path can genuinely fail.
    assert.throws(
      () => assertThatResponse(res).hasStatus(200),
      (err: unknown) => err instanceof AssertionError,
    );
  } finally {
    await app.stop();
    await rm(dir, { recursive: true, force: true });
  }
});
