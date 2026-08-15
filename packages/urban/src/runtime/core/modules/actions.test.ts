import { test } from "node:test";
import { createLogger } from "../logger.ts";
import assert from "node:assert/strict";
import type { AppApi, RuntimeContext } from "../context.ts";
import type { EngineClient, HostContext, HttpRequest } from "../host.ts";
import { makeRouter } from "../router.ts";
import { mountActions, resolveActionHandler, type ActionHandler } from "./actions.ts";
import { DataLayer } from "./datasource.ts";

function req(method: string, path: string, opts: { query?: string; body?: string } = {}): HttpRequest {
  return {
    method,
    path,
    query: new URLSearchParams(opts.query ?? ""),
    headers: new Headers(),
    text: () => Promise.resolve(opts.body ?? ""),
  };
}

interface Built {
  router: (r: HttpRequest) => Promise<{ status?: number; body?: string }>;
  imported: string[];
  logs: Array<{ level: string; msg: string }>;
}

const engine: EngineClient = {
  deployResources: async () => ({ deployed: 0 }),
  createInstance: async () => ({ processInstanceKey: "pi" }),
  cancelInstance: async () => {},
  publishMessage: async () => {},
  searchUserTasks: async () => [],
  getForm: async () => null,
  completeUserTask: async () => {},
  searchProcessInstances: async () => [],
  registerWorker: async (jobType) => ({ jobType, unsubscribe: async () => {} }),
  close: async () => {},
};

const data = new DataLayer(new Map(), undefined, {});

function appFixture(over: Partial<AppApi> = {}): AppApi {
  return {
    manifest: { schemaVersion: 1, id: "t", name: "T" },
    data,
    engine,
    env: () => undefined,
    log: createLogger(() => {}),
    ...over,
  };
}

function route(router: ReturnType<typeof makeRouter>): Built["router"] {
  return async (r) => router(r);
}

function build(
  actions: RuntimeContext["manifest"]["actions"],
  modules: Record<string, Record<string, unknown>>,
  app: AppApi = appFixture(),
): Built {
  const imported: string[] = [];
  const logs: Array<{ level: string; msg: string }> = [];
  const host: HostContext = {
    runtime: "node",
    env: () => undefined,
    readTextFile: async () => "",
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
  const ctx: RuntimeContext = {
    root: "/app",
    manifest: { schemaVersion: 1, id: "t", name: "T", actions },
    engine,
    host,
  };
  const handle = mountActions(ctx, app);
  const router = route(makeRouter(handle.routes));
  return { router, imported, logs };
}

test("resolveActionHandler prefers default, then handler", () => {
  const fn = () => ({});
  assert.equal(resolveActionHandler({ default: fn }), fn);
  assert.equal(resolveActionHandler({ handler: fn }), fn);
  assert.equal(resolveActionHandler({ default: fn, handler: () => ({}) }), fn);
  assert.equal(resolveActionHandler({ nope: fn }), undefined);
});

test("routes an action to its handler with parsed body + injected app", async () => {
  const seen: unknown[] = [];
  const app = appFixture({ manifest: { schemaVersion: 1, id: "myApp", name: "My App" } });
  const handler: ActionHandler = (input, a) => {
    seen.push({ body: input.body, method: input.req.method, app: a });
    return { status: 201, body: { ok: true } };
  };
  const { router } = build(
    [{ path: "/app/actions/cancel", module: "actions/cancel.ts" }],
    { "/app/actions/cancel.ts": { default: handler } },
    app,
  );
  const res = await router(req("POST", "/app/actions/cancel", { body: JSON.stringify({ key: "k1" }) }));
  assert.equal(res.status, 201);
  assert.deepEqual(JSON.parse(res.body!), { ok: true });
  assert.deepEqual(seen, [{ body: { key: "k1" }, method: "POST", app }]);
});

test("empty body parses to {} and a void return is 204", async () => {
  const bodies: unknown[] = [];
  const { router } = build(
    [{ path: "/app/actions/ping", module: "m.ts" }],
    { "/app/m.ts": { default: (i: { body: unknown }) => { bodies.push(i.body); } } },
  );
  const res = await router(req("POST", "/app/actions/ping"));
  assert.equal(res.status, 204);
  assert.equal(res.body, undefined);
  assert.deepEqual(bodies, [{}]);
});

test("invalid JSON body is rejected with 400 before the handler runs", async () => {
  let called = false;
  const { router, imported } = build(
    [{ path: "/a", module: "m.ts" }],
    { "/app/m.ts": { default: () => { called = true; } } },
  );
  const res = await router(req("POST", "/a", { body: "{not json" }));
  assert.equal(res.status, 400);
  assert.match(res.body!, /must be JSON/);
  assert.equal(called, false);
  assert.deepEqual(imported, []); // module not even loaded
});

test("a thrown handler error becomes a 500 with the message", async () => {
  const { router } = build(
    [{ path: "/a", module: "m.ts" }],
    { "/app/m.ts": { default: () => { throw new Error("boom"); } } },
  );
  const res = await router(req("POST", "/a", { body: "{}" }));
  assert.equal(res.status, 500);
  assert.match(res.body!, /boom/);
});

test("a module that fails to load yields a 500", async () => {
  const { router, logs } = build([{ path: "/a", module: "missing.ts" }], {});
  const res = await router(req("POST", "/a", { body: "{}" }));
  assert.equal(res.status, 500);
  assert.match(res.body!, /failed to load/);
  assert.ok(logs.some((l) => l.level === "error"));
});

test("a module with no default/handler export yields a 500", async () => {
  const { router } = build(
    [{ path: "/a", module: "m.ts" }],
    { "/app/m.ts": { notAHandler: () => ({}) } },
  );
  const res = await router(req("POST", "/a", { body: "{}" }));
  assert.equal(res.status, 500);
  assert.match(res.body!, /no default function/);
});

test("the module is imported once and cached across requests", async () => {
  const { router, imported } = build(
    [{ path: "/a", module: "m.ts" }],
    { "/app/m.ts": { default: () => ({ body: 1 }) } },
  );
  await router(req("POST", "/a", { body: "{}" }));
  await router(req("POST", "/a", { body: "{}" }));
  assert.deepEqual(imported, ["/app/m.ts"]);
});

test("method defaults to POST; a GET does not match", async () => {
  const { router } = build(
    [{ path: "/a", module: "m.ts" }],
    { "/app/m.ts": { default: () => ({ body: "ok" }) } },
  );
  const res = await router(req("GET", "/a"));
  assert.equal(res.status, 404);
});

test("a custom method is honored", async () => {
  const { router } = build(
    [{ path: "/a", method: "PUT", module: "m.ts" }],
    { "/app/m.ts": { default: () => ({ body: "ok" }) } },
  );
  assert.equal((await router(req("PUT", "/a", { body: "{}" }))).status, 200);
  assert.equal((await router(req("POST", "/a", { body: "{}" }))).status, 404);
});

test("prefix routes match by path prefix and stay boundary-safe", async () => {
  const { router } = build(
    // declared without a trailing slash — the mount adds one so it can't over-match
    [{ path: "/hooks", prefix: true, module: "m.ts" }],
    { "/app/m.ts": { default: () => ({ body: "hooked" }) } },
  );
  const hit = await router(req("POST", "/hooks/github", { body: "{}" }));
  assert.equal(hit.status, 200);
  assert.equal(JSON.parse(hit.body!), "hooked");
  // "/hooks2" must NOT match "/hooks" (raw startsWith would have over-matched)
  assert.equal((await router(req("POST", "/hooks2", { body: "{}" }))).status, 404);
});

test("an absolute module path is used as-is (not joined to root)", async () => {
  const { router, imported } = build(
    [{ path: "/a", module: "/abs/m.ts" }],
    { "/abs/m.ts": { default: () => ({ body: 1 }) } },
  );
  await router(req("POST", "/a", { body: "{}" }));
  assert.deepEqual(imported, ["/abs/m.ts"]);
});

test("declarations missing path or module are skipped with a warning", () => {
  const { router, logs } = build(
    JSON.parse('[{"path":"/a"}]'),
    {},
  );
  void router;
  assert.ok(logs.some((l) => l.level === "warn"));
});

test("a manifest path without a leading slash is normalized to match", async () => {
  const { router } = build(
    [{ path: "app/actions/go", module: "m.ts" }],
    { "/app/m.ts": { default: () => ({ body: "ok" }) } },
  );
  const res = await router(req("POST", "/app/actions/go", { body: "{}" }));
  assert.equal(res.status, 200);
});

test("a rejected import is evicted from the cache so a later load can succeed", async () => {
  let attempt = 0;
  const imported: string[] = [];
  const host: HostContext = {
    runtime: "node",
    env: () => undefined,
    readTextFile: async () => "",
    listDir: async () => [],
    exists: async () => false,
    openSqlite: () => {
      throw new Error("sqlite not used in this test");
    },
    importModule: (path: string) => {
      imported.push(path);
      attempt += 1;
      if (attempt === 1) return Promise.reject(new Error("transient"));
      return Promise.resolve({ default: () => ({ body: "ok" }) });
    },
    serveHttp: async () => ({ port: 0, stop: async () => {} }),
    now: () => 0,
    log: () => {},
  };
  const ctx: RuntimeContext = {
    root: "/app",
    manifest: { schemaVersion: 1, id: "t", name: "T", actions: [{ path: "/a", module: "m.ts" }] },
    engine,
    host,
  };
  const router = route(makeRouter(mountActions(ctx, appFixture()).routes));
  const first = await router(req("POST", "/a", { body: "{}" }));
  assert.equal(first.status, 500); // transient failure surfaces
  const second = await router(req("POST", "/a", { body: "{}" }));
  assert.equal(second.status, 200); // retry re-imports and succeeds (cache was evicted)
  assert.deepEqual(imported, ["/app/m.ts", "/app/m.ts"]);
});

test("a prefix route at the root path does not become //", async () => {
  const { router } = build(
    [{ path: "/", prefix: true, module: "m.ts" }],
    { "/app/m.ts": { default: () => ({ body: "root" }) } },
  );
  const res = await router(req("POST", "/anything/at/all", { body: "{}" }));
  assert.equal(res.status, 200);
  assert.equal(JSON.parse(res.body!), "root");
});

test("method is trimmed and falls back to POST for whitespace", async () => {
  const { router } = build(
    [{ path: "/a", method: "  post  ", module: "m.ts" }, { path: "/b", method: "   ", module: "m.ts" }],
    { "/app/m.ts": { default: () => ({ body: "ok" }) } },
  );
  assert.equal((await router(req("POST", "/a", { body: "{}" }))).status, 200);
  assert.equal((await router(req("POST", "/b", { body: "{}" }))).status, 200);
});
