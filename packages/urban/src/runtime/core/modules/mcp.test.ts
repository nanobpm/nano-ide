// Red/Green tests for the runtime-served MCP surface (ADR 0067, Slice 1). They drive real
// JSON-RPC over the mounted `/app/mcp` route through the SDK transport — an initialize/tools-list/
// tools-call handshake against a booted app — and assert: every non-excluded read-only app
// operation projects to a tool whose input schema matches the spec; a mutating operation is
// withheld; a tool call flows through the SAME `mountApi` delegate + validation as the HTTP call;
// the framework debug tools return engine truth and ADR 0065 projection data; and the system-brief
// resource + orientation prompt are served. Access gating (loopback-only, flag) is covered too.

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
import { InstanceStateStore } from "./instance-state-store.ts";
import { OpenUserTasksStore } from "./open-user-tasks-store.ts";
import { isLoopbackRequest, missingRequiredArgs, mountMcp, newSessionId, readMcpConfig } from "./mcp.ts";

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
    completeUserTask: async () => {},
    registerWorker: async (jobType) => ({ jobType, unsubscribe: async () => {} }),
    close: async () => {},
    ...overrides,
  };
}

interface Harness {
  router: (r: HttpRequest) => Promise<HttpResponse>;
  imported: string[];
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
    log: () => {},
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
  return { router: (r) => Promise.resolve(router(r)), imported };
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

// ---- tool projection --------------------------------------------------------------------------

test("every read-only app operation projects to a tool; mutating operations are withheld", async () => {
  const { router } = buildHarness();
  const session = await connect(router);
  const list = await rpc(router, session, "tools/list", {});
  const tools = list.result?.tools;
  assert.ok(Array.isArray(tools));
  const names = tools.map((t) => Reflect.get(t, "name"));
  assert.ok(names.includes("getInvoice"), "read-only getInvoice must be a tool");
  assert.ok(names.includes("listInvoices"), "read-only listInvoices must be a tool");
  assert.ok(!names.includes("createInvoice"), "mutating createInvoice must NOT be a tool in this slice");
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

  const call = await rpc(router, session, "tools/call", {
    name: "urban_debug_search_process_instances",
    arguments: { state: "ACTIVE" },
  });
  const text = toolContentText(call.result);
  assert.deepEqual(JSON.parse(text), [snapshot]);
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

test("the projection debug tools read the ADR 0065 canonical stores", async () => {
  const dir = await mkdtemp(join(tmpdir(), "urban-mcp-proj-"));
  const host = createNodeHost({ cwd: dir, log: () => {} });
  const db: SqliteDb = host.openSqlite(join(dir, "test.db"));
  try {
    new InstanceStateStore(db, { clock: { now: () => 0 } }).ensureSchema();
    new InstanceStateStore(db, { clock: { now: () => 0 } }).recordState("pi-7", "ACTIVE");
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

    const stateCall = await rpc(router, session, "tools/call", {
      name: "urban_debug_instance_state",
      arguments: { processInstanceKey: "pi-7" },
    });
    const state = JSON.parse(toolContentText(stateCall.result));
    assert.equal(Reflect.get(state, "state"), "ACTIVE");

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
