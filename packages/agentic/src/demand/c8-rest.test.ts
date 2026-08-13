import assert from "node:assert/strict";
import { test } from "node:test";

import { httpC8RestReader, readDeployedTaskDefinitions, readDeployedTaskTypes, type FetchLike } from "./c8-rest.ts";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function xmlFor(taskType: string): string {
  return `<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" xmlns:zeebe="http://camunda.org/schema/zeebe/1.0">
    <bpmn:process id="proc-${taskType}">
      <bpmn:serviceTask id="t"><zeebe:taskDefinition type="${taskType}" /></bpmn:serviceTask>
    </bpmn:process>
  </bpmn:definitions>`;
}

function jsonResponse(body: unknown): Awaited<ReturnType<FetchLike>> {
  return {
    ok: true,
    status: 200,
    statusText: "OK",
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

function textResponse(text: string): Awaited<ReturnType<FetchLike>> {
  return {
    ok: true,
    status: 200,
    statusText: "OK",
    json: async () => JSON.parse(text),
    text: async () => text,
  };
}

test("reads deployed taskDefinition leaves over the C8 v2 REST API", async () => {
  const calls: string[] = [];
  const fetch: FetchLike = async (input, init) => {
    calls.push(`${init?.method ?? "GET"} ${input}`);
    if (input.endsWith("/process-definitions/search")) {
      return jsonResponse({ items: [{ processDefinitionKey: "111" }, { processDefinitionKey: 222 }] });
    }
    if (input.endsWith("/process-definitions/111/xml")) return textResponse(xmlFor("planning.planner"));
    if (input.endsWith("/process-definitions/222/xml")) return textResponse(xmlFor("qa.tester"));
    throw new Error(`unexpected call ${input}`);
  };

  const reader = httpC8RestReader({ restAddress: "http://engine:8080/v2/", fetch });
  const leaves = await readDeployedTaskDefinitions(reader);

  assert.deepEqual(
    leaves.map((l) => l.taskType),
    ["planning.planner", "qa.tester"],
  );
  // Trailing slash on restAddress is normalised (no double slash).
  assert.ok(calls.includes("POST http://engine:8080/v2/process-definitions/search"));
  // Numeric keys are coerced to strings for the XML path.
  assert.ok(calls.includes("GET http://engine:8080/v2/process-definitions/222/xml"));
});

test("pages the definition search until a short page drains it", async () => {
  const pageOf = (from: number, limit: number): { processDefinitionKey: string }[] =>
    Array.from({ length: Math.max(0, Math.min(limit, 250 - from)) }, (_u, i) => ({
      processDefinitionKey: String(from + i),
    }));

  const seenPages: number[] = [];
  const fetch: FetchLike = async (input, init) => {
    if (input.endsWith("/process-definitions/search")) {
      const body: unknown = JSON.parse(init?.body ?? "{}");
      const page = isRecord(body) ? body.page : undefined;
      const from = isRecord(page) && typeof page.from === "number" ? page.from : 0;
      const limit = isRecord(page) && typeof page.limit === "number" ? page.limit : 100;
      seenPages.push(from);
      return jsonResponse({ items: pageOf(from, limit) });
    }
    return textResponse(xmlFor("ci.runner"));
  };

  const reader = httpC8RestReader({ restAddress: "http://engine:8080/v2", fetch, pageSize: 100 });
  const keys = await reader.searchProcessDefinitionKeys();

  assert.equal(keys.length, 250);
  assert.deepEqual(seenPages, [0, 100, 200]);
});

test("readDeployedTaskTypes returns the distinct demand set", async () => {
  const fetch: FetchLike = async (input) => {
    if (input.endsWith("/process-definitions/search")) {
      return jsonResponse({ items: [{ processDefinitionKey: "1" }, { processDefinitionKey: "2" }] });
    }
    return textResponse(xmlFor("planning.planner"));
  };
  const reader = httpC8RestReader({ restAddress: "http://x/v2", fetch });
  assert.deepEqual(await readDeployedTaskTypes(reader), ["planning.planner"]);
});

test("sends the bearer token when configured", async () => {
  let authHeader: string | undefined;
  const fetch: FetchLike = async (input, init) => {
    authHeader = init?.headers?.authorization;
    if (input.endsWith("/search")) return jsonResponse({ items: [] });
    return textResponse("");
  };
  const reader = httpC8RestReader({ restAddress: "http://x/v2", fetch, token: "secret" });
  await reader.searchProcessDefinitionKeys();
  assert.equal(authHeader, "Bearer secret");
});

test("a non-2xx search fails loudly rather than reporting zero demand", async () => {
  const fetch: FetchLike = async () => ({
    ok: false,
    status: 503,
    statusText: "Service Unavailable",
    json: async () => ({}),
    text: async () => "",
  });
  const reader = httpC8RestReader({ restAddress: "http://x/v2", fetch });
  await assert.rejects(() => reader.searchProcessDefinitionKeys(), /503 Service Unavailable/);
});

test("a non-2xx xml fetch fails loudly", async () => {
  const fetch: FetchLike = async (input) => {
    if (input.endsWith("/search")) return jsonResponse({ items: [{ processDefinitionKey: "1" }] });
    return { ok: false, status: 404, statusText: "Not Found", json: async () => ({}), text: async () => "" };
  };
  const reader = httpC8RestReader({ restAddress: "http://x/v2", fetch });
  await assert.rejects(() => readDeployedTaskDefinitions(reader), /404 Not Found/);
});

test("rejects a non-positive-integer pageSize instead of spinning forever", () => {
  const fetch: FetchLike = async () => jsonResponse({ items: [] });
  // pageSize is the loop's termination condition (items.length < pageSize); a
  // zero/negative/NaN/fractional value could never break, so reject it up front.
  for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, 1.5]) {
    assert.throws(() => httpC8RestReader({ restAddress: "http://x/v2", fetch, pageSize: bad }), /pageSize must be a positive integer/);
  }
});
