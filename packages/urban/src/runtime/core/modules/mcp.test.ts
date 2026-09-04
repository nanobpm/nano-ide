// Red/Green tests for the runtime-served MCP surface (ADR 0067). They drive real JSON-RPC over the
// mounted `/app/mcp` route through the SDK transport — an initialize/tools-list/tools-call handshake
// against a booted app — and assert: every non-excluded app operation projects to a tool whose
// input schema matches the spec; an `x-mcp`-excluded operation is withheld; a tool call flows
// through the SAME `mountApi` delegate + validation as the HTTP call; the framework debug tools
// (read + mutating) return engine truth and ADR 0065 projection data; a MUTATING tool refuses
// without the shared-secret guard credential and succeeds with it (while read tools stay open on
// loopback); the spec↔tool parity guard fails on injected skew; and the system-brief resource +
// orientation prompt are served. Access gating (loopback-only, flag) is covered too.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createNodeHost } from "../../adapters/node.ts";
import { createLogger } from "../logger.ts";
import type { AppApi, RuntimeContext } from "../context.ts";
import type { AppManifest } from "../manifest.ts";
import type {
  EngineClient,
  HostContext,
  HttpRequest,
  HttpResponse,
  ProcessInstanceSnapshot,
  SqliteDb,
} from "../host.ts";
import { makeRouter } from "../router.ts";
import { mountApi } from "./api.ts";
import { makeGateway } from "./gateway.ts";
import { DataLayer, type ProvisionedSource } from "./datasource.ts";
import { OpenUserTasksStore } from "./open-user-tasks-store.ts";
import { evictExcessSessions, isLoopbackRequest, missingRequiredArgs, mountMcp, newSessionId, readHeader, readMcpConfig } from "./mcp.ts";
import { collectMcpToolProjection, diffMcpToolProjection, parseSpec } from "../../../openapi/spec.ts";

// ---- fixtures ---------------------------------------------------------------------------------

const SPEC = JSON.stringify({
  openapi: "3.0.0",
  components: {
    schemas: {
      Invoice: {
        type: "object",
        properties: { id: { type: "string" }, amount: { type: "integer", minimum: 1 } },
        required: ["id", "amount"],
        additionalProperties: false,
      },
    },
  },
  paths: {
    "/invoices": {
      get: {
        operationId: "listInvoices",
        summary: "List invoices",
        parameters: [{ name: "limit", in: "query", required: true, schema: { type: "integer", minimum: 1 } }],
        responses: { "200": {} },
      },
      post: {
        operationId: "createInvoice",
        requestBody: { required: true, content: { "application/json": { schema: { $ref: "#/components/schemas/Invoice" } } } },
        responses: { "201": {} },
      },
    },
    "/invoices/{id}": {
      get: {
        operationId: "getInvoice",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        responses: { "200": {} },
      },
    },
  },
});

const SYSTEM_BRIEF = JSON.stringify({ app: "T", processes: [] });

const SPEC_PATH = "/app/openapi.json";
const BRIEF_PATH = "/app/nano-generated/system-brief.json";

function fakeEngine(overrides: Partial<EngineClient> = {}): EngineClient {
  return {
    deployResources: async () => ({ deployed: 0 }),
    createInstance: async () => ({ processInstanceKey: "pi" }),
    cancelInstance: async () => {},
    publishMessage: async () => {},
    searchUserTasks: async () => [],
    openUserTasks: async () => [],
    getForm: async () => null,
    searchProcessInstances: async () => [],
    searchElementInstances: async () => [],
    searchElementInstanceWaitStates: async () => [],
    getElementInstance: async () => null,
    searchIncidents: async () => [],
    searchVariables: async () => [],
    searchJobs: async () => [],
    getProcessDefinitionXml: async () => null,
    resolveIncident: async () => {},
    updateJobRetries: async () => {},
    setVariables: async () => {},
    completeUserTask: async () => {},
    registerWorker: async (jobType) => ({ jobType, unsubscribe: async () => {} }),
    close: async () => {},
    ...overrides,
  };
}

interface LogEntry {
  level: "debug" | "info" | "warn" | "error";
  msg: string;
  fields?: Record<string, unknown>;
}

interface Harness {
  router: (r: HttpRequest) => Promise<HttpResponse>;
  imported: string[];
  logs: LogEntry[];
}

function buildHarness(opts: {
  modules?: Record<string, Record<string, unknown>>;
  engine?: EngineClient;
  data?: DataLayer;
  env?: (v: string) => string | undefined;
  manifestExtra?: Record<string, unknown>;
  briefExists?: boolean;
  spec?: string;
} = {}): Harness {
  const modules = opts.modules ?? {};
  const engine = opts.engine ?? fakeEngine();
  const data = opts.data ?? new DataLayer(new Map(), undefined, {});
  const env = opts.env ?? (() => undefined);
  const imported: string[] = [];
  const briefExists = opts.briefExists ?? true;
  const spec = opts.spec ?? SPEC;
  const logs: LogEntry[] = [];
  const host: HostContext = {
    runtime: "node",
    env,
    readTextFile: async (p: string) => {
      if (p === BRIEF_PATH) return SYSTEM_BRIEF;
      return spec;
    },
    listDir: async () => [],
    exists: async (p: string) => (p === BRIEF_PATH ? briefExists : false),
    openSqlite: () => {
      throw new Error("sqlite not used in this harness");
    },
    importModule: (path: string) => {
      imported.push(path);
      const mod = modules[path];
      if (!mod) return Promise.reject(new Error(`no module at ${path}`));
      return Promise.resolve(mod);
    },
    serveHttp: async () => ({ port: 0, stop: async () => {} }),
    now: () => 0,
    log: (level, msg, fields) => {
      logs.push({ level, msg, fields });
    },
  };
  const manifest: AppManifest = { schemaVersion: 1, id: "t", name: "T" };
  Reflect.set(manifest, "api", { spec: "openapi.json" });
  if (opts.manifestExtra) for (const [k, v] of Object.entries(opts.manifestExtra)) Reflect.set(manifest, k, v);
  const app: AppApi = {
    manifest: { schemaVersion: 1, id: "t", name: "T" },
    data,
    engine,
    env: () => undefined,
    now: () => 0,
    wait: () => Promise.resolve(),
    log: createLogger(() => {}),
  };
  const ctx: RuntimeContext = { root: "/app", manifest, engine, host };
  const handle = mountMcp(ctx, app, mountApi(ctx, app).routes);
  const router = makeRouter(handle.routes);
  return { router: (r) => Promise.resolve(router(r)), imported, logs };
}

// ---- MCP JSON-RPC driver ----------------------------------------------------------------------

function mcpPost(body: unknown, headers: Record<string, string> = {}): HttpRequest {
  const text = JSON.stringify(body);
  return {
    method: "POST",
    path: "/app/mcp",
    query: new URLSearchParams(),
    headers: new Headers({
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      host: "localhost",
      ...headers,
    }),
    text: () => Promise.resolve(text),
  };
}

interface Session {
  sessionId: string;
  protocolVersion: string;
  headers: Record<string, string>;
}

async function initialize(router: Harness["router"]): Promise<Session> {
  const res = await router(
    mcpPost({
      jsonrpc: "2.0",
      id: 0,
      method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1.0" } },
    }),
  );
  assert.equal(res.status ?? 200, 200, `initialize should be 200, got ${res.status}: ${res.body}`);
  const sessionId = res.headers?.["mcp-session-id"];
  assert.ok(sessionId, "initialize must assign an mcp-session-id");
  const parsed = JSON.parse(res.body ?? "{}");
  const protocolVersion = parsed.result?.protocolVersion ?? "2025-06-18";
  const headers = { "mcp-session-id": sessionId, "mcp-protocol-version": protocolVersion };
  await router(mcpPost({ jsonrpc: "2.0", method: "notifications/initialized" }, headers));
  return { sessionId, protocolVersion, headers };
}

async function rpc(router: Harness["router"], session: Session, method: string, params: unknown, id = 1): Promise<{ result?: Record<string, unknown>; error?: { code: number; message: string } }> {
  const res = await router(mcpPost({ jsonrpc: "2.0", id, method, params }, session.headers));
  assert.equal(res.status ?? 200, 200, `${method} should be 200, got ${res.status}: ${res.body}`);
  return JSON.parse(res.body ?? "{}");
}

async function connect(router: Harness["router"]): Promise<Session> {
  return initialize(router);
}

function toolContentText(result: Record<string, unknown> | undefined): string {
  assert.ok(result, "tools/call must return a result");
  const content = result.content;
  assert.ok(Array.isArray(content) && content.length > 0, "tool result must carry content");
  const first = content[0];
  assert.ok(first && typeof first === "object" && "text" in first, "tool content must be a text block");
  return String(Reflect.get(first, "text"));
}

// ---- handshake --------------------------------------------------------------------------------

test("the endpoint speaks the MCP initialize handshake for a booted app", async () => {
  const { router } = buildHarness();
  const session = await connect(router);
  assert.ok(session.sessionId.length > 0);
});

test("a POST without a session and without an initialize request is a 400", async () => {
  const { router } = buildHarness();
  const res = await router(mcpPost({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }));
  assert.equal(res.status, 400);
});

test("a tools/call carrying an unknown/stale mcp-session-id is a 404, not a 400 (restart recovery)", async () => {
  // A restart wipes the in-memory sessions map; a client still holding a session id from the
  // previous process hits this branch. Per the MCP Streamable-HTTP spec the correct signal is 404
  // (session terminated/expired) so the client transparently re-initializes — a 400 leaves the
  // client hanging until its own request timeout instead of auto-reconnecting.
  const { router } = buildHarness();
  const res = await router(
    mcpPost(
      { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "listInvoices", arguments: {} } },
      { "mcp-session-id": "stale-session-from-a-previous-process" },
    ),
  );
  assert.equal(res.status, 404, `an unknown session id must be 404, got ${res.status}: ${res.body}`);
});

test("a present-but-unknown mcp-session-id WITH an initialize body still mints a fresh session", async () => {
  // The client is already reconnecting — carrying a stale id alongside an initialize must not be
  // rejected; it establishes a brand-new session exactly as a bare initialize would.
  const { router } = buildHarness();
  const res = await router(
    mcpPost(
      {
        jsonrpc: "2.0",
        id: 0,
        method: "initialize",
        params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1.0" } },
      },
      { "mcp-session-id": "stale-session-from-a-previous-process" },
    ),
  );
  assert.equal(res.status ?? 200, 200, `initialize with a stale id must be 200, got ${res.status}: ${res.body}`);
  assert.ok(res.headers?.["mcp-session-id"], "a fresh session id must be assigned");
});

// ---- tool projection --------------------------------------------------------------------------

test("every app operation projects to a tool; read tools are annotated read-only, mutating ones destructive", async () => {
  const { router } = buildHarness();
  const session = await connect(router);
  const list = await rpc(router, session, "tools/list", {});
  const tools = list.result?.tools;
  assert.ok(Array.isArray(tools));
  const byName = new Map(tools.map((t) => [Reflect.get(t, "name"), t]));
  assert.ok(byName.has("getInvoice"), "read-only getInvoice must be a tool");
  assert.ok(byName.has("listInvoices"), "read-only listInvoices must be a tool");
  // Slice 3: mutating app operations ARE now projected (guarded by their OpenAPI security at
  // dispatch, or open when the op declares none — matching the HTTP route), no longer withheld.
  assert.ok(byName.has("createInvoice"), "mutating createInvoice must now be a tool (guarded, not withheld)");

  const readAnn = Reflect.get(byName.get("getInvoice") ?? {}, "annotations");
  assert.equal(Reflect.get(readAnn ?? {}, "readOnlyHint"), true, "a read op must be annotated read-only");
  const mutAnn = Reflect.get(byName.get("createInvoice") ?? {}, "annotations");
  assert.equal(Reflect.get(mutAnn ?? {}, "readOnlyHint"), false, "a mutating op must not be annotated read-only");
  assert.equal(Reflect.get(mutAnn ?? {}, "destructiveHint"), true, "a mutating op must be annotated destructive");
});

test("an x-mcp-excluded operation is withheld from the tool surface while its siblings project", async () => {
  const excludedSpec = JSON.stringify({
    openapi: "3.1.0",
    paths: {
      "/things": {
        get: { operationId: "listThings", summary: "read", responses: { "200": {} } },
      },
      "/things/reindex": {
        post: {
          operationId: "reindexThings",
          summary: "operator-only, withheld",
          "x-mcp": false,
          responses: { "202": {} },
        },
      },
    },
  });
  const { router } = buildHarness({ spec: excludedSpec });
  const session = await connect(router);
  const list = await rpc(router, session, "tools/list", {});
  const tools = list.result?.tools;
  assert.ok(Array.isArray(tools));
  const names = tools.map((t) => Reflect.get(t, "name"));
  assert.ok(names.includes("listThings"), "a non-excluded op must still project");
  assert.ok(!names.includes("reindexThings"), "an x-mcp-excluded op must NOT appear as a tool");

  // And it is unreachable by name too — CallTool resolves it to neither a debug nor an app tool.
  const call = await router(
    mcpPost({ jsonrpc: "2.0", id: 9, method: "tools/call", params: { name: "reindexThings", arguments: {} } }, session.headers),
  );
  const parsed = JSON.parse(call.body ?? "{}");
  assert.ok(parsed.error, "an excluded op must not be callable");
  assert.match(String(parsed.error.message), /no such tool/i);
});

test("a projected tool's input schema matches the spec's params", async () => {
  const { router } = buildHarness();
  const session = await connect(router);
  const list = await rpc(router, session, "tools/list", {});
  const tools = list.result?.tools;
  assert.ok(Array.isArray(tools));
  const getInvoice = tools.find((t) => Reflect.get(t, "name") === "getInvoice");
  const schema = Reflect.get(getInvoice ?? {}, "inputSchema");
  assert.deepEqual(schema, {
    type: "object",
    properties: { id: { type: "string" } },
    required: ["id"],
  });
  const listInvoices = tools.find((t) => Reflect.get(t, "name") === "listInvoices");
  const listSchema = Reflect.get(listInvoices ?? {}, "inputSchema");
  assert.deepEqual(listSchema, {
    type: "object",
    properties: { limit: { type: "integer", minimum: 1 } },
    required: ["limit"],
  });
});

test("a $ref-bodied tool projects a self-contained body schema (no $ref, explicit type)", async () => {
  // createInvoice's requestBody is `{ $ref: "#/components/schemas/Invoice" }` — a bare $ref with no
  // inline `type`. An MCP client cannot resolve `#/components/...` outside the document, so the
  // projected tool schema MUST inline the concrete Invoice shape (ADR 0067). Regression guard for the
  // leak that shipped an opaque `#/components/...` pointer into `inputSchema.properties.body`.
  const { router } = buildHarness();
  const session = await connect(router);
  const list = await rpc(router, session, "tools/list", {});
  const tools = list.result?.tools;
  assert.ok(Array.isArray(tools));
  const createInvoice = tools.find((t) => Reflect.get(t, "name") === "createInvoice");
  assert.ok(createInvoice, "createInvoice must be present in tools/list before checking its schema");
  const schema = Reflect.get(createInvoice, "inputSchema");
  assert.deepEqual(schema, {
    type: "object",
    properties: {
      body: {
        type: "object",
        properties: { id: { type: "string" }, amount: { type: "integer", minimum: 1 } },
        required: ["id", "amount"],
        additionalProperties: false,
      },
    },
    required: ["body"],
  });
  // Self-containment holds structurally: the serialized schema carries no `$ref` token at all.
  assert.ok(!JSON.stringify(schema).includes("$ref"), "projected body schema must not leak a $ref");
});

test("an object body reaches the door as an object; a pre-encoded JSON-string body is parsed, not double-encoded; a malformed string body is a clear error", async () => {
  // `createInvoice`'s requestBody is `{ $ref: "#/components/schemas/Invoice" }` — an object body
  // whose concrete `type` is only visible after the projection resolver inlines the component. The
  // transport must classify it as an object body FROM THE RESOLVED SCHEMA (not the raw `$ref`) so the
  // string-parse path triggers for exactly this motivating shape, not merely an inline-`type` body.
  let seenBody: unknown = "unset";
  const { router } = buildHarness({
    modules: {
      "/app/operations/createInvoice": {
        default: (input: { body: unknown }) => {
          seenBody = input.body;
          return { body: { ok: true } };
        },
      },
    },
  });
  const session = await connect(router);

  // 1. A genuine object argument reaches the door (the reused delegate) AS AN OBJECT.
  const objCall = await rpc(router, session, "tools/call", {
    name: "createInvoice",
    arguments: { body: { id: "7", amount: 3 } },
  });
  assert.notEqual(objCall.result?.isError, true, `object body call must succeed: ${toolContentText(objCall.result)}`);
  assert.deepEqual(seenBody, { id: "7", amount: 3 }, "an object body argument must reach the door as an object");

  // 2. A PRE-ENCODED JSON-string body is accepted and parsed — NOT double-encoded into a quoted
  //    string the door would reject with "expected object, got string".
  seenBody = "unset";
  const strCall = await rpc(router, session, "tools/call", {
    name: "createInvoice",
    arguments: { body: JSON.stringify({ id: "9", amount: 5 }) },
  });
  assert.notEqual(strCall.result?.isError, true, `pre-encoded string body must be accepted: ${toolContentText(strCall.result)}`);
  assert.deepEqual(seenBody, { id: "9", amount: 5 }, "a pre-encoded JSON-string body must be parsed to an object at the door");

  // 3. A malformed string body is a CLEAR tool error naming the expected shape — never a silent 4xx
  //    from a forwarded double-encoded body, and the delegate must not run.
  seenBody = "unset";
  const badCall = await rpc(router, session, "tools/call", {
    name: "createInvoice",
    arguments: { body: "{not valid json" },
  });
  assert.equal(badCall.result?.isError, true, "a malformed string body must return an isError result");
  assert.match(toolContentText(badCall.result), /object/i, "the error must name the expected object shape");
  assert.equal(seenBody, "unset", "the door delegate must not run for a malformed string body");

  // 4. A string that parses to the WRONG shape (a scalar) is likewise a clear error, not a
  //    double-encoded forward — the object body path fails loudly on a non-object.
  seenBody = "unset";
  const wrongShape = await rpc(router, session, "tools/call", {
    name: "createInvoice",
    arguments: { body: "42" },
  });
  assert.equal(wrongShape.result?.isError, true, "a string parsing to a scalar must return an isError result");
  assert.match(toolContentText(wrongShape.result), /object/i, "the error must name the expected object shape");
  assert.equal(seenBody, "unset", "the door delegate must not run for a wrong-shape string body");
});

test("an array body reaches the door as an array; a pre-encoded JSON-string array body is parsed, not double-encoded; a wrong-shape string is a clear error", async () => {
  // Mirror of the object-body transport test for the ARRAY branch: `structuredBodyKind` can return
  // "array" and `normalizeBodyArg` has an `Array.isArray(parsed)` path, so a regression in array
  // handling must be caught here. `createBatch`'s requestBody declares a `type: array` body — the
  // transport must classify it as an array body and parse a pre-encoded JSON-string array once so it
  // round-trips as an array rather than being double-encoded into a quoted string the door rejects.
  const arraySpec = JSON.stringify({
    openapi: "3.0.0",
    paths: {
      "/batch": {
        post: {
          operationId: "createBatch",
          requestBody: {
            required: true,
            content: { "application/json": { schema: { type: "array", items: { type: "string" } } } },
          },
          responses: { "201": {} },
        },
      },
    },
  });
  let seenBody: unknown = "unset";
  const { router } = buildHarness({
    spec: arraySpec,
    modules: {
      "/app/operations/createBatch": {
        default: (input: { body: unknown }) => {
          seenBody = input.body;
          return { body: { ok: true } };
        },
      },
    },
  });
  const session = await connect(router);

  // 1. A genuine array argument reaches the door (the reused delegate) AS AN ARRAY.
  const arrCall = await rpc(router, session, "tools/call", {
    name: "createBatch",
    arguments: { body: ["a", "b"] },
  });
  assert.notEqual(arrCall.result?.isError, true, `array body call must succeed: ${toolContentText(arrCall.result)}`);
  assert.deepEqual(seenBody, ["a", "b"], "an array body argument must reach the door as an array");

  // 2. A PRE-ENCODED JSON-string array body is accepted and parsed — NOT double-encoded into a quoted
  //    string the door would reject with "expected array, got string".
  seenBody = "unset";
  const strCall = await rpc(router, session, "tools/call", {
    name: "createBatch",
    arguments: { body: JSON.stringify(["a", "b"]) },
  });
  assert.notEqual(strCall.result?.isError, true, `pre-encoded string array body must be accepted: ${toolContentText(strCall.result)}`);
  assert.deepEqual(seenBody, ["a", "b"], "a pre-encoded JSON-string array body must be parsed to an array at the door");

  // 3. A string that parses to the WRONG shape (an object) is a clear error naming the expected
  //    array shape, not a double-encoded forward — and the delegate must not run.
  seenBody = "unset";
  const wrongShape = await rpc(router, session, "tools/call", {
    name: "createBatch",
    arguments: { body: JSON.stringify({ not: "an array" }) },
  });
  assert.equal(wrongShape.result?.isError, true, "a string parsing to an object must return an isError result");
  assert.match(toolContentText(wrongShape.result), /array/i, "the error must name the expected array shape");
  assert.equal(seenBody, "unset", "the door delegate must not run for a wrong-shape string array body");
});

test("a tool call routes through the SAME mountApi delegate as the HTTP call", async () => {
  let seenParams: Record<string, unknown> | undefined;
  const { router, imported } = buildHarness({
    modules: {
      "/app/operations/getInvoice": {
        default: (input: { params: Record<string, unknown> }) => {
          seenParams = input.params;
          return { body: { id: "42", amount: 7 } };
        },
      },
    },
  });
  const session = await connect(router);
  const call = await rpc(router, session, "tools/call", { name: "getInvoice", arguments: { id: "42" } });
  const text = toolContentText(call.result);
  assert.deepEqual(JSON.parse(text), { id: "42", amount: 7 });
  assert.deepEqual(seenParams, { id: "42" }, "the delegate must receive the validated path param");
  assert.ok(imported.includes("/app/operations/getInvoice"), "the SAME api delegate module must be imported");
  assert.notEqual(call.result?.isError, true);
});

test("a tool call with schema-invalid input fails validation identically to the HTTP call", async () => {
  const { router } = buildHarness({
    modules: {
      "/app/operations/listInvoices": { default: () => ({ body: [] }) },
    },
  });
  const session = await connect(router);
  // limit=0 violates `minimum: 1` — the reused validator must reject before the delegate runs.
  const call = await rpc(router, session, "tools/call", { name: "listInvoices", arguments: { limit: 0 } });
  assert.equal(call.result?.isError, true, "a validation failure must surface as an error tool result");
  const text = toolContentText(call.result);
  assert.match(text, /validation failed/i);
});

test("a tool call missing a required path parameter is rejected before dispatch", async () => {
  let delegateRan = false;
  const { router } = buildHarness({
    modules: {
      "/app/operations/getInvoice": {
        default: () => {
          delegateRan = true;
          return { body: { id: "x" } };
        },
      },
    },
  });
  const session = await connect(router);
  // `getInvoice` declares a required `{id}` path param; omitting it must fail validation up front
  // rather than silently substitute an empty string and 404 (or mis-route to a different shape).
  const call = await rpc(router, session, "tools/call", { name: "getInvoice", arguments: {} });
  assert.equal(call.result?.isError, true, "a missing required path param must surface as an error result");
  const text = toolContentText(call.result);
  assert.match(text, /missing required path parameter/i);
  assert.match(text, /\bid\b/);
  assert.equal(delegateRan, false, "the delegate must not run for a missing-path-param tool call");

  // A whitespace-only path arg is blank under the shared trimmed-presence rule: it would `fillPath`
  // to a blank segment and mis-route, so it is rejected the same as an omitted param.
  const blankCall = await rpc(router, session, "tools/call", { name: "getInvoice", arguments: { id: "  " } });
  assert.equal(blankCall.result?.isError, true, "a whitespace-only path param must also be rejected");
  assert.match(toolContentText(blankCall.result), /missing required path parameter/i);
  assert.equal(delegateRan, false, "the delegate must not run for a blank-path-param tool call");
});

// ---- framework debug tools --------------------------------------------------------------------

test("the framework debug tools appear and return engine truth", async () => {
  const snapshot: ProcessInstanceSnapshot = {
    processInstanceKey: "pi-1",
    state: "ACTIVE",
  };
  const engine = fakeEngine({ searchProcessInstances: async () => [snapshot] });
  const { router } = buildHarness({ engine });
  const session = await connect(router);
  const list = await rpc(router, session, "tools/list", {});
  const tools = list.result?.tools;
  assert.ok(Array.isArray(tools));
  const names = tools.map((t) => Reflect.get(t, "name"));
  assert.ok(names.includes("urban_debug_search_process_instances"));
  assert.ok(names.includes("urban_debug_search_element_instance_wait_states"));
  assert.ok(names.includes("urban_debug_get_element_instance"));
  assert.ok(names.includes("urban_debug_search_user_tasks"));
  assert.ok(names.includes("urban_debug_instance_state"));
  assert.ok(names.includes("urban_debug_open_user_tasks"));
  assert.ok(names.includes("urban_debug_search_variables"));
  assert.ok(names.includes("urban_debug_search_jobs"));
  assert.ok(names.includes("urban_debug_get_process_definition_xml"));

  const call = await rpc(router, session, "tools/call", {
    name: "urban_debug_search_process_instances",
    arguments: { state: "ACTIVE" },
  });
  const text = toolContentText(call.result);
  assert.deepEqual(JSON.parse(text), [snapshot]);
});

test("urban_debug_search_variables / search_jobs / get_process_definition_xml are read tools returning engine truth", async () => {
  const variable = {
    variableKey: "v-1",
    name: "prKey",
    value: '"owner/repo#7"',
    scopeKey: "pi-1",
    processInstanceKey: "pi-1",
    isTruncated: false,
  };
  const job = {
    jobKey: "j-1",
    type: "senior:pr-review",
    state: "CREATED",
    processInstanceKey: "pi-1",
    retries: 3,
    elementId: "review",
  };
  const seenVarFilters: unknown[] = [];
  const seenJobFilters: unknown[] = [];
  const seenXmlKeys: string[] = [];
  const engine = fakeEngine({
    searchVariables: async (filter) => {
      seenVarFilters.push(filter);
      return [variable];
    },
    searchJobs: async (filter) => {
      seenJobFilters.push(filter);
      return [job];
    },
    getProcessDefinitionXml: async (key) => {
      seenXmlKeys.push(key);
      return key === "pd-1" ? "<bpmn:definitions/>" : null;
    },
  });
  const { router } = buildHarness({ engine });
  const session = await connect(router);

  // All three tools are read tools — they serve on loopback with no credential.
  const vars = await rpc(router, session, "tools/call", {
    name: "urban_debug_search_variables",
    arguments: { processInstanceKey: "pi-1", name: "prKey" },
  });
  assert.notEqual(vars.result?.isError, true, "search_variables is a read tool (no credential needed)");
  assert.deepEqual(JSON.parse(toolContentText(vars.result)), [variable]);
  assert.deepEqual(seenVarFilters, [{ processInstanceKey: "pi-1", name: "prKey" }]);

  const jobs = await rpc(router, session, "tools/call", {
    name: "urban_debug_search_jobs",
    arguments: { processInstanceKey: "pi-1", state: "CREATED" },
  });
  assert.notEqual(jobs.result?.isError, true, "search_jobs is a read tool (no credential needed)");
  assert.deepEqual(JSON.parse(toolContentText(jobs.result)), [job]);
  assert.deepEqual(seenJobFilters, [{ processInstanceKey: "pi-1", state: "CREATED" }]);

  const xml = await rpc(router, session, "tools/call", {
    name: "urban_debug_get_process_definition_xml",
    arguments: { processDefinitionKey: "pd-1" },
  });
  assert.notEqual(xml.result?.isError, true, "get_process_definition_xml is a read tool");
  // The deployed XML is a raw string, surfaced verbatim (not JSON-wrapped).
  assert.equal(toolContentText(xml.result), "<bpmn:definitions/>");
  assert.deepEqual(seenXmlKeys, ["pd-1"]);

  // An unknown key returns typed-absent (null) rather than erroring.
  const absent = await rpc(router, session, "tools/call", {
    name: "urban_debug_get_process_definition_xml",
    arguments: { processDefinitionKey: "nope" },
  });
  assert.equal(toolContentText(absent.result), "null");
});

test("the three new debug read tools expose self-contained ($ref-free) input schemas", async () => {
  const { router } = buildHarness({ engine: fakeEngine() });
  const session = await connect(router);
  const list = await rpc(router, session, "tools/list", {});
  const tools = list.result?.tools;
  assert.ok(Array.isArray(tools));
  const names = tools.map((t) => Reflect.get(t, "name"));
  for (const name of [
    "urban_debug_search_variables",
    "urban_debug_search_jobs",
    "urban_debug_get_process_definition_xml",
  ]) {
    assert.ok(names.includes(name), `${name} must appear in tools/list`);
    const tool: unknown = tools[names.indexOf(name)];
    const schema: unknown = Reflect.get(tool ?? {}, "inputSchema");
    assert.equal(Reflect.get(schema ?? {}, "type"), "object", `${name} schema is an object`);
    assert.ok(!JSON.stringify(schema).includes("$ref"), `${name} schema must be $ref-free`);
  }
});

test("an app operationId in the reserved urban_debug_ namespace can't shadow a framework tool", async () => {
  // A `urban_debug_*` operationId is a legal safe path segment, so an app could declare one. Because
  // `CallTool` resolves framework debug tools before app ops, an unreserved namespace would let such
  // an op be shadowed by (and duplicate the name of) the framework tool. The reservation must drop
  // the colliding app op before projection so `tools/list` stays duplicate-free and the name still
  // reaches the framework debug tool.
  const collidingSpec = JSON.stringify({
    openapi: "3.0.0",
    paths: {
      "/shadow": {
        get: {
          operationId: "urban_debug_search_process_instances",
          summary: "malicious/accidental shadow of a framework tool",
          responses: { "200": {} },
        },
      },
    },
  });
  const snapshot: ProcessInstanceSnapshot = { processInstanceKey: "pi-1", state: "ACTIVE" };
  const engine = fakeEngine({ searchProcessInstances: async () => [snapshot] });
  const { router } = buildHarness({ engine, spec: collidingSpec });
  const session = await connect(router);

  const list = await rpc(router, session, "tools/list", {});
  const tools = list.result?.tools;
  assert.ok(Array.isArray(tools));
  const names = tools.map((t) => Reflect.get(t, "name"));
  const shadows = names.filter((n) => n === "urban_debug_search_process_instances");
  assert.equal(shadows.length, 1, "the reserved-namespace app op must not appear as a duplicate tool");

  // The name resolves to the framework debug tool (engine truth), not the dropped app op.
  const call = await rpc(router, session, "tools/call", {
    name: "urban_debug_search_process_instances",
    arguments: { state: "ACTIVE" },
  });
  const text = toolContentText(call.result);
  assert.deepEqual(JSON.parse(text), [snapshot]);
});

test("the reserved-namespace drop warns once, not on every tools/list and tools/call", async () => {
  // The projected op table is memoized per parsed spec doc, so `collectOperations` + the reserved-
  // namespace filter (which emits this warn) runs once — NOT on every request. Guards against the
  // recompute/log-spam defect class: an app that accidentally declares a `urban_debug_*` op must not
  // spam a warn on each of the many `tools/list`/`tools/call` requests a session makes.
  const collidingSpec = JSON.stringify({
    openapi: "3.0.0",
    paths: {
      "/shadow": {
        get: { operationId: "urban_debug_search_process_instances", responses: { "200": {} } },
      },
    },
  });
  const engine = fakeEngine({ searchProcessInstances: async () => [] });
  const { router, logs } = buildHarness({ engine, spec: collidingSpec });
  const session = await connect(router);

  await rpc(router, session, "tools/list", {});
  await rpc(router, session, "tools/list", {});
  await rpc(router, session, "tools/call", { name: "urban_debug_search_process_instances", arguments: { state: "ACTIVE" } });

  const drops = logs.filter((l) => l.msg.includes("reserved framework tool namespace"));
  assert.equal(drops.length, 1, "the reserved-namespace drop must warn exactly once across many requests");
});

test("urban_debug_open_user_tasks reads the ADR 0065 canonical projection", async () => {
  const dir = await mkdtemp(join(tmpdir(), "urban-mcp-proj-"));
  const host = createNodeHost({ cwd: dir, log: () => {} });
  const db: SqliteDb = host.openSqlite(join(dir, "test.db"));
  try {
    const openStore = new OpenUserTasksStore(db, { clock: { now: () => 0 } });
    openStore.ensureSchema();
    openStore.recordOpenTask("pi-7", { userTaskKey: "ut-1", elementId: "Task_A" });

    const source: ProvisionedSource = {
      name: "default",
      driver: "sqlite",
      db,
      source: makeGateway(db),
      migrationsApplied: [],
      close: () => {},
    };
    const data = new DataLayer(new Map([["default", source]]), "default", {});
    const { router } = buildHarness({ data });
    const session = await connect(router);

    const tasksCall = await rpc(router, session, "tools/call", {
      name: "urban_debug_open_user_tasks",
      arguments: { processInstanceKey: "pi-7" },
    });
    const tasks = JSON.parse(toolContentText(tasksCall.result));
    assert.ok(Array.isArray(tasks) && tasks.length === 1);
    assert.equal(Reflect.get(tasks[0], "userTaskKey"), "ut-1");
  } finally {
    db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("urban_debug_instance_state returns engine truth for a live (ACTIVE) instance", async () => {
  const snapshot: ProcessInstanceSnapshot = { processInstanceKey: "pi-7", state: "ACTIVE" };
  const engine = fakeEngine({
    searchProcessInstances: async (filter) => {
      assert.deepEqual(filter?.processInstanceKeys, ["pi-7"]);
      return [snapshot];
    },
    openUserTasks: async () => [],
  });
  const { router } = buildHarness({ engine });
  const session = await connect(router);

  const call = await rpc(router, session, "tools/call", {
    name: "urban_debug_instance_state",
    arguments: { processInstanceKey: "pi-7" },
  });
  const state = JSON.parse(toolContentText(call.result));
  assert.deepEqual(state, { processInstanceKey: "pi-7", state: "ACTIVE", waitingOnHuman: false });
});

test("urban_debug_instance_state reports waitingOnHuman from open user tasks", async () => {
  const snapshot: ProcessInstanceSnapshot = { processInstanceKey: "pi-7", state: "ACTIVE" };
  const engine = fakeEngine({
    searchProcessInstances: async () => [snapshot],
    openUserTasks: async (filter) => {
      assert.equal(filter?.processInstanceKey, "pi-7");
      return [{ userTaskKey: "ut-1", processInstanceKey: "pi-7" }];
    },
  });
  const { router } = buildHarness({ engine });
  const session = await connect(router);

  const call = await rpc(router, session, "tools/call", {
    name: "urban_debug_instance_state",
    arguments: { processInstanceKey: "pi-7" },
  });
  const state = JSON.parse(toolContentText(call.result));
  assert.deepEqual(state, { processInstanceKey: "pi-7", state: "ACTIVE", waitingOnHuman: true });
});

test("urban_debug_instance_state returns null when the engine has no such instance", async () => {
  let openUserTasksCalled = false;
  const engine = fakeEngine({
    searchProcessInstances: async () => [],
    openUserTasks: async () => {
      openUserTasksCalled = true;
      return [];
    },
  });
  const { router } = buildHarness({ engine });
  const session = await connect(router);

  const call = await rpc(router, session, "tools/call", {
    name: "urban_debug_instance_state",
    arguments: { processInstanceKey: "nope" },
  });
  assert.equal(toolContentText(call.result), "null");
  assert.equal(openUserTasksCalled, false, "must not probe user tasks for an instance the engine doesn't know");
});

// ---- mutation guard (Slice 3) -----------------------------------------------------------------

// A repeated credential header must read the SAME under the MCP guard as under OpenAPI route
// enforcement. `mountApi`/`toHttpRequest` read it via `Headers.get()`, which comma-joins repeated
// values; `readHeader` must match that (not pick the first) so the shared-secret guard cannot
// diverge from route enforcement on a `string[]` header (as Node's raw adapter surfaces it).
test("readHeader comma-joins a repeated header to match Headers.get() semantics", () => {
  // Baseline: a single string value is returned verbatim; a missing header is undefined.
  assert.equal(readHeader({ "x-nano-key": "abc" }, "X-Nano-Key"), "abc");
  assert.equal(readHeader({}, "X-Nano-Key"), undefined);
  // A repeated header (string[]) is joined with ", " — exactly what `Headers.get()` returns for the
  // reconstructed request in `toHttpRequest`, so the guard reads the identical credential string.
  const joined = readHeader({ "x-nano-key": ["a", "b"] }, "X-Nano-Key");
  const viaHeaders = (() => {
    const h = new Headers();
    for (const v of ["a", "b"]) h.append("X-Nano-Key", v);
    return h.get("X-Nano-Key") ?? undefined;
  })();
  assert.equal(joined, viaHeaders, "readHeader must match Headers.get() for a repeated header");
});

// A spec that declares the app's shared-secret scheme (an apiKey header pointing at an env var via
// `x-nano-secret-env`) — the credential the framework MUTATING tools require. REUSING the app's
// existing shared secret, never an MCP-specific synonym (ADR 0067 §4).
const GUARDED_SPEC = JSON.stringify({
  openapi: "3.1.0",
  components: {
    securitySchemes: {
      appSecret: { type: "apiKey", in: "header", name: "X-Nano-Key", "x-nano-secret-env": "NANO_WEBHOOK_KEY" },
    },
  },
  paths: {
    "/invoices": {
      get: { operationId: "listInvoices", summary: "List invoices", responses: { "200": {} } },
    },
  },
});

const SECRET = "s3cr3t-value";
const guardEnv = (v: string) => (v === "NANO_WEBHOOK_KEY" ? SECRET : undefined);

test("a mutating framework tool refuses without the guard credential and succeeds with it", async () => {
  const cancelled: string[] = [];
  const engine = fakeEngine({
    cancelInstance: async ({ processInstanceKey }) => {
      cancelled.push(processInstanceKey);
    },
  });
  const { router } = buildHarness({ engine, spec: GUARDED_SPEC, env: guardEnv });
  const session = await connect(router);

  // Without the credential the mutation is refused before the engine is touched.
  const refused = await rpc(router, session, "tools/call", {
    name: "urban_debug_cancel_instance",
    arguments: { processInstanceKey: "pi-1" },
  });
  assert.equal(refused.result?.isError, true, "a mutating tool must refuse without the guard credential");
  assert.match(toolContentText(refused.result), /unauthorized/i);
  assert.deepEqual(cancelled, [], "the engine mutation must not run for an unauthorized call");

  // With the correct shared secret on the connection header the mutation runs.
  const authedSession = { ...session, headers: { ...session.headers, "X-Nano-Key": SECRET } };
  const ok = await rpc(router, authedSession, "tools/call", {
    name: "urban_debug_cancel_instance",
    arguments: { processInstanceKey: "pi-1" },
  });
  assert.notEqual(ok.result?.isError, true, "a mutating tool must succeed with the guard credential");
  assert.deepEqual(cancelled, ["pi-1"], "the engine mutation must run once authorized");

  // A wrong credential is refused too (constant-time compare via evaluateSecurity).
  const wrongSession = { ...session, headers: { ...session.headers, "X-Nano-Key": "nope" } };
  const wrong = await rpc(router, wrongSession, "tools/call", {
    name: "urban_debug_cancel_instance",
    arguments: { processInstanceKey: "pi-2" },
  });
  assert.equal(wrong.result?.isError, true, "a wrong credential must be refused");
  assert.deepEqual(cancelled, ["pi-1"], "a wrong-credential call must not run the mutation");
});

test("read tools work on loopback without any credential, even when a shared-secret scheme is declared", async () => {
  const engine = fakeEngine({ searchIncidents: async () => [] });
  const { router } = buildHarness({
    engine,
    spec: GUARDED_SPEC,
    env: guardEnv,
    modules: { "/app/operations/listInvoices": { default: () => ({ body: [{ id: "1" }] }) } },
  });
  const session = await connect(router);

  // A read app operation dispatches with no credential (its GET route declares no security).
  const appRead = await rpc(router, session, "tools/call", { name: "listInvoices", arguments: {} });
  assert.notEqual(appRead.result?.isError, true, "a read app op must serve on loopback without a credential");
  assert.deepEqual(JSON.parse(toolContentText(appRead.result)), [{ id: "1" }]);

  // A read framework debug tool likewise needs no credential.
  const dbgRead = await rpc(router, session, "tools/call", {
    name: "urban_debug_search_incidents",
    arguments: { state: "ACTIVE" },
  });
  assert.notEqual(dbgRead.result?.isError, true, "a read debug tool must serve on loopback without a credential");
});

test("the explicit allowMutations opt-in authorizes a mutating tool without a credential", async () => {
  const resolved: string[] = [];
  const engine = fakeEngine({
    resolveIncident: async ({ incidentKey }) => {
      resolved.push(incidentKey);
    },
  });
  // No shared-secret scheme in the spec; the runtime opt-in alone opens mutations.
  const { router } = buildHarness({
    engine,
    env: (v) => (v === "URBAN_MCP_ALLOW_MUTATIONS" ? "true" : undefined),
  });
  const session = await connect(router);
  const ok = await rpc(router, session, "tools/call", {
    name: "urban_debug_resolve_incident",
    arguments: { incidentKey: "inc-9" },
  });
  assert.notEqual(ok.result?.isError, true, "allowMutations must authorize a mutation with no credential");
  assert.deepEqual(resolved, ["inc-9"]);
});

test("the allowMutations opt-in is loopback-only: with allowRemote on, mutations still require the shared secret", async () => {
  // Regression guard for the failure class: a credential-free opt-in must NOT silently apply once
  // the surface is opened to non-loopback callers, or mutating urban_debug_* tools would be exposed
  // remotely with no guard at all. With allowMutations AND allowRemote both on, the bypass is
  // ignored and the shared secret is still enforced (refused without it, allowed with it).
  const cancelled: string[] = [];
  const engine = fakeEngine({
    cancelInstance: async ({ processInstanceKey }) => {
      cancelled.push(processInstanceKey);
    },
  });
  const remoteMutateEnv = (v: string) =>
    v === "URBAN_MCP_ALLOW_MUTATIONS" || v === "URBAN_MCP_ALLOW_REMOTE"
      ? "true"
      : v === "NANO_WEBHOOK_KEY"
        ? SECRET
        : undefined;
  const { router } = buildHarness({ engine, spec: GUARDED_SPEC, env: remoteMutateEnv });
  const session = await connect(router);

  // allowMutations is set, but because allowRemote is on it must NOT bypass the shared secret.
  const refused = await rpc(router, session, "tools/call", {
    name: "urban_debug_cancel_instance",
    arguments: { processInstanceKey: "pi-1" },
  });
  assert.equal(refused.result?.isError, true, "allowMutations must not bypass the guard when allowRemote is on");
  assert.equal(JSON.parse(toolContentText(refused.result)).status, 401, "a remote-exposed mutation without the secret is 401");
  assert.deepEqual(cancelled, [], "the engine mutation must not run for an unauthorized remote call");

  // Presenting the app's shared secret still authorizes it (the shared-secret path is unchanged).
  const authed = { ...session, headers: { ...session.headers, "X-Nano-Key": SECRET } };
  const ok = await rpc(router, authed, "tools/call", {
    name: "urban_debug_cancel_instance",
    arguments: { processInstanceKey: "pi-1" },
  });
  assert.notEqual(ok.result?.isError, true, "the shared secret must still authorize a mutation under allowRemote");
  assert.deepEqual(cancelled, ["pi-1"]);
});

test("with allowMutations + allowRemote but no shared-secret scheme, mutations fail closed", async () => {
  // The remote-exposed bypass being ignored must leave NO other credential-free path: with no
  // shared-secret scheme configured either, the mutation is refused rather than silently allowed.
  const engine = fakeEngine({ resolveIncident: async () => assert.fail("must not run") });
  const remoteMutateEnv = (v: string) =>
    v === "URBAN_MCP_ALLOW_MUTATIONS" || v === "URBAN_MCP_ALLOW_REMOTE" ? "true" : undefined;
  const { router } = buildHarness({ engine, env: remoteMutateEnv });
  const session = await connect(router);
  const refused = await rpc(router, session, "tools/call", {
    name: "urban_debug_resolve_incident",
    arguments: { incidentKey: "inc-9" },
  });
  assert.equal(refused.result?.isError, true, "a remote-exposed mutation with no scheme and no in-scope opt-in must fail closed");
});

test("with no shared-secret scheme and no opt-in, a mutating tool fails closed", async () => {
  const engine = fakeEngine({ setVariables: async () => assert.fail("must not run") });
  const { router } = buildHarness({ engine });
  const session = await connect(router);
  const refused = await rpc(router, session, "tools/call", {
    name: "urban_debug_set_variables",
    arguments: { scopeKey: "pi-1", variables: { x: 1 } },
  });
  assert.equal(refused.result?.isError, true, "a mutation must fail closed when nothing can authorize it");
});

test("a mutating tool refused for a misconfigured shared secret logs a 500 and surfaces the status", async () => {
  // The spec declares a shared-secret scheme, but its secret env var is unset — a server
  // misconfiguration (500), not a bad credential (401). Like `mountApi`, the MCP guard must log it
  // for operators and carry the 500 status in the error payload so a client can tell them apart.
  const engine = fakeEngine({ cancelInstance: async () => assert.fail("must not run") });
  const { router, logs } = buildHarness({ engine, spec: GUARDED_SPEC, env: () => undefined });
  const session = await connect(router);
  const refused = await rpc(router, session, "tools/call", {
    name: "urban_debug_cancel_instance",
    arguments: { processInstanceKey: "pi-1" },
  });
  assert.equal(refused.result?.isError, true, "a misconfigured shared secret must refuse the mutation");
  const payload = JSON.parse(toolContentText(refused.result));
  assert.equal(payload.status, 500, "a misconfig refusal must surface status 500, not 401");
  assert.match(payload.error, /misconfigured/i);
  const misconfigLogs = logs.filter((l) => l.level === "error" && l.msg.includes("misconfigured"));
  assert.equal(misconfigLogs.length, 1, "a 500-class refusal must be logged for operators");
  assert.equal(misconfigLogs[0].fields?.tool, "urban_debug_cancel_instance");
});

test("a mutating tool refused for a missing credential surfaces a 401 status without an error log", async () => {
  const engine = fakeEngine({ cancelInstance: async () => assert.fail("must not run") });
  const { router, logs } = buildHarness({ engine, spec: GUARDED_SPEC, env: guardEnv });
  const session = await connect(router);
  const refused = await rpc(router, session, "tools/call", {
    name: "urban_debug_cancel_instance",
    arguments: { processInstanceKey: "pi-1" },
  });
  assert.equal(refused.result?.isError, true, "a missing credential must refuse the mutation");
  const payload = JSON.parse(toolContentText(refused.result));
  assert.equal(payload.status, 401, "a missing/invalid credential must surface status 401");
  assert.equal(
    logs.filter((l) => l.level === "error" && l.msg.includes("misconfigured")).length,
    0,
    "a plain unauthorized (401) is not a misconfig and must not be logged as one",
  );
});

test("a mutating tool refused because the OpenAPI spec failed to load surfaces a 500, not a 401", async () => {
  // A broken/unparseable spec is a server misconfiguration: the guard cannot tell whether a
  // shared-secret scheme exists, so it must surface a 500 (logged for operators) rather than a
  // misleading 401 that looks like a missing credential.
  const engine = fakeEngine({ cancelInstance: async () => assert.fail("must not run") });
  // Valid JSON but not an object at the root — `parseSpec` throws, so `loadSpecDoc` fails to load.
  const { router, logs } = buildHarness({ engine, spec: "[1, 2, 3]", env: guardEnv });
  const session = await connect(router);
  const refused = await rpc(router, session, "tools/call", {
    name: "urban_debug_cancel_instance",
    arguments: { processInstanceKey: "pi-1" },
  });
  assert.equal(refused.result?.isError, true, "a broken spec must refuse the mutation");
  const payload = JSON.parse(toolContentText(refused.result));
  assert.equal(payload.status, 500, "a spec-load failure must surface status 500, not 401");
  assert.match(payload.error, /failed to load/i);
  const loadWarns = logs.filter((l) => l.level === "warn" && l.msg.includes("failed to load the app OpenAPI spec"));
  assert.equal(loadWarns.length >= 1, true, "the spec-load failure must be logged");
  const misconfigLogs = logs.filter((l) => l.level === "error" && l.msg.includes("misconfigured"));
  assert.equal(misconfigLogs.length, 1, "a 500-class refusal must be logged for operators");
  assert.equal(misconfigLogs[0].fields?.tool, "urban_debug_cancel_instance");
});

test("an authorized mutating tool rejects a blank/non-string key or negative retries before touching the engine", async () => {
  const touched: string[] = [];
  const engine = fakeEngine({
    cancelInstance: async () => {
      touched.push("cancelInstance");
    },
    resolveIncident: async () => {
      touched.push("resolveIncident");
    },
    updateJobRetries: async () => {
      touched.push("updateJobRetries");
    },
    setVariables: async () => {
      touched.push("setVariables");
    },
  });
  // Fully authorized via the opt-in — so a rejection can only come from argument validation.
  const { router } = buildHarness({
    engine,
    env: (v) => (v === "URBAN_MCP_ALLOW_MUTATIONS" ? "true" : undefined),
  });
  const session = await connect(router);

  const badCalls: { name: string; arguments: Record<string, unknown>; why: RegExp }[] = [
    // Blank strings are rejected upstream as a missing required parameter; a non-string value slips
    // past that check (it is "present") and must be rejected by the tool's own argument guard.
    { name: "urban_debug_cancel_instance", arguments: { processInstanceKey: "" }, why: /missing required/i },
    { name: "urban_debug_cancel_instance", arguments: { processInstanceKey: 123 }, why: /non-empty string/i },
    { name: "urban_debug_resolve_incident", arguments: { incidentKey: 7 }, why: /non-empty string/i },
    { name: "urban_debug_set_variables", arguments: { scopeKey: 1, variables: { x: 1 } }, why: /non-empty string/i },
    { name: "urban_debug_retry_job", arguments: { jobKey: 42, retries: 0 }, why: /non-empty string/i },
    { name: "urban_debug_retry_job", arguments: { jobKey: "j-1", retries: -1 }, why: /non-negative integer/i },
  ];

  for (const call of badCalls) {
    const res = await rpc(router, session, "tools/call", { name: call.name, arguments: call.arguments });
    assert.equal(res.result?.isError, true, `${call.name} must reject invalid args: ${JSON.stringify(call.arguments)}`);
    assert.match(toolContentText(res.result), call.why);
  }
  assert.deepEqual(touched, [], "no invalid mutating call may reach the engine");
});

test("an authorized mutating tool trims a padded identifying key before mutating the engine", async () => {
  // A padded key like "  pi-1  " is "present" (the required-arg check trims via presentFormIdentifier),
  // so it slips past presence validation. The tool's own `requireString` guard must apply the SAME
  // trimmed-presence rule and forward the TRIMMED value, or the engine mutation targets a whitespace-
  // padded entity that does not exist. This guards the drift between the presence check and the guard.
  const cancelled: string[] = [];
  const engine = fakeEngine({
    cancelInstance: async ({ processInstanceKey }) => {
      cancelled.push(processInstanceKey);
    },
  });
  const { router } = buildHarness({
    engine,
    env: (v) => (v === "URBAN_MCP_ALLOW_MUTATIONS" ? "true" : undefined),
  });
  const session = await connect(router);
  const ok = await rpc(router, session, "tools/call", {
    name: "urban_debug_cancel_instance",
    arguments: { processInstanceKey: "  pi-1  " },
  });
  assert.notEqual(ok.result?.isError, true, "a padded but present key must be accepted");
  assert.deepEqual(cancelled, ["pi-1"], "the engine must receive the trimmed key, not the padded one");
});

test("a read tool trims a padded filter value before querying the engine", async () => {
  // The read path had the same drift the mutating guard closes: an optional filter value read raw
  // reaches the engine untrimmed, so a padded key like "  pi-1  " becomes a filter that silently
  // matches nothing. `readPresentString` — the single source of truth `requireString` derives from —
  // applies the same trimmed-presence rule to optional reads, so search filters cannot mis-target.
  const seen: (string | undefined)[] = [];
  const engine = fakeEngine({
    searchIncidents: async (filter) => {
      seen.push(filter?.processInstanceKey);
      return [];
    },
  });
  const { router } = buildHarness({ engine });
  const session = await connect(router);
  const ok = await rpc(router, session, "tools/call", {
    name: "urban_debug_search_incidents",
    arguments: { processInstanceKey: "  pi-1  " },
  });
  assert.notEqual(ok.result?.isError, true, "a padded filter value must be accepted");
  assert.deepEqual(seen, ["pi-1"], "the engine must receive the trimmed filter value, not the padded one");
});

test("every debug tool with a required string key rejects a non-string value before querying/mutating", async () => {
  // Defect-class guard (not a single-line squash): `missingRequiredArgs` treats a present non-string
  // (number/object) as provided, so any tool that declares a key `required` but reads it with a
  // degrade-to-empty pattern (`readPresentString(...) ?? ""`) would let that value slip past the
  // presence check and query/mutate with an empty key — a confusing empty result, not a fast failure.
  // The canonical fix is that EVERY required string key is read via `requireString`, which fails fast
  // with InvalidParams. This test enumerates the live tool list and asserts that invariant holds for
  // ALL current and future debug tools, so a new tool cannot silently reintroduce the drift.
  const { router } = buildHarness({
    // Fully authorized so a rejection can only come from argument validation, not the mutation gate.
    env: (v) => (v === "URBAN_MCP_ALLOW_MUTATIONS" ? "true" : undefined),
  });
  const session = await connect(router);
  const list = await rpc(router, session, "tools/list", {});
  const tools = list.result?.tools;
  assert.ok(Array.isArray(tools));

  // A valid dummy for a required key of a given JSON-schema type, used to satisfy the OTHER required
  // keys so the rejection is attributable solely to the one non-string key we poke.
  const dummyForType = (type: unknown): unknown => {
    if (type === "string") return "dummy";
    if (type === "integer" || type === "number") return 0;
    if (type === "boolean") return false;
    if (type === "object") return {};
    if (type === "array") return [];
    return "dummy";
  };

  let requiredStringKeysChecked = 0;
  for (const tool of tools) {
    const name = Reflect.get(tool, "name");
    if (typeof name !== "string" || !name.startsWith("urban_debug_")) continue;
    const schema = Reflect.get(tool, "inputSchema");
    if (schema === null || typeof schema !== "object") continue;
    const required = Reflect.get(schema, "required");
    const properties = Reflect.get(schema, "properties");
    if (!Array.isArray(required) || properties === null || typeof properties !== "object") continue;

    const requiredStringKeys = required.filter((k) => {
      if (typeof k !== "string") return false;
      const prop = Reflect.get(properties, k);
      return prop !== null && typeof prop === "object" && Reflect.get(prop, "type") === "string";
    });

    for (const key of requiredStringKeys) {
      const args: Record<string, unknown> = {};
      for (const other of required) {
        if (typeof other !== "string") continue;
        const prop = Reflect.get(properties, other);
        args[other] = dummyForType(prop !== null && typeof prop === "object" ? Reflect.get(prop, "type") : undefined);
      }
      // Poke exactly one required string key with a present-but-non-string value.
      args[key] = 123;
      const res = await rpc(router, session, "tools/call", { name, arguments: args });
      assert.equal(
        res.result?.isError,
        true,
        `${name} must reject a non-string ${key} instead of querying/mutating with an empty key`,
      );
      assert.match(toolContentText(res.result), /non-empty string/i, `${name}.${key} must fail fast via requireString`);
      requiredStringKeysChecked++;
    }
  }
  // Guard the guard: if this drops to zero the enumeration silently stopped covering anything.
  assert.ok(requiredStringKeysChecked >= 3, "expected at least the known required-string-key debug tools to be checked");
});

// ---- spec ↔ tool parity guard (Slice 3) -------------------------------------------------------

test("the spec↔tool parity guard reports drift on an injected skew and none in parity", () => {
  const doc = parseSpec(
    JSON.stringify({
      openapi: "3.1.0",
      paths: {
        "/a": { get: { operationId: "readA", responses: { "200": {} } } },
        "/b": { post: { operationId: "mutateB", responses: { "201": {} } } },
        "/c": { post: { operationId: "hiddenC", "x-mcp": false, responses: { "202": {} } } },
      },
    }),
  );
  const projection = collectMcpToolProjection(doc);
  // A snapshot identical to the current projection is in parity.
  assert.deepEqual(diffMcpToolProjection(projection, projection), []);

  // Inject skew: drop one op, flip another's mutating/excluded facts.
  const skewed = projection
    .filter((p) => p.operationId !== "readA")
    .map((p) => (p.operationId === "hiddenC" ? { ...p, excluded: false } : p));
  const drift = diffMcpToolProjection(skewed, projection);
  assert.ok(drift.length >= 2, "both a missing op and a changed fact must be reported");
  assert.ok(drift.some((l) => l.includes("readA")), "the dropped op must be reported");
  assert.ok(drift.some((l) => l.includes("hiddenC")), "the flipped exclusion must be reported");
});

// ---- resource + prompt ------------------------------------------------------------------------

test("a debug tool call missing a required parameter is rejected before its handler runs", async () => {
  let handlerRan = false;
  const engine = fakeEngine({
    getElementInstance: async () => {
      handlerRan = true;
      return null;
    },
  });
  const { router } = buildHarness({ engine });
  const session = await connect(router);
  // `urban_debug_get_element_instance` declares `elementInstanceKey` required; omitting it must
  // fail validation up front rather than substitute an empty string and query the engine with it.
  const call = await rpc(router, session, "tools/call", {
    name: "urban_debug_get_element_instance",
    arguments: {},
  });
  assert.equal(call.result?.isError, true, "a missing required debug-tool arg must surface as an error result");
  const text = toolContentText(call.result);
  assert.match(text, /missing required parameter/i);
  assert.match(text, /elementInstanceKey/);
  assert.equal(handlerRan, false, "the debug handler must not run for a missing required-arg call");

  // An empty string is treated as absent too — it is exactly the masked-invalid-call the guard closes.
  const emptyCall = await rpc(router, session, "tools/call", {
    name: "urban_debug_get_element_instance",
    arguments: { elementInstanceKey: "" },
  });
  assert.equal(emptyCall.result?.isError, true, "an empty required arg must also be rejected");
  assert.equal(handlerRan, false, "the debug handler must not run for an empty required-arg call");

  // A whitespace-only value is absent under the same trimmed-presence rule `presentFormIdentifier`
  // enforces — it would otherwise slip through and query the engine with a blank identifier.
  const blankCall = await rpc(router, session, "tools/call", {
    name: "urban_debug_get_element_instance",
    arguments: { elementInstanceKey: "   " },
  });
  assert.equal(blankCall.result?.isError, true, "a whitespace-only required arg must also be rejected");
  assert.match(toolContentText(blankCall.result), /missing required parameter/i);
  assert.equal(handlerRan, false, "the debug handler must not run for a whitespace-only required-arg call");
});

test("missingRequiredArgs treats a present non-string value as provided, not missing", () => {
  // Presence is decided solely by isBlankArg, so a required numeric/boolean/object arg that is
  // actually supplied must NOT be reported missing — the earlier `typeof value !== "string"` guard
  // wrongly rejected every non-string required input.
  const schema = { required: ["count", "enabled", "filter"] };
  assert.deepEqual(
    missingRequiredArgs(schema, { count: 0, enabled: false, filter: { state: "ACTIVE" } }),
    [],
    "present non-string required args (including falsy 0/false) must be accepted",
  );

  // Absent (undefined/null) and blank/whitespace-only string values remain rejected.
  assert.deepEqual(
    missingRequiredArgs(schema, { count: undefined, enabled: null, filter: "   " }),
    ["count", "enabled", "filter"],
    "undefined, null, and whitespace-only string required args must be reported missing",
  );

  // A required key entirely omitted from args is missing; a non-empty string is provided.
  assert.deepEqual(missingRequiredArgs({ required: ["id"] }, {}), ["id"]);
  assert.deepEqual(missingRequiredArgs({ required: ["id"] }, { id: "x" }), []);
});

test("the system brief is served as an MCP resource", async () => {
  const { router } = buildHarness();
  const session = await connect(router);
  const list = await rpc(router, session, "resources/list", {});
  const resources = list.result?.resources;
  assert.ok(Array.isArray(resources) && resources.length >= 1);
  const uri = Reflect.get(resources[0], "uri");
  const read = await rpc(router, session, "resources/read", { uri });
  const contents = read.result?.contents;
  assert.ok(Array.isArray(contents) && contents.length === 1);
  assert.equal(Reflect.get(contents[0], "text"), SYSTEM_BRIEF);
});

test("the orientation prompt is registered and served", async () => {
  const { router } = buildHarness();
  const session = await connect(router);
  const list = await rpc(router, session, "prompts/list", {});
  const prompts = list.result?.prompts;
  assert.ok(Array.isArray(prompts) && prompts.length >= 1);
  const name = Reflect.get(prompts[0], "name");
  assert.equal(name, "urban-orientation");
  const get = await rpc(router, session, "prompts/get", { name });
  const messages = get.result?.messages;
  assert.ok(Array.isArray(messages) && messages.length >= 1);
});

// ---- access gating ----------------------------------------------------------------------------

test("readMcpConfig defaults ON for loopback and honours env/manifest flags", () => {
  const on = readMcpConfig({}, () => undefined);
  assert.equal(on.enabled, true);
  assert.equal(on.allowRemote, false);

  const offByEnv = readMcpConfig({}, (n) => (n === "URBAN_MCP_ENABLED" ? "false" : undefined));
  assert.equal(offByEnv.enabled, false);

  const remoteByEnv = readMcpConfig({}, (n) => (n === "URBAN_MCP_ALLOW_REMOTE" ? "true" : undefined));
  assert.equal(remoteByEnv.allowRemote, true);

  const manifest: Record<string, unknown> = { mcp: { enabled: false } };
  assert.equal(readMcpConfig(manifest, () => undefined).enabled, false);

  // Non-boolean manifest values are ignored (strict type check, like `readApiBinding`): they fall
  // back to the defaults rather than coercing — e.g. the string "false" is NOT a boolean `false`.
  const stringy: Record<string, unknown> = { mcp: { enabled: "false", allowRemote: "true" } };
  const resolved = readMcpConfig(stringy, () => undefined);
  assert.equal(resolved.enabled, true, "a non-boolean `enabled` must fall back to the default (ON)");
  assert.equal(resolved.allowRemote, false, "a non-boolean `allowRemote` must fall back to the default (OFF)");
});

test("isLoopbackRequest recognises loopback hosts and rejects remote ones", () => {
  const mk = (host?: string): HttpRequest => ({
    method: "POST",
    path: "/app/mcp",
    query: new URLSearchParams(),
    headers: new Headers(host ? { host } : {}),
    text: () => Promise.resolve(""),
  });
  assert.equal(isLoopbackRequest(mk("localhost:3000")), true);
  assert.equal(isLoopbackRequest(mk("127.0.0.1:3000")), true);
  assert.equal(isLoopbackRequest(mk("[::1]:3000")), true);
  assert.equal(isLoopbackRequest(mk()), true);
  assert.equal(isLoopbackRequest(mk("example.com")), false);
});

test("a disabled surface answers 404 and a remote caller is refused 403", async () => {
  const disabled = buildHarness({ env: (v) => (v === "URBAN_MCP_ENABLED" ? "false" : undefined) });
  const res404 = await disabled.router(mcpPost({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }));
  assert.equal(res404.status, 404);

  const loopbackOnly = buildHarness();
  const res403 = await loopbackOnly.router(
    mcpPost(
      { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
      { host: "example.com" },
    ),
  );
  assert.equal(res403.status, 403);
});

test("a loopback-only surface bound to all interfaces refuses even a loopback Host", async () => {
  // With bind=all the client-controlled `Host` header can't prove loopback, so every caller is
  // refused unless remote access is explicitly opted in.
  const boundAll = buildHarness({ env: (v) => (v === "URBAN_BIND" ? "all" : undefined) });
  const refused = await boundAll.router(
    mcpPost({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }, { host: "localhost" }),
  );
  assert.equal(refused.status, 403, "a loopback Host must not bypass the gate when bound to all interfaces");

  // Manifest `network.bind: "all"` is honoured the same way.
  const boundAllManifest = buildHarness({ manifestExtra: { network: { bind: "all" } } });
  const refused2 = await boundAllManifest.router(
    mcpPost({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }, { host: "127.0.0.1" }),
  );
  assert.equal(refused2.status, 403);

  // Opting into remote access lets the all-interfaces bind serve again.
  const remote = buildHarness({
    env: (v) => (v === "URBAN_BIND" ? "all" : v === "URBAN_MCP_ALLOW_REMOTE" ? "true" : undefined),
  });
  const session = await connect(remote.router);
  assert.ok(session.sessionId.length > 0, "allowRemote must let an all-interfaces bind serve");
});

test("newSessionId mints a fresh id and never throws when Web Crypto is absent", () => {
  // With Web Crypto present it delegates to randomUUID (unique across calls).
  const a = newSessionId();
  const b = newSessionId();
  assert.ok(a.length > 0 && b.length > 0, "a session id must be non-empty");
  assert.notEqual(a, b, "successive session ids must differ");

  // Core treats Web Crypto as optional: in a host without `crypto` the generator must fall back
  // rather than throw (a bare `crypto.randomUUID()` would throw a ReferenceError here). Prove the
  // fallback branch actually ran by removing `crypto` and asserting the `sess-` prefix it mints.
  const savedCrypto = Reflect.getOwnPropertyDescriptor(globalThis, "crypto");
  assert.notEqual(
    savedCrypto?.configurable,
    false,
    "test requires globalThis.crypto to be configurable to simulate a host without Web Crypto",
  );
  try {
    Reflect.defineProperty(globalThis, "crypto", { value: undefined, configurable: true, writable: true });
    assert.equal(globalThis.crypto, undefined, "crypto must actually be absent to exercise the fallback branch");
    const fallback = newSessionId();
    assert.ok(fallback.startsWith("sess-"), "the id must come from the time+random fallback when crypto is unavailable");
    assert.notEqual(fallback, newSessionId(), "fallback ids must still differ");
  } finally {
    if (savedCrypto) Reflect.defineProperty(globalThis, "crypto", savedCrypto);
    else Reflect.deleteProperty(globalThis, "crypto");
  }
});

test("evictExcessSessions caps the session map by evicting least-recently-used pairs, closing each", async () => {
  // Guards the defect class the reviewer flagged: an unbounded `sessions` map is a memory/handle
  // exhaustion vector. A hard LRU cap must bound the map no matter the client's `initialize` cadence.
  const closed: string[] = [];
  const sessions = new Map<string, { id: string }>();
  for (const id of ["a", "b", "c", "d"]) sessions.set(id, { id });

  await evictExcessSessions(sessions, 2, async (s) => {
    closed.push(s.id);
  });

  assert.equal(sessions.size, 2, "the map must be trimmed down to the cap");
  assert.deepEqual([...sessions.keys()], ["c", "d"], "the two most-recently-inserted survive");
  assert.deepEqual(closed, ["a", "b"], "evicted (LRU) sessions must be closed, in eviction order");

  // Under the cap it is a no-op and closes nothing.
  const noop: string[] = [];
  await evictExcessSessions(sessions, 5, async (s) => {
    noop.push(s.id);
  });
  assert.equal(sessions.size, 2);
  assert.deepEqual(noop, [], "nothing is evicted while under the cap");
});

test("evictExcessSessions keeps closing when a victim's close() rejects (best-effort)", async () => {
  // A victim whose transport is already torn down must not abort eviction of the rest, or a single
  // dead session could wedge the cap and re-open the unbounded-growth hole.
  const closed: string[] = [];
  const sessions = new Map<string, { id: string }>();
  for (const id of ["x", "y", "z"]) sessions.set(id, { id });

  await evictExcessSessions(sessions, 1, async (s) => {
    closed.push(s.id);
    if (s.id === "x") throw new Error("transport already closed");
  });

  assert.equal(sessions.size, 1);
  assert.deepEqual([...sessions.keys()], ["z"], "the newest entry survives despite a failing close");
  assert.deepEqual(closed, ["x", "y"], "both LRU victims are attempted even though the first rejected");
});
