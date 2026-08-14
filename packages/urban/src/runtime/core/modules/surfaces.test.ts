// Security regression tests for the hosted surfaces: manifest-provided values
// (surface paths, chat agent) must not be able to inject markup/script.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mountSurfaces } from "./surfaces.ts";
import type { EngineClient, HostContext, HttpRequest, HttpResponse } from "../host.ts";
import { DataLayer } from "./datasource.ts";
import { createLogger } from "../logger.ts";

function ctxWith(surfaces: Record<string, unknown>): Parameters<typeof mountSurfaces>[0] {
  const host: HostContext = {
    runtime: "node",
    env: () => undefined,
    readTextFile: async () => "",
    listDir: async () => [],
    exists: async () => false,
    openSqlite: () => {
      throw new Error("sqlite not used in this test");
    },
    importModule: async () => ({}),
    serveHttp: async () => ({ port: 0, stop: async () => {} }),
    now: () => 0,
    log: () => {},
  };
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
  return { root: ".", manifest: { schemaVersion: 1, id: "app", name: "App", surfaces }, host, engine };
}

const fakeEngine: EngineClient = {
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

const fakeApp: Parameters<typeof mountSurfaces>[1] = {
  manifest: { schemaVersion: 1, id: "app", name: "App" },
  data: new DataLayer(new Map(), undefined, {}),
  engine: fakeEngine,
  env: () => undefined,
  log: createLogger(() => {}),
};

async function render(route: { handler: (req: HttpRequest) => HttpResponse | Promise<HttpResponse> }): Promise<string> {
  const res = await route.handler({
    method: "GET",
    path: "/",
    query: new URLSearchParams(),
    headers: new Headers(),
    text: async () => "",
  });
  return String(res.body);
}

test("chat agent is HTML-escaped in the mount page", async () => {
  const s = mountSurfaces(ctxWith({ chat: { enabled: true, agent: "<img src=x onerror=alert(1)>" } }), fakeApp);
  const chatRoute = s.routes.find((r) => r.source === "surface:chat" && r.method === "GET")!;
  const body = await render(chatRoute);
  assert.ok(!body.includes("<img src=x"), "raw markup must not appear");
  assert.ok(body.includes("&lt;img src=x onerror=alert(1)&gt;"), "agent is escaped");
});

test("task-inbox path is injected as a quoted JS literal (no script breakout)", async () => {
  const evil = "/tasks'});alert(1);//x";
  const s = mountSurfaces(ctxWith({ taskInbox: { enabled: true, path: evil } }), fakeApp);
  const page = s.routes.find((r) => r.source === "surface:taskInbox" && r.method === "GET" && !r.path.endsWith("/api/tasks"))!;
  const body = await render(page);
  // The path is embedded via JSON.stringify, so the raw breakout sequence must
  // not appear unescaped inside the <script>.
  assert.ok(!body.includes("'});alert(1);//'"), "no raw single-quoted breakout");
  assert.ok(body.includes(JSON.stringify(evil)), "path embedded as a JSON string literal");
});

/** Build an app handle backed by a specific engine (the flow tests drive the routes). */
function appWith(engine: EngineClient): Parameters<typeof mountSurfaces>[1] {
  return {
    manifest: { schemaVersion: 1, id: "app", name: "App" },
    data: new DataLayer(new Map(), undefined, {}),
    engine,
    env: () => undefined,
    log: createLogger(() => {}),
  };
}

/** Invoke a route handler with an optional query string and POST body. */
async function call(
  route: { handler: (req: HttpRequest) => HttpResponse | Promise<HttpResponse> },
  opts: { method?: string; query?: string; body?: string } = {},
): Promise<HttpResponse> {
  return route.handler({
    method: opts.method ?? "GET",
    path: "/",
    query: new URLSearchParams(opts.query ?? ""),
    headers: new Headers(),
    text: async () => opts.body ?? "",
  });
}

function inboxRoutes(engine: EngineClient) {
  const s = mountSurfaces(ctxWith({ taskInbox: { enabled: true, path: "/tasks" } }), appWith(engine));
  const at = (suffix: string, method = "GET") =>
    s.routes.find(
      (r) => r.source === "surface:taskInbox" && r.method === method && r.path.endsWith(suffix),
    )!;
  return {
    page: s.routes.find((r) => r.source === "surface:taskInbox" && r.method === "GET" && r.path === "/tasks")!,
    tasks: at("/api/tasks"),
    form: at("/api/form"),
    complete: at("/api/complete", "POST"),
  };
}

test("inbox page renders the client-side form fetch + renderer", async () => {
  const { page } = inboxRoutes(fakeEngine);
  const rendered = String((await call(page)).body);
  assert.ok(rendered.includes("/api/form"), "page fetches the linked form");
  assert.ok(rendered.includes("function renderForm"), "page has a form renderer");
  assert.ok(rendered.includes("function buildField"), "page builds fields from the schema");
  assert.ok(rendered.includes("/api/complete"), "page posts completion");
});

test("/api/tasks surfaces the resolved form linkage", async () => {
  let seenFilter: unknown;
  const engine: EngineClient = {
    ...fakeEngine,
    searchUserTasks: async (filter) => {
      seenFilter = filter;
      return [
        { userTaskKey: "1", elementId: "approve", formKey: "form-123" },
        { userTaskKey: "2", elementId: "review" },
      ];
    },
  };
  const { tasks } = inboxRoutes(engine);
  const res = await call(tasks, { query: "processInstanceKey=pi-9" });
  assert.deepEqual(seenFilter, { processInstanceKey: "pi-9" });
  const parsed = JSON.parse(String(res.body));
  assert.equal(parsed[0].formKey, "form-123");
  assert.equal(parsed[1].formKey, undefined);
});

test("/api/form resolves a linked form's schema", async () => {
  let seen: unknown;
  const schema = { type: "default", schemaVersion: 18, components: [{ type: "textfield", key: "name", label: "Name" }] };
  const engine: EngineClient = {
    ...fakeEngine,
    getForm: async (input) => {
      seen = input;
      return { formKey: "form-123", schema };
    },
  };
  const { form } = inboxRoutes(engine);
  const res = await call(form, { query: "formKey=form-123" });
  assert.deepEqual(seen, { formKey: "form-123", formId: undefined });
  assert.equal(res.status, 200);
  assert.deepEqual(JSON.parse(String(res.body)).schema, schema);
});

test("/api/form requires an identifier", async () => {
  const { form } = inboxRoutes(fakeEngine);
  const res = await call(form);
  assert.equal(res.status, 400);
});

test("/api/form returns 204 for a task with no resolvable form (no-form fallback)", async () => {
  const engine: EngineClient = { ...fakeEngine, getForm: async () => null };
  const { form } = inboxRoutes(engine);
  const res = await call(form, { query: "formKey=missing" });
  assert.equal(res.status, 204);
  // The body must be empty: a "null" payload (json(null, 204)) makes the client's
  // fetch helper throw on parse and surface "Failed to load form" instead of the
  // no-form fallback. Guard the wire shape here and the client short-circuit below.
  assert.equal(res.body, "");
});

test("inbox client fetch helper short-circuits 204 so the no-form fallback renders", async () => {
  const { page } = inboxRoutes(fakeEngine);
  const rendered = String((await call(page)).body);
  // The api() helper must not call r.json() on a 204 (empty body → throw). It has
  // to resolve to null so openForm() falls through to renderNoForm(t).
  assert.ok(rendered.includes("r.status===204"), "api() short-circuits a 204 response");
  assert.ok(rendered.includes("function renderNoForm"), "page has a no-form renderer");
});

test("/api/complete completes the task with the submitted variables", async () => {
  const calls: { key: string; variables?: Record<string, unknown> }[] = [];
  const engine: EngineClient = {
    ...fakeEngine,
    completeUserTask: async (key, variables) => {
      calls.push({ key, variables });
    },
  };
  const { complete } = inboxRoutes(engine);
  const res = await call(complete, { method: "POST", body: JSON.stringify({ userTaskKey: "7", variables: { name: "Ada", agree: true } }) });
  assert.equal(res.status, 200);
  assert.deepEqual(calls, [{ key: "7", variables: { name: "Ada", agree: true } }]);
});

test("/api/complete rejects a body with no userTaskKey", async () => {
  const { complete } = inboxRoutes(fakeEngine);
  const res = await call(complete, { method: "POST", body: JSON.stringify({ variables: {} }) });
  assert.equal(res.status, 400);
});

