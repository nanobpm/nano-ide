import { test } from "node:test";
import { createLogger } from "../logger.ts";
import assert from "node:assert/strict";
import type { AppApi, RuntimeContext } from "../context.ts";
import type { AppManifest } from "../manifest.ts";
import type { EngineClient, HostContext, HttpRequest } from "../host.ts";
import { makeRouter } from "../router.ts";
import { DataLayer } from "./datasource.ts";
import { mountApi, resolveOperationHandler, apiDocsPath, deriveSwaggerUrls, NotImplemented, type ApiHandle, type OperationHandler } from "./api.ts";

function req(
  method: string,
  path: string,
  opts: { query?: string; body?: string; headers?: Record<string, string> } = {},
): HttpRequest {
  return {
    method,
    path,
    query: new URLSearchParams(opts.query ?? ""),
    headers: new Headers(opts.headers ?? {}),
    text: () => Promise.resolve(opts.body ?? ""),
  };
}

const engine: EngineClient = {
  deployResources: async () => ({ deployed: 0 }),
  createInstance: async () => ({ processInstanceKey: "pi" }),
  cancelInstance: async () => {},
  publishMessage: async () => {},
  searchUserTasks: async () => [],
  searchProcessInstances: async () => [],
  completeUserTask: async () => {},
  registerWorker: async (jobType) => ({ jobType, unsubscribe: async () => {} }),
  close: async () => {},
};

const data = new DataLayer(new Map(), undefined, {});

function appFixture(): AppApi {
  return { manifest: { schemaVersion: 1, id: "t", name: "T" }, data, engine, env: () => undefined, log: createLogger(() => {}) };
}

const spec = JSON.stringify({
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
      post: {
        operationId: "createInvoice",
        requestBody: { required: true, content: { "application/json": { schema: { $ref: "#/components/schemas/Invoice" } } } },
        responses: { "201": { content: { "application/json": { schema: { $ref: "#/components/schemas/Invoice" } } } } },
      },
    },
    "/invoices/{id}": {
      get: {
        operationId: "getInvoice",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        responses: { "200": {} },
      },
      delete: {
        operationId: "rawDelete",
        "x-urban-eject": true,
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        responses: { "204": {} },
      },
    },
  },
});

interface Built {
  router: (r: HttpRequest) => Promise<{ status?: number; body?: string; headers?: Record<string, string> }>;
  imported: string[];
  logs: Array<{ level: string; msg: string }>;
  handle: ApiHandle;
}

function build(
  api: Record<string, unknown> | undefined,
  modules: Record<string, Record<string, unknown>>,
  specText = spec,
  env: (v: string) => string | undefined = () => undefined,
  existsPaths: string[] = [],
  app: AppApi = appFixture(),
): Built {
  const imported: string[] = [];
  const logs: Array<{ level: string; msg: string }> = [];
  const existsSet = new Set(existsPaths);
  const host: HostContext = {
    runtime: "node",
    env,
    readTextFile: async () => specText,
    listDir: async () => [],
    exists: async (p: string) => existsSet.has(p),
    openSqlite: () => {
      throw new Error("sqlite not used in this test");
    },
    importModule: (path: string) => {
      imported.push(path);
      const mod = modules[path];
      if (!mod) return Promise.reject(new Error(`no module at ${path}`));
      return Promise.resolve(mod);
    },
    serveHttp: async () => ({ port: 0, stop: async () => {} }),
    now: () => 0,
    log: (level: string, msg: string) => logs.push({ level, msg }),
  };
  const manifest: AppManifest = { schemaVersion: 1, id: "t", name: "T" };
  if (api) Reflect.set(manifest, "api", api);
  const ctx: RuntimeContext = { root: "/app", manifest, engine, host };
  const handle = mountApi(ctx, app);
  const router = makeRouter(handle.routes);
  return { router: (r) => Promise.resolve(router(r)), imported, logs, handle };
}

/** Mount `mountApi` and return the handle directly (for asserting `describe()`). */
function buildHandle(api: Record<string, unknown>): { handle: ApiHandle } {
  return { handle: build(api, {}).handle };
}

test("resolveOperationHandler prefers default (function) then handler", () => {
  const fn = () => ({});
  assert.equal(resolveOperationHandler({ default: fn }), fn);
  assert.equal(resolveOperationHandler({ handler: fn }), fn);
  assert.equal(resolveOperationHandler({ nope: fn }), undefined);
});

test("no api binding → no routes (no-op for actions-only apps)", () => {
  const { router } = build(undefined, {});
  // makeRouter over an empty route table 404s everything.
  return router(req("GET", "/app/api/invoices/1")).then((res) => assert.equal(res.status, 404));
});

test("a delegate's app.log is bound to the request's correlation context", async () => {
  const captured: Array<{ level: string; msg: string; fields?: Record<string, unknown> }> = [];
  const capturingApp: AppApi = {
    manifest: { schemaVersion: 1, id: "t", name: "T" },
    data,
    engine,
    env: () => undefined,
    log: createLogger((level, msg, fields) => {
      captured.push({ level, msg, fields });
    }),
  };
  const handler: OperationHandler = (_input, app) => {
    app.log.info("creating invoice", { amount: 5 });
    return { status: 201, body: { id: "i1", amount: 5 } };
  };
  const { router } = build(
    { spec: "openapi.json", dir: "operations" },
    { "/app/operations/createInvoice": { default: handler } },
    spec,
    () => undefined,
    [],
    capturingApp,
  );
  const res = await router(req("POST", "/app/api/invoices", { body: JSON.stringify({ id: "i1", amount: 5 }) }));
  assert.equal(res.status, 201);
  assert.equal(captured.length, 1);
  assert.equal(captured[0].level, "info");
  assert.equal(captured[0].msg, "creating invoice");
  assert.deepEqual(
    { ...captured[0].fields },
    { method: "POST", path: "/invoices", operationId: "createInvoice", amount: 5 },
  );
});

test("routes an operation to its delegate with validated params + body", async () => {
  const seen: unknown[] = [];
  const handler: OperationHandler = (input) => {
    seen.push({ params: input.params, body: input.body });
    return { status: 201, body: { id: "i1", amount: 5 } };
  };
  const { router, imported } = build(
    { spec: "openapi.json", dir: "operations" },
    { "/app/operations/createInvoice": { default: handler } },
  );
  const res = await router(req("POST", "/app/api/invoices", { body: JSON.stringify({ id: "i1", amount: 5 }) }));
  assert.equal(res.status, 201);
  assert.deepEqual(JSON.parse(res.body!), { id: "i1", amount: 5 });
  assert.deepEqual(seen, [{ params: {}, body: { id: "i1", amount: 5 } }]);
  assert.deepEqual(imported, ["/app/operations/createInvoice"]);
});

test("captures path params and passes them to the delegate", async () => {
  let got: Record<string, string> | undefined;
  const { router } = build(
    { spec: "openapi.json" },
    { "/app/operations/getInvoice": { default: (i: { params: Record<string, string> }) => { got = i.params; return { body: { ok: true } }; } } },
  );
  const res = await router(req("GET", "/app/api/invoices/42"));
  assert.equal(res.status, 200);
  assert.deepEqual(got, { id: "42" });
});

test("body failing schema validation is a structured 400 before the delegate loads", async () => {
  const { router, imported } = build(
    { spec: "openapi.json" },
    { "/app/operations/createInvoice": { default: () => ({ body: {} }) } },
  );
  const res = await router(req("POST", "/app/api/invoices", { body: JSON.stringify({ amount: 0 }) }));
  assert.equal(res.status, 400);
  const parsed = JSON.parse(res.body!);
  assert.equal(parsed.error, "request validation failed");
  assert.ok(Array.isArray(parsed.issues) && parsed.issues.length >= 1);
  assert.deepEqual(imported, []); // delegate never loaded
});

test("missing required body is a 400", async () => {
  const { router } = build({ spec: "openapi.json" }, { "/app/operations/createInvoice": { default: () => ({}) } });
  const res = await router(req("POST", "/app/api/invoices"));
  assert.equal(res.status, 400);
  assert.match(JSON.parse(res.body!).error, /validation failed/);
});

test("invalid JSON body is a 400 (non-ejected)", async () => {
  const { router } = build({ spec: "openapi.json" }, { "/app/operations/createInvoice": { default: () => ({}) } });
  const res = await router(req("POST", "/app/api/invoices", { body: "{not json" }));
  assert.equal(res.status, 400);
  assert.match(JSON.parse(res.body!).error, /must be JSON/);
});

test("ejected operation skips validation and still routes to its delegate", async () => {
  let called = false;
  const { router } = build(
    { spec: "openapi.json" },
    { "/app/operations/rawDelete": { default: () => { called = true; return { status: 204 }; } } },
  );
  // No validation on an ejected op even though body is not schema-checked.
  const res = await router(req("DELETE", "/app/api/invoices/9", { body: "{not json" }));
  assert.equal(res.status, 204);
  assert.equal(called, true);
});

test("whole-surface eject skips validation for every operation", async () => {
  let seenBody: unknown;
  const { router } = build(
    { spec: "openapi.json", eject: true },
    { "/app/operations/createInvoice": { default: (i: { body: unknown }) => { seenBody = i.body; return { body: { ok: true } }; } } },
  );
  const res = await router(req("POST", "/app/api/invoices", { body: JSON.stringify({ amount: 0 }) }));
  assert.equal(res.status, 200); // amount:0 would fail validation, but eject skips it
  assert.deepEqual(seenBody, { amount: 0 });
});

test("known path on the wrong method is 405; unknown path is 404", async () => {
  const { router } = build({ spec: "openapi.json" }, { "/app/operations/getInvoice": { default: () => ({}) } });
  assert.equal((await router(req("PUT", "/app/api/invoices/1"))).status, 405);
  assert.equal((await router(req("GET", "/app/api/nope"))).status, 404);
});

test("a delegate that fails to load is a 500 on that route", async () => {
  const { router } = build({ spec: "openapi.json" }, {}); // no modules registered
  const res = await router(req("GET", "/app/api/invoices/1"));
  assert.equal(res.status, 500);
  assert.match(JSON.parse(res.body!).error, /delegate failed to load/);
});

test("a malformed spec surfaces as a 500, not a boot failure", async () => {
  const { router } = build({ spec: "openapi.json" }, {}, "{not json");
  const res = await router(req("GET", "/app/api/invoices/1"));
  assert.equal(res.status, 500);
  assert.match(JSON.parse(res.body!).error, /failed to load/);
});

test("a leftover manifest api.base is ignored — operations always mount at the fixed /app/api", async () => {
  let got: Record<string, string> | undefined;
  const { router } = build(
    { spec: "openapi.json", base: "/somewhere/else" }, // base is no longer honoured
    { "/app/operations/getInvoice": { default: (i: { params: Record<string, string> }) => { got = i.params; return { body: { ok: true } }; } } },
  );
  assert.equal((await router(req("GET", "/somewhere/else/invoices/42"))).status, 404);
  const res = await router(req("GET", "/app/api/invoices/42"));
  assert.equal(res.status, 200);
  assert.deepEqual(got, { id: "42" });
});

test("a malformed spec pattern surfaces as a controlled 500, not a crash", async () => {
  const badPatternSpec = JSON.stringify({
    openapi: "3.0.0",
    paths: {
      "/things": {
        post: {
          operationId: "createThing",
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: { type: "object", properties: { name: { type: "string", pattern: "([" } }, required: ["name"] },
              },
            },
          },
          responses: { "200": {} },
        },
      },
    },
  });
  const { router } = build(
    { spec: "openapi.json" },
    { "/app/operations/createThing": { default: () => ({ body: {} }) } },
    badPatternSpec,
  );
  const res = await router(req("POST", "/app/api/things", { body: JSON.stringify({ name: "x" }) }));
  assert.equal(res.status, 500);
  assert.match(JSON.parse(res.body!).error, /invalid pattern/);
});

test("an empty api.dir falls back to the default operations dir, not an absolute path", async () => {
  let called = false;
  const { router, imported } = build(
    { spec: "openapi.json", dir: "" }, // misconfigured empty dir
    { "/app/operations/getInvoice": { default: () => { called = true; return { body: { ok: true } }; } } },
  );
  const res = await router(req("GET", "/app/api/invoices/42"));
  assert.equal(res.status, 200);
  assert.equal(called, true);
  assert.deepEqual(imported, ["/app/operations/getInvoice"]);
});

test("malformed percent-encoding in a path param is a 400, not a 500", async () => {
  const { router } = build(
    { spec: "openapi.json" },
    { "/app/operations/getInvoice": { default: () => ({ body: { ok: true } }) } },
  );
  const res = await router(req("GET", "/app/api/invoices/%E0%A4%A")); // invalid UTF-8 escape
  assert.equal(res.status, 400);
  assert.match(JSON.parse(res.body!).error, /malformed path parameter encoding/);
});

test("repeated query keys are all validated (extra values don't bypass validation)", async () => {
  const arraySpec = JSON.stringify({
    openapi: "3.0.0",
    paths: {
      "/items": {
        get: {
          operationId: "listItems",
          parameters: [{ name: "n", in: "query", schema: { type: "integer", minimum: 1 } }],
          responses: { "200": {} },
        },
      },
    },
  });
  const { router } = build(
    { spec: "openapi.json" },
    { "/app/operations/listItems": { default: () => ({ body: { ok: true } }) } },
    arraySpec,
  );
  // A repeated scalar (non-array) param can't be forwarded as the single schema-typed scalar the
  // delegate expects, so it's rejected outright (400) — extra values never reach the delegate.
  const res = await router(req("GET", "/app/api/items", { query: "n=5&n=0" }));
  assert.equal(res.status, 400);
  assert.match(JSON.parse(res.body!).error, /validation failed/);
  assert.match(JSON.stringify(JSON.parse(res.body!).issues), /expected a single value/);
});

test("a declared but schemaless query param preserves raw wire semantics (repeats allowed)", async () => {
  const schemalessSpec = JSON.stringify({
    openapi: "3.0.0",
    paths: {
      "/items": {
        get: {
          operationId: "listItems",
          parameters: [{ name: "x", in: "query" }], // no schema → raw wire `string | string[]`
          responses: { "200": {} },
        },
      },
    },
  });
  let got: unknown;
  const { router } = build(
    { spec: "openapi.json" },
    { "/app/operations/listItems": { default: (i: { query: Record<string, unknown> }) => { got = i.query.x; return { body: { ok: true } }; } } },
    schemalessSpec,
  );
  // Repeated key must NOT be rejected as a scalar-repeat — it's forwarded as the raw string[].
  const res = await router(req("GET", "/app/api/items", { query: "x=a&x=b" }));
  assert.equal(res.status, 200);
  assert.deepEqual(got, ["a", "b"]);
  // A single value stays the raw string.
  let got1: unknown;
  const b2 = build(
    { spec: "openapi.json" },
    { "/app/operations/listItems": { default: (i: { query: Record<string, unknown> }) => { got1 = i.query.x; return { body: { ok: true } }; } } },
    schemalessSpec,
  );
  await b2.router(req("GET", "/app/api/items", { query: "x=solo" }));
  assert.equal(got1, "solo");
});

test("array-typed query params validate the whole array (items + array constraints)", async () => {
  const arraySpec = JSON.stringify({
    openapi: "3.0.0",
    paths: {
      "/items": {
        get: {
          operationId: "listItems",
          parameters: [
            { name: "tag", in: "query", schema: { type: "array", minItems: 2, items: { type: "string", enum: ["a", "b"] } } },
          ],
          responses: { "200": {} },
        },
      },
    },
  });
  const build2 = (q: string) =>
    build(
      { spec: "openapi.json" },
      { "/app/operations/listItems": { default: () => ({ body: { ok: true } }) } },
      arraySpec,
    ).router(req("GET", "/app/api/items", { query: q }));
  assert.equal((await build2("tag=a&tag=b")).status, 200); // valid array
  assert.equal((await build2("tag=a")).status, 400); // fewer than minItems
  assert.equal((await build2("tag=a&tag=c")).status, 400); // "c" not in enum
});

test("params/query are coerced to their schema type before reaching the delegate", async () => {
  const coerceSpec = JSON.stringify({
    openapi: "3.0.0",
    paths: {
      "/things/{id}": {
        get: {
          operationId: "getThing",
          parameters: [
            { name: "id", in: "path", required: true, schema: { type: "integer" } },
            { name: "verbose", in: "query", schema: { type: "boolean" } },
            { name: "tags", in: "query", schema: { type: "array", items: { type: "string" } } },
          ],
          responses: { "200": {} },
        },
      },
    },
  });
  let got: { params: Record<string, unknown>; query: Record<string, unknown> } | undefined;
  const { router } = build(
    { spec: "openapi.json" },
    {
      "/app/operations/getThing": {
        default: (i: { params: Record<string, unknown>; query: Record<string, unknown> }) => {
          got = { params: i.params, query: i.query };
          return { body: { ok: true } };
        },
      },
    },
    coerceSpec,
  );
  const res = await router(req("GET", "/app/api/things/42", { query: "verbose=true&tags=x&tags=y" }));
  assert.equal(res.status, 200);
  // integer path param → number, boolean query → boolean, array query → string[] (all coerced).
  assert.deepEqual(got, { params: { id: 42 }, query: { verbose: true, tags: ["x", "y"] } });
});

test("3.1 nullable-typed params still coerce (type: [T, null]) and array-typed repeats still group", async () => {
  // A param declared with the OpenAPI 3.1 nullable idiom must coerce on its value type exactly like
  // the 3.0 single-type form — otherwise a `type: ["integer","null"]` query would reach the delegate
  // as a raw string (and an array-typed nullable would reject repeats).
  const spec = JSON.stringify({
    openapi: "3.1.0",
    paths: {
      "/things/{id}": {
        get: {
          operationId: "getThing",
          parameters: [
            { name: "id", in: "path", required: true, schema: { type: ["integer", "null"] } },
            { name: "tags", in: "query", schema: { type: ["array", "null"], items: { type: "string" } } },
          ],
          responses: { "200": {} },
        },
      },
    },
  });
  let got: { params: Record<string, unknown>; query: Record<string, unknown> } | undefined;
  const { router } = build(
    { spec: "openapi.json" },
    {
      "/app/operations/getThing": {
        default: (i: { params: Record<string, unknown>; query: Record<string, unknown> }) => {
          got = { params: i.params, query: i.query };
          return { body: { ok: true } };
        },
      },
    },
    spec,
  );
  const res = await router(req("GET", "/app/api/things/7", { query: "tags=x&tags=y" }));
  assert.equal(res.status, 200);
  assert.deepEqual(got, { params: { id: 7 }, query: { tags: ["x", "y"] } });
});

test("3.1 multi-type union params coerce order-independently (type array order doesn't matter)", async () => {
  // A 3.1 union like `["string","integer"]` must coerce numeric-looking values to numbers regardless
  // of where `integer`/`number` sits in the array — otherwise coercion is order-dependent and a
  // `["string","integer"]` param would never enforce numeric bounds (it'd reach the delegate as a
  // raw string), while `["integer","string"]` would. Non-numeric values still fall back to the
  // string arm, and a `number|boolean` union coerces each token to its natural type.
  const spec = JSON.stringify({
    openapi: "3.1.0",
    paths: {
      "/u": {
        get: {
          operationId: "u",
          parameters: [
            { name: "a", in: "query", required: true, schema: { type: ["string", "integer"] } },
            { name: "b", in: "query", required: true, schema: { type: ["integer", "string"] } },
            { name: "c", in: "query", required: true, schema: { type: ["string", "integer"] } },
            { name: "d", in: "query", required: true, schema: { type: ["number", "boolean"] } },
            { name: "e", in: "query", required: true, schema: { type: ["number", "boolean"] } },
          ],
          responses: { "200": {} },
        },
      },
    },
  });
  let got: { query: Record<string, unknown> } | undefined;
  const { router } = build(
    { spec: "openapi.json" },
    {
      "/app/operations/u": {
        default: (i: { query: Record<string, unknown> }) => {
          got = { query: i.query };
          return { body: { ok: true } };
        },
      },
    },
    spec,
  );
  const res = await router(req("GET", "/app/api/u", { query: "a=42&b=42&c=hello&d=3.5&e=true" }));
  assert.equal(res.status, 200);
  // a and b both coerce to 42 despite opposite type-array order; c stays a string (only fits the
  // union's string arm); d coerces to a number, e to a boolean.
  assert.deepEqual(got, { query: { a: 42, b: 42, c: "hello", d: 3.5, e: true } });
});

test("a typeless numeric const/enum query param coerces (so its number-literal type is satisfiable)", async () => {
  const enumSpec = JSON.stringify({
    openapi: "3.1.0",
    paths: {
      "/pick": {
        get: {
          operationId: "pick",
          parameters: [
            { name: "v", in: "query", required: true, schema: { enum: [1, 2, 3] } }, // no `type`
            { name: "k", in: "query", required: true, schema: { const: 7 } }, // no `type`
          ],
          responses: { "200": {} },
        },
      },
    },
  });
  let got: { query: Record<string, unknown> } | undefined;
  const { router } = build(
    { spec: "openapi.json" },
    {
      "/app/operations/pick": {
        default: (i: { query: Record<string, unknown> }) => {
          got = { query: i.query };
          return { body: { ok: true } };
        },
      },
    },
    enumSpec,
  );
  // A valid enum/const value coerces to a number and passes validation (would 400 if left a string).
  const ok = await router(req("GET", "/app/api/pick", { query: "v=2&k=7" }));
  assert.equal(ok.status, 200);
  assert.deepEqual(got, { query: { v: 2, k: 7 } });
  // An out-of-set value still fails validation (coercion doesn't loosen the constraint).
  const bad = await router(req("GET", "/app/api/pick", { query: "v=9&k=7" }));
  assert.equal(bad.status, 400);
});

test("response validation is status-keyed: a documented error body validates against ITS schema", async () => {
  const respSpec = JSON.stringify({
    openapi: "3.0.0",
    components: {
      schemas: {
        Ok: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"], additionalProperties: false },
        Err: { type: "object", properties: { error: { type: "string" } }, required: ["error"], additionalProperties: false },
      },
    },
    paths: {
      "/do": {
        post: {
          operationId: "doIt",
          responses: {
            "200": { content: { "application/json": { schema: { $ref: "#/components/schemas/Ok" } } } },
            "400": { content: { "application/json": { schema: { $ref: "#/components/schemas/Err" } } } },
          },
        },
      },
    },
  });
  const runWith = (result: { status: number; body: unknown }) => {
    const b = build(
      { spec: "openapi.json", validateResponses: "always" },
      { "/app/operations/doIt": { default: () => result } },
      respSpec,
    );
    return { call: b.router(req("POST", "/app/api/do", { body: "{}" })), logs: b.logs };
  };
  // A valid documented 400 error body must NOT warn — the pre-fix code validated it against the 200
  // success schema and warned. Now it's checked against the 400 schema and passes.
  const okErr = runWith({ status: 400, body: { error: "bad ref" } });
  await okErr.call;
  assert.equal(okErr.logs.some((l) => l.msg.includes("response failed schema validation")), false);
  // A body that violates the 400 schema DOES warn (proves it's validated against Err, not Ok).
  const badErr = runWith({ status: 400, body: { oops: 1 } });
  await badErr.call;
  assert.equal(badErr.logs.some((l) => l.msg.includes("response failed schema validation")), true);
});

test("a failed initial spec load is retried, not cached as a permanent 500", async () => {
  let attempts = 0;
  const host: HostContext = {
    runtime: "node",
    env: () => undefined,
    readTextFile: async () => {
      attempts++;
      if (attempts === 1) throw new Error("ENOENT: spec missing");
      return spec;
    },
    listDir: async () => [],
    exists: async () => false,
    openSqlite: () => {
      throw new Error("sqlite not used in this test");
    },
    importModule: () => Promise.resolve({ default: () => ({ body: { ok: true } }) }),
    serveHttp: async () => ({ port: 0, stop: async () => {} }),
    now: () => 0,
    log: () => {},
  };
  const manifest: AppManifest = { schemaVersion: 1, id: "t", name: "T" };
  Reflect.set(manifest, "api", { spec: "openapi.json" });
  const ctx: RuntimeContext = { root: "/app", manifest, engine, host };
  const router = makeRouter(mountApi(ctx, appFixture()).routes);
  const first = await Promise.resolve(router(req("GET", "/app/api/invoices/42")));
  assert.equal(first.status, 500); // initial read fails
  const second = await Promise.resolve(router(req("GET", "/app/api/invoices/42")));
  assert.equal(second.status, 200); // retried (opsPromise not cached as a rejection)
});

test("an op declaring no requestBody gets body:undefined at runtime (matches derived body-less type)", async () => {
  // The deriver types `body` as `undefined` for an op with no requestBody, so the runtime must not
  // leak a parsed JSON value into such a body-less handler.
  const noBodySpec = JSON.stringify({
    openapi: "3.0.0",
    paths: {
      "/ping": {
        post: { operationId: "ping", responses: { "200": {} } },
      },
    },
  });
  let seenBody: unknown = "unset";
  const { router } = build(
    { spec: "openapi.json" },
    { "/app/operations/ping": { default: (i: { body: unknown }) => { seenBody = i.body; return { body: { ok: true } }; } } },
    noBodySpec,
  );
  const res = await router(req("POST", "/app/api/ping", { body: JSON.stringify({ sneaky: true }) }));
  assert.equal(res.status, 200);
  assert.equal(seenBody, undefined);
});

test("readApiBinding trims whitespace on dir/spec so benign formatting can't break resolution", async () => {
  let got: Record<string, string> | undefined;
  const { router, imported } = build(
    { spec: "  openapi.json  ", dir: "  operations  " },
    { "/app/operations/getInvoice": { default: (i: { params: Record<string, string> }) => { got = i.params; return { body: { ok: true } }; } } },
  );
  const res = await router(req("GET", "/app/api/invoices/42"));
  assert.equal(res.status, 200);
  assert.deepEqual(got, { id: "42" });
  // dir was trimmed → the delegate resolved at the clean path, not "operations  /getInvoice".
  assert.ok(imported.includes("/app/operations/getInvoice"));
});

test("loadModule strips a trailing backslash from api.dir (Windows-style path)", async () => {
  const { router, imported } = build(
    { spec: "openapi.json", dir: "operations\\" },
    { "/app/operations/getInvoice": { default: () => ({ body: { ok: true } }) } },
  );
  const res = await router(req("GET", "/app/api/invoices/42"));
  assert.equal(res.status, 200);
  assert.ok(imported.includes("/app/operations/getInvoice"));
});

test("a static route is not shadowed by a templated one regardless of spec order", async () => {
  // Lexicographically "/items/{id}" sorts before "/items/active"; specificity ordering must still
  // route the static path to its own delegate.
  const specText = JSON.stringify({
    openapi: "3.0.0",
    paths: {
      "/items/{id}": { get: { operationId: "getItem", parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }], responses: { "200": {} } } },
      "/items/active": { get: { operationId: "listActive", responses: { "200": {} } } },
    },
  });
  const { router } = build(
    { spec: "openapi.json" },
    {
      "/app/operations/getItem": { default: () => ({ body: { which: "template" } }) },
      "/app/operations/listActive": { default: () => ({ body: { which: "static" } }) },
    },
    specText,
  );
  const res = await router(req("GET", "/app/api/items/active"));
  assert.equal(res.status, 200);
  assert.equal(JSON.parse(res.body ?? "{}").which, "static");
});

test("an unsafe operationId never mounts (skipped) — a crafted spec can't import outside operations", async () => {
  const specText = JSON.stringify({
    openapi: "3.0.0",
    paths: { "/x": { get: { operationId: "../../evil", responses: { "200": {} } } } },
  });
  const { router, imported } = build({ spec: "openapi.json" }, {}, specText);
  const res = await router(req("GET", "/app/api/x"));
  assert.equal(res.status, 404); // no route mounted for the skipped op
  assert.equal(imported.some((p) => p.includes("evil")), false);
});

test("serves the OpenAPI spec at {base}-docs/openapi.json, rebased to the mounted namespace", async () => {
  const { router } = build({ spec: "openapi.json" }, {});
  const res = await router(req("GET", "/app/api-docs/openapi.json"));
  assert.equal(res.status, 200);
  assert.match(res.headers?.["content-type"] ?? "", /application\/json/);
  const doc = JSON.parse(res.body ?? "{}");
  // The doc is served intact...
  assert.ok(doc.paths["/invoices"], "keeps the operation paths");
  // ...but `servers` is rebased to `base` (document-relative, issue #151) so Swagger UI "Try it
  // out" hits the real routes both at the origin root and under the Nano console reverse proxy
  // (operations mount under /app/api, not the spec's bare /invoices).
  assert.deepEqual(doc.servers, [{ url: "api" }]);
});

test("serves the Swagger UI page at {base}-docs by default", async () => {
  const { router } = build({ spec: "openapi.json" }, {});
  const res = await router(req("GET", "/app/api-docs"));
  assert.equal(res.status, 200);
  assert.match(res.headers?.["content-type"] ?? "", /text\/html/);
  const body = res.body ?? "";
  assert.match(body, /swagger-ui/);
  // The page derives ABSOLUTE spec + server URLs from window.location (issue #151 + the trailing-
  // slash 404): the embedded derivation is passed the mount-root docs base, operations base, and a
  // document-relative fallback. It must never hard-code a root-absolute "/app/api-docs/openapi.json"
  // that would escape the Nano console reverse-proxy prefix.
  assert.match(body, /window\.location\.href/);
  assert.match(body, /"\/app\/api-docs"/); // docsBase handed to the client derivation
  assert.match(body, /"\/app\/api"/); //     operations base handed to the client derivation
  assert.match(body, /"api-docs\/openapi\.json"/); // document-relative fallback
  assert.doesNotMatch(body, /url: "\/app\/api-docs\/openapi\.json"/);
});

test("the rendered docs page runs its derivation end-to-end and targets the app through the proxy", async () => {
  const { router } = build({ spec: "openapi.json" }, {});
  const res = await router(req("GET", "/app/api-docs"));
  const body = res.body ?? "";
  // Extract the inline bootstrap <script> (the one that is NOT the swagger-ui-bundle src include).
  const scripts = [...body.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  assert.ok(scripts.length >= 1, "expected an inline bootstrap script");
  const boot = scripts[scripts.length - 1];
  // 1) It must be syntactically valid JS (guards the `${derive.toString()}` template interpolation).
  const runBoot = new Function("window", "SwaggerUIBundle", "fetch", boot);
  // 2) Execute it in a mocked browser at the EXACT reported failing URL (proxy prefix + trailing
  //    slash) and assert the servers override Swagger UI receives is the app's /app/api under the
  //    proxy — never the /app/api-docs/api that produced the 404.
  const specDoc = { openapi: "3.0.3", paths: {}, servers: [{ url: "api" }] };
  let received: unknown;
  const swaggerStub = (opts: { spec?: { servers?: unknown } }): unknown => {
    received = opts.spec?.servers;
    return {};
  };
  const proxySlashUrl = "http://127.0.0.1:8080/console/app-view/Nano_Workforce/app/api-docs/";
  const win: { location: { href: string }; ui?: unknown } = { location: { href: proxySlashUrl } };
  let fetched = "";
  const fetchStub = (url: string): Promise<{ ok: boolean; json: () => Promise<unknown> }> => {
    fetched = url;
    return Promise.resolve({ ok: true, json: () => Promise.resolve(specDoc) });
  };
  runBoot(win, swaggerStub, fetchStub);
  await new Promise((r) => setTimeout(r, 0)); // let the fetch().then microtasks settle
  assert.equal(
    fetched,
    "http://127.0.0.1:8080/console/app-view/Nano_Workforce/app/api-docs/openapi.json",
    "spec is fetched at an absolute, proxy-prefixed URL (immune to the trailing slash)",
  );
  assert.deepEqual(received, [
    { url: "http://127.0.0.1:8080/console/app-view/Nano_Workforce/app/api" },
    // ^ Try it out now targets the app's operations base under the proxy, not /app/api-docs/api.
  ]);
});

test("deriveSwaggerUrls: absolute spec+server from the page URL, immune to trailing slash + proxy prefix", () => {
  const docsBase = "/app/api-docs";
  const apiBase = "/app/api";
  const rel = "api-docs/openapi.json";
  // Direct CLI (:3000), no trailing slash — the canonical case.
  assert.deepEqual(deriveSwaggerUrls("http://127.0.0.1:3000/app/api-docs", docsBase, apiBase, rel), {
    specUrl: "http://127.0.0.1:3000/app/api-docs/openapi.json",
    server: "http://127.0.0.1:3000/app/api",
  });
  // Direct CLI WITH a trailing slash — a relative "servers: api" used to resolve to
  // /app/api-docs/api here (the reported 404). The absolute derivation is unaffected.
  assert.deepEqual(deriveSwaggerUrls("http://127.0.0.1:3000/app/api-docs/", docsBase, apiBase, rel), {
    specUrl: "http://127.0.0.1:3000/app/api-docs/openapi.json",
    server: "http://127.0.0.1:3000/app/api",
  });
  // Under the Nano console reverse proxy — the mount prefix is preserved in both URLs.
  assert.deepEqual(
    deriveSwaggerUrls(
      "http://127.0.0.1:8080/console/app-view/Nano_Workforce/app/api-docs",
      docsBase,
      apiBase,
      rel,
    ),
    {
      specUrl: "http://127.0.0.1:8080/console/app-view/Nano_Workforce/app/api-docs/openapi.json",
      server: "http://127.0.0.1:8080/console/app-view/Nano_Workforce/app/api",
    },
  );
  // Proxy WITH a trailing slash — the exact failure the user reported. Now correct.
  assert.deepEqual(
    deriveSwaggerUrls(
      "http://127.0.0.1:8080/console/app-view/Nano_Workforce/app/api-docs/",
      docsBase,
      apiBase,
      rel,
    ),
    {
      specUrl: "http://127.0.0.1:8080/console/app-view/Nano_Workforce/app/api-docs/openapi.json",
      server: "http://127.0.0.1:8080/console/app-view/Nano_Workforce/app/api",
    },
  );
  // A query string / fragment on the docs URL is ignored (pathname only).
  assert.equal(
    deriveSwaggerUrls("http://127.0.0.1:3000/app/api-docs?x=1#y", docsBase, apiBase, rel).server,
    "http://127.0.0.1:3000/app/api",
  );
});

test("deriveSwaggerUrls: a custom docs path keeps the proxy prefix too", () => {
  // A string `docs` override lands the page at a root-level `/help`; the derivation still recovers
  // the (proxy-prefixed) mount root by stripping that suffix and re-appending the operations base.
  assert.deepEqual(
    deriveSwaggerUrls(
      "http://127.0.0.1:8080/console/app-view/App/help/",
      "/help",
      "/app/api",
      "help/openapi.json",
    ),
    {
      specUrl: "http://127.0.0.1:8080/console/app-view/App/help/openapi.json",
      server: "http://127.0.0.1:8080/console/app-view/App/app/api",
    },
  );
});

test("deriveSwaggerUrls: falls back to the document-relative spec when the path doesn't match or href is bad", () => {
  const docsBase = "/app/api-docs";
  const apiBase = "/app/api";
  const rel = "api-docs/openapi.json";
  // Page path doesn't end in docsBase (unexpected) → keep the relative fallback, no server override.
  assert.deepEqual(deriveSwaggerUrls("http://127.0.0.1:3000/elsewhere", docsBase, apiBase, rel), {
    specUrl: rel,
    server: null,
  });
  // Malformed href → same safe fallback (no throw).
  assert.deepEqual(deriveSwaggerUrls("not a url", docsBase, apiBase, rel), {
    specUrl: rel,
    server: null,
  });
});

test("the trailing-slash docs variant 308-redirects to the canonical path", async () => {
  const { router } = build({ spec: "openapi.json" }, {});
  // The router exact-matches non-prefix routes, so `${base}-docs/` (common from proxies/browsers)
  // would 404 without an explicit alias. It must permanent-redirect to the slash-less canonical.
  const res = await router(req("GET", "/app/api-docs/"));
  assert.equal(res.status, 308);
  assert.equal(res.headers?.["location"], "/app/api-docs");
});

test("docs default on is reflected in describe()", () => {
  const { handle } = buildHandle({ spec: "openapi.json" });
  const d = handle.describe();
  assert.deepEqual(d.api, {
    spec: "openapi.json",
    base: "/app/api",
    dir: "operations",
    eject: false,
    docs: { ui: "/app/api-docs", spec: "/app/api-docs/openapi.json" },
  });
});

test("docs:false disables both the UI and the spec route (no reserved paths)", async () => {
  const { router } = build({ spec: "openapi.json", docs: false }, {});
  // With docs off, the docs paths fall through to the operation dispatcher → no such operation.
  assert.equal((await router(req("GET", "/app/api-docs"))).status, 404);
  assert.equal((await router(req("GET", "/app/api-docs/openapi.json"))).status, 404);
});

test("a string docs overrides the UI route (and the spec route beneath it)", async () => {
  const { router } = build({ spec: "openapi.json", docs: "/help" }, {});
  assert.equal((await router(req("GET", "/help"))).status, 200);
  assert.equal((await router(req("GET", "/help/openapi.json"))).status, 200);
  // The default docs path is no longer served.
  assert.equal((await router(req("GET", "/app/api-docs"))).status, 404);
});

test("apiDocsPath resolves the UI route (and honours disable / override)", () => {
  assert.equal(apiDocsPath({ api: { spec: "openapi.json" } }), "/app/api-docs");
  assert.equal(apiDocsPath({ api: { spec: "openapi.json", base: "/x" } }), "/app/api-docs"); // base ignored
  assert.equal(apiDocsPath({ api: { spec: "openapi.json", docs: "/help" } }), "/help");
  assert.equal(apiDocsPath({ api: { spec: "openapi.json", docs: false } }), undefined);
  assert.equal(apiDocsPath({}), undefined);
});

// ── Security enforcement (ADR 0059: apiKey-guarded webhook operations) ────────────────────────

const securedSpec = JSON.stringify({
  openapi: "3.0.0",
  components: {
    securitySchemes: {
      webhookKey: { type: "apiKey", in: "header", name: "X-Webhook-Key", "x-nano-secret-env": "NANO_WEBHOOK_KEY" },
    },
  },
  paths: {
    "/hooks/submit": {
      post: {
        operationId: "submitHook",
        security: [{ webhookKey: [] }],
        responses: { "204": {} },
      },
    },
  },
});

test("secured operation: correct apiKey header reaches the delegate (200)", async () => {
  const seen: unknown[] = [];
  const handler: OperationHandler = (input) => {
    seen.push(input);
    return { status: 200, body: { ok: true } };
  };
  const { router, imported } = build(
    { spec: "openapi.json", dir: "operations" },
    { "/app/operations/submitHook": { default: handler } },
    securedSpec,
    (v) => (v === "NANO_WEBHOOK_KEY" ? "s3cret" : undefined),
  );
  const res = await router(
    req("POST", "/app/api/hooks/submit", { body: "{}", headers: { "X-Webhook-Key": "s3cret" } }),
  );
  assert.equal(res.status, 200);
  assert.equal(seen.length, 1);
  assert.deepEqual(imported, ["/app/operations/submitHook"]);
});

test("secured operation: missing/wrong apiKey is rejected 401 without loading the delegate", async () => {
  const { router, imported } = build(
    { spec: "openapi.json", dir: "operations" },
    { "/app/operations/submitHook": { default: () => ({ status: 200 }) } },
    securedSpec,
    (v) => (v === "NANO_WEBHOOK_KEY" ? "s3cret" : undefined),
  );
  const missing = await router(req("POST", "/app/api/hooks/submit", { body: "{}" }));
  assert.equal(missing.status, 401);
  const wrong = await router(
    req("POST", "/app/api/hooks/submit", { body: "{}", headers: { "X-Webhook-Key": "nope" } }),
  );
  assert.equal(wrong.status, 401);
  // The delegate must never run for an unauthorized request.
  assert.deepEqual(imported, []);
});

test("secured operation: an unset secret env fails closed with 500 (misconfiguration)", async () => {
  const { router, logs } = build(
    { spec: "openapi.json", dir: "operations" },
    { "/app/operations/submitHook": { default: () => ({ status: 200 }) } },
    securedSpec,
    () => undefined, // NANO_WEBHOOK_KEY not set
  );
  const res = await router(
    req("POST", "/app/api/hooks/submit", { body: "{}", headers: { "X-Webhook-Key": "anything" } }),
  );
  assert.equal(res.status, 500);
  assert.ok(logs.some((l) => l.level === "error" && /security is misconfigured/.test(l.msg)));
});

// ── Generated controller registry (ADR 0059) ────────────────────────────────────────────────────
// When `nano-generated/controller.ts` is present, dispatch resolves delegates from its exported
// `operations` map (deterministic, drift-checked) instead of per-op path imports.

test("controller present: dispatch uses the registry, not a per-op import", async () => {
  const seen: unknown[] = [];
  const handler: OperationHandler = (input) => {
    seen.push(input.params);
    return { status: 200, body: { ok: true } };
  };
  const { router, imported } = build(
    { spec: "openapi.json" },
    {
      "/app/nano-generated/controller": { operations: { getInvoice: handler } },
    },
    spec,
    () => undefined,
    ["/app/nano-generated/controller.ts"],
  );
  const res = await router(req("GET", "/app/api/invoices/7"));
  assert.equal(res.status, 200);
  assert.deepEqual(seen, [{ id: "7" }]);
  // Only the controller barrel is imported — never a per-operation delegate path.
  assert.deepEqual(imported, ["/app/nano-generated/controller"]);
});

test("controller present: request validation still runs before the registry delegate", async () => {
  const handler: OperationHandler = () => ({ status: 201, body: { id: "i", amount: 1 } });
  const { router } = build(
    { spec: "openapi.json" },
    { "/app/nano-generated/controller": { operations: { createInvoice: handler } } },
    spec,
    () => undefined,
    ["/app/nano-generated/controller.ts"],
  );
  // amount:0 violates minimum:1 → a 400 from validation, before the delegate.
  const res = await router(req("POST", "/app/api/invoices", { body: JSON.stringify({ id: "i", amount: 0 }) }));
  assert.equal(res.status, 400);
  assert.match(JSON.parse(res.body!).error, /request validation failed/);
});

test("controller present but missing a delegate key → 500 with a run-`urban gen` hint", async () => {
  const { router, logs } = build(
    { spec: "openapi.json" },
    { "/app/nano-generated/controller": { operations: {} } }, // stale: getInvoice not registered
    spec,
    () => undefined,
    ["/app/nano-generated/controller.ts"],
  );
  const res = await router(req("GET", "/app/api/invoices/7"));
  assert.equal(res.status, 500);
  assert.match(JSON.parse(res.body!).error, /is not registered/);
  assert.ok(logs.some((l) => l.level === "error" && /not registered in the generated controller/.test(l.msg)));
});

test("a NotImplemented throw from a delegate maps to HTTP 501", async () => {
  const stub: OperationHandler = () => {
    throw new NotImplemented("getInvoice");
  };
  const { router } = build(
    { spec: "openapi.json" },
    { "/app/nano-generated/controller": { operations: { getInvoice: stub } } },
    spec,
    () => undefined,
    ["/app/nano-generated/controller.ts"],
  );
  const res = await router(req("GET", "/app/api/invoices/7"));
  assert.equal(res.status, 501);
  const bodyJson = JSON.parse(res.body!);
  assert.equal(bodyJson.operationId, "getInvoice");
  assert.match(bodyJson.error, /not implemented/);
});

test("no controller present → back-compat per-op import path still works", async () => {
  const { router, imported } = build(
    { spec: "openapi.json" },
    { "/app/operations/getInvoice": { default: () => ({ body: { ok: true } }) } },
    // no exists paths → controller absent
  );
  const res = await router(req("GET", "/app/api/invoices/9"));
  assert.equal(res.status, 200);
  assert.deepEqual(imported, ["/app/operations/getInvoice"]);
});

test("compiled app: controller.js present (no .ts) → still uses the registry", async () => {
  // A published / `urban run` build ships controller.js with TS sources absent. Probing only .ts
  // would wrongly report the registry missing and fall back to per-op imports; probe all extensions.
  const handler: OperationHandler = () => ({ status: 200, body: { ok: true } });
  const { router, imported } = build(
    { spec: "openapi.json" },
    { "/app/nano-generated/controller": { operations: { getInvoice: handler } } },
    spec,
    () => undefined,
    ["/app/nano-generated/controller.js"], // only the compiled artifact exists on disk
  );
  const res = await router(req("GET", "/app/api/invoices/7"));
  assert.equal(res.status, 200);
  assert.deepEqual(imported, ["/app/nano-generated/controller"]);
});
