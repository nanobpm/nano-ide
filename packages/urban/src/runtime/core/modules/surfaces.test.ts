// Security regression tests for the hosted surfaces: manifest-provided values
// (surface paths, chat agent) must not be able to inject markup/script.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mountSurfaces } from "./surfaces.ts";
import type { EngineClient, HostContext, HttpResponse } from "../host.ts";
import { DataLayer } from "./datasource.ts";
import { createLogger } from "../logger.ts";
import type { Route } from "../router.ts";

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
    openUserTasks: async () => [],
    getForm: async () => null,
    completeUserTask: async () => {},
    searchProcessInstances: async () => [],
    searchElementInstances: async () => [],
    searchElementInstanceWaitStates: async () => [],
    getElementInstance: async () => null,
    searchIncidents: async () => [],
    resolveIncident: async () => {},
    updateJobRetries: async () => {},
    setVariables: async () => {},
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
  openUserTasks: async () => [],
  getForm: async () => null,
  completeUserTask: async () => {},
  searchProcessInstances: async () => [],
  searchElementInstances: async () => [],
  searchElementInstanceWaitStates: async () => [],
  getElementInstance: async () => null,
  searchIncidents: async () => [],
  resolveIncident: async () => {},
  updateJobRetries: async () => {},
  setVariables: async () => {},
  registerWorker: async (jobType) => ({ jobType, unsubscribe: async () => {} }),
  close: async () => {},
};

const fakeApp: Parameters<typeof mountSurfaces>[1] = {
  manifest: { schemaVersion: 1, id: "app", name: "App" },
  data: new DataLayer(new Map(), undefined, {}),
  engine: fakeEngine,
  env: () => undefined,
  now: () => 0,
  wait: () => Promise.resolve(),
  log: createLogger(() => {}),
};

async function render(route: Route): Promise<string> {
  const res = await route.handler({
    method: "GET",
    path: "/",
    query: new URLSearchParams(),
    headers: new Headers(),
    text: async () => "",
  });
  assert.ok(res, "handler should not decline");
  return String(res.body);
}

test("chat agent is HTML-escaped in the mount page", async () => {
  const s = mountSurfaces(ctxWith({ chat: { enabled: true, agent: "<img src=x onerror=alert(1)>" } }), fakeApp);
  const chatRoute = s.routes.find((r) => r.source === "surface:chat" && r.method === "GET")!;
  const body = await render(chatRoute);
  assert.ok(!body.includes("<img src=x"), "raw markup must not appear");
  assert.ok(body.includes("&lt;img src=x onerror=alert(1)&gt;"), "agent is escaped");
});

test("task-inbox client derives its API base from location (reverse-proxy safe, no path embedding)", async () => {
  // The client must NOT embed the manifest-supplied route base as an absolute
  // literal: a hardcoded "/tasks" escapes the Nano console's path-prefixed
  // reverse proxy (/console/app-view/<name>/tasks) — every fetch to
  // "/tasks/api/…" 404s upstream. Deriving the base from location.pathname keeps
  // the API calls document-relative (correct at the origin root AND under the
  // proxy) and, as a bonus, removes the manifest→<script> injection surface
  // entirely: nothing manifest-supplied is embedded in the page at all.
  const evil = "/tasks'});alert(1);//x";
  const s = mountSurfaces(ctxWith({ taskInbox: { enabled: true, path: evil } }), fakeApp);
  const page = s.routes.find((r) => r.source === "surface:taskInbox" && r.method === "GET" && !r.path.endsWith("/api/tasks"))!;
  const body = await render(page);
  // The manifest path (evil or otherwise) is never emitted into the page.
  assert.ok(!body.includes("alert(1)"), "manifest path is not embedded — nothing to inject");
  assert.ok(!body.includes(JSON.stringify(evil)), "manifest path is not embedded as a JS literal");
  // The base is derived from where the page was actually served, so it inherits
  // any reverse-proxy path prefix instead of a root-absolute mount path.
  assert.ok(body.includes("location.pathname"), "client derives its API base from location.pathname");
  assert.ok(!/const\s+BASE\s*=\s*["'/]/.test(body), "client does not embed an absolute route base");
});

/** Build an app handle backed by a specific engine (the flow tests drive the routes). */
function appWith(engine: EngineClient): Parameters<typeof mountSurfaces>[1] {
  return {
    manifest: { schemaVersion: 1, id: "app", name: "App" },
    data: new DataLayer(new Map(), undefined, {}),
    engine,
    env: () => undefined,
    now: () => 0,
    wait: () => Promise.resolve(),
    log: createLogger(() => {}),
  };
}

/** Invoke a route handler with an optional query string and POST body. */
async function call(
  route: Route,
  opts: { method?: string; query?: string; body?: string } = {},
): Promise<HttpResponse> {
  const res = await route.handler({
    method: opts.method ?? "GET",
    path: "/",
    query: new URLSearchParams(opts.query ?? ""),
    headers: new Headers(),
    text: async () => opts.body ?? "",
  });
  assert.ok(res, "handler should not decline");
  return res;
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
  // Drift guard: the client script is a stringified <script> body, so it is invisible to
  // the type checker. UserTaskSummary carries `formKey`/`externalFormReference` but no
  // `formId`, so the client must never branch on a task-supplied `formId` (that phantom
  // field would silently be `undefined`). Lock the drift closed.
  assert.ok(!rendered.includes("formId"), "client script must not reference formId — UserTaskSummary carries none");
  // Prototype-pollution guard: submit builds `variables` from engine-supplied component
  // keys (a schema could key a field '__proto__'/'constructor'). It must use a null-
  // prototype bag so an untrusted key lands as an own property, never mutating a prototype.
  assert.ok(rendered.includes("Object.create(null)"), "client builds the variables bag with a null prototype");
  assert.ok(!/const\s+variables\s*=\s*\{\}/.test(rendered), "client must not collect untrusted keys into a plain {} object");
});

test("inbox client script parses — no template-literal backslash collapse", async () => {
  const { page } = inboxRoutes(fakeEngine);
  const rendered = String((await call(page)).body);
  // Extract every inline <script> body and assert each parses. A backslash-bearing regex
  // written inside the page's template literal (e.g. `/\/+$/`) collapses to `//…` at emit
  // time, turning the rest of the statement into a line comment and breaking the parse
  // (issue #433). `new Function(body)` throws on any such SyntaxError.
  const scripts = rendered
    .split("<script>")
    .slice(1)
    .map((chunk) => chunk.split("</scr" + "ipt>")[0]);
  assert.ok(scripts.length > 0, "inbox page has at least one inline script");
  for (const body of scripts) {
    assert.ok(!body.includes("//+$/"), "trailing-slash-strip regex collapsed to a line comment");
    assert.doesNotThrow(() => new Function(body), "inline client script must parse");
  }
});

test("/api/tasks surfaces the resolved form linkage", async () => {
  let seenFilter: unknown;
  const engine: EngineClient = {
    ...fakeEngine,
    openUserTasks: async (filter) => {
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

test("/api/tasks constrains the search to open tasks via openUserTasks", async () => {
  let seenFilter: unknown;
  let openCalled = false;
  const engine: EngineClient = {
    ...fakeEngine,
    // A regression to a bare searchUserTasks (which does not pin state="CREATED") must fail
    // loudly rather than silently surface answered/canceled tasks (nanobpm/nano-ide#248).
    searchUserTasks: async () => {
      throw new Error("inbox must use openUserTasks, not a bare searchUserTasks");
    },
    openUserTasks: async (filter) => {
      openCalled = true;
      seenFilter = filter;
      return [];
    },
  };
  const { tasks } = inboxRoutes(engine);
  await call(tasks);
  // No processInstanceKey supplied; the inbox routes through openUserTasks, which pins the
  // open (CREATED) invariant for us, so the handler forwards only selectors (none here).
  assert.equal(openCalled, true);
  assert.deepEqual(seenFilter, {});
});

test("/api/tasks forwards assignee and candidateGroup to the engine (nanobpm/nano-ide#438)", async () => {
  let seenFilter: unknown;
  const engine: EngineClient = {
    ...fakeEngine,
    openUserTasks: async (filter) => {
      seenFilter = filter;
      return [];
    },
  };
  const { tasks } = inboxRoutes(engine);
  await call(tasks, { query: "assignee=demo-reviewer&candidateGroup=reviewers&processInstanceKey=pi-9" });
  // A manifest ui.path like /tasks?assignee=… must scope the inbox to that reviewer/group on a
  // shared engine — the handler forwards both alongside the processInstanceKey selector (the
  // open/CREATED pin is openUserTasks' responsibility, not repeated here).
  assert.deepEqual(seenFilter, {
    processInstanceKey: "pi-9",
    assignee: "demo-reviewer",
    candidateGroup: "reviewers",
  });
});

test("/api/tasks omits assignee/candidateGroup when absent (unscoped inbox unchanged)", async () => {
  let seenFilter: unknown;
  const engine: EngineClient = {
    ...fakeEngine,
    openUserTasks: async (filter) => {
      seenFilter = filter;
      return [];
    },
  };
  const { tasks } = inboxRoutes(engine);
  await call(tasks, { query: "assignee=demo-reviewer" });
  // Only the supplied param is forwarded; candidateGroup stays off so its key never appears.
  assert.deepEqual(seenFilter, { assignee: "demo-reviewer" });
});

test("/api/tasks omits assignee when only candidateGroup is present (symmetric scoping)", async () => {
  let seenFilter: unknown;
  const engine: EngineClient = {
    ...fakeEngine,
    openUserTasks: async (filter) => {
      seenFilter = filter;
      return [];
    },
  };
  const { tasks } = inboxRoutes(engine);
  await call(tasks, { query: "candidateGroup=reviewers" });
  // Symmetric to the assignee-only case: only the supplied param is forwarded, so assignee's
  // key never appears when scoping the inbox to a candidate group alone.
  assert.deepEqual(seenFilter, { candidateGroup: "reviewers" });
});

test("inbox client forwards the surface query string to /api/tasks (nanobpm/nano-ide#438)", async () => {
  const { page } = inboxRoutes(fakeEngine);
  const rendered = String((await call(page)).body);
  // A scoped surface path (e.g. /tasks?assignee=…) reaches the iframe as location.search; the
  // client must append it so the handler sees the scope. Guard the drift closed.
  assert.ok(
    rendered.includes("'/api/tasks'+location.search") || rendered.includes("'/api/tasks' + location.search"),
    "client forwards location.search onto the /api/tasks fetch",
  );
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

test("/api/form passes an empty formKey through so getForm can fall back to formId", async () => {
  // A `?formKey=&formId=…` request must not be rejected at the boundary (only *both*
  // identifiers absent is a 400) nor stripped here — resolving an empty key to its formId
  // fallback is getForm's single responsibility (see nanosdk getForm empty/whitespace test).
  let seen: unknown;
  const engine: EngineClient = {
    ...fakeEngine,
    getForm: async (input) => {
      seen = input;
      return { formKey: "form-9", schema: { type: "default", components: [] } };
    },
  };
  const { form } = inboxRoutes(engine);
  const res = await call(form, { query: "formKey=&formId=form-9" });
  assert.equal(res.status, 200);
  assert.deepEqual(seen, { formKey: "", formId: "form-9" });
});

test("/api/form 400s a whitespace-only identifier instead of a spurious 204", async () => {
  // A `?formKey=   ` (or `formId=   `) request provides no usable identifier. The route's
  // presence gate must follow getForm's canonical rule (whitespace = absent) and 400,
  // rather than letting the blank key slip past a raw truthiness check to getForm (→ null
  // → 204). Guards the route↔getForm presence drift on the taskInbox form path — Red when
  // the gate checks raw `!formKey && !formId`, since "   " is truthy.
  const { form } = inboxRoutes(fakeEngine);
  assert.equal((await call(form, { query: "formKey=%20%20%20" })).status, 400);
  assert.equal((await call(form, { query: "formId=%20%20" })).status, 400);
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

test("number field reader guards against a non-numeric (tampered) value", async () => {
  // A number field submits `Number(raw)`; a non-numeric value (only reachable via tampering
  // — the browser blanks invalid type=number input) yields NaN, which JSON.stringify
  // serializes as null, silently changing the submission. The inline reader must guard it
  // with Number.isFinite so a bad value is treated as absent rather than submitted as NaN.
  const { page } = inboxRoutes(fakeEngine);
  const rendered = String((await call(page)).body);
  assert.ok(rendered.includes("Number.isFinite"), "number field guards NaN via Number.isFinite");
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


test("MCP is listed as an active surface only when config-enabled, but its route is always mounted", () => {
  // Default: MCP enabled -> listed as an active surface.
  const on = mountSurfaces(ctxWith({}), fakeApp);
  const onEnabled = on.describe().enabled;
  assert.ok(Array.isArray(onEnabled) && onEnabled.includes("mcp@/app/mcp"), "an enabled MCP surface is listed as active");

  // Config-disabled (URBAN_MCP_ENABLED=false): the handler 404s, so it must NOT appear as active,
  // yet the route stays mounted for a stable address.
  const base = ctxWith({});
  const offCtx = { ...base, host: { ...base.host, env: (v: string) => (v === "URBAN_MCP_ENABLED" ? "false" : undefined) } };
  const off = mountSurfaces(offCtx, fakeApp);
  const offEnabled = off.describe().enabled;
  assert.ok(Array.isArray(offEnabled) && !offEnabled.includes("mcp@/app/mcp"), "a disabled MCP surface must not be listed as active");
  assert.ok(off.routes.some((r) => r.path === "/app/mcp"), "the MCP route stays mounted even when disabled");
});
