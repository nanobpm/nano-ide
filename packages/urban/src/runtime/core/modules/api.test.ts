import { test } from "node:test";
import assert from "node:assert/strict";
import type { AppApi, RuntimeContext } from "../context.ts";
import type { AppManifest } from "../manifest.ts";
import type { EngineClient, HostContext, HttpRequest } from "../host.ts";
import { makeRouter } from "../router.ts";
import { DataLayer } from "./datasource.ts";
import { mountApi, resolveOperationHandler, type OperationHandler } from "./api.ts";

function req(method: string, path: string, opts: { query?: string; body?: string } = {}): HttpRequest {
  return {
    method,
    path,
    query: new URLSearchParams(opts.query ?? ""),
    headers: new Headers(),
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
  return { manifest: { schemaVersion: 1, id: "t", name: "T" }, data, engine, env: () => undefined, log: () => {} };
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
  router: (r: HttpRequest) => Promise<{ status?: number; body?: string }>;
  imported: string[];
  logs: Array<{ level: string; msg: string }>;
}

function build(
  api: Record<string, unknown> | undefined,
  modules: Record<string, Record<string, unknown>>,
  specText = spec,
): Built {
  const imported: string[] = [];
  const logs: Array<{ level: string; msg: string }> = [];
  const host: HostContext = {
    runtime: "node",
    env: () => undefined,
    readTextFile: async () => specText,
    listDir: async () => [],
    exists: async () => false,
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
  const handle = mountApi(ctx, appFixture());
  const router = makeRouter(handle.routes);
  return { router: (r) => Promise.resolve(router(r)), imported, logs };
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

test("a manifest api.base without a leading slash is normalized so routes still match", async () => {
  let got: Record<string, string> | undefined;
  const { router } = build(
    { spec: "openapi.json", base: "app/api" }, // no leading slash
    { "/app/operations/getInvoice": { default: (i: { params: Record<string, string> }) => { got = i.params; return { body: { ok: true } }; } } },
  );
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
  // First value valid, second (0) violates minimum:1 — must still be caught.
  const res = await router(req("GET", "/app/api/items", { query: "n=5&n=0" }));
  assert.equal(res.status, 400);
  assert.match(JSON.parse(res.body!).error, /validation failed/);
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

test("readApiBinding trims whitespace on base/dir/spec so benign formatting can't break resolution", async () => {
  let got: Record<string, string> | undefined;
  const { router, imported } = build(
    { spec: "  openapi.json  ", base: "  app/api  ", dir: "  operations  " },
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
