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
    statFile: async () => null,
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
    searchVariables: async () => [],
    searchJobs: async () => [],
    getProcessDefinitionXml: async () => null,
    searchAgentInstances: async () => [],
    searchAgentInstanceHistory: async () => [],
    getAgentInstance: async () => null,
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
  searchVariables: async () => [],
  searchJobs: async () => [],
  getProcessDefinitionXml: async () => null,
  searchAgentInstances: async () => [],
  searchAgentInstanceHistory: async () => [],
  getAgentInstance: async () => null,
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

// ── #603: the inbox loads the task's variables and passes them to the renderer ─

test("/api/variables returns the task's variables as a {name: value} context", async () => {
  let seenFilter: unknown;
  const engine: EngineClient = {
    ...fakeEngine,
    searchVariables: async (filter) => {
      seenFilter = filter;
      return [
        { variableKey: "v1", name: "title", value: JSON.stringify("Draft v2"), scopeKey: "pi-9", processInstanceKey: "pi-9", isTruncated: false },
        { variableKey: "v2", name: "img1", value: JSON.stringify("data:image/png;base64,iVBORw0KGgo="), scopeKey: "pi-9", processInstanceKey: "pi-9", isTruncated: false },
        { variableKey: "v3", name: "count", value: "3", scopeKey: "pi-9", processInstanceKey: "pi-9", isTruncated: false },
      ];
    },
  };
  const s = mountSurfaces(ctxWith({ taskInbox: { enabled: true, path: "/tasks" } }), appWith(engine));
  const variables = s.routes.find(
    (r) => r.source === "surface:taskInbox" && r.method === "GET" && r.path.endsWith("/api/variables"),
  )!;
  const res = await call(variables, { query: "processInstanceKey=pi-9" });
  assert.deepEqual(seenFilter, { processInstanceKey: "pi-9" }, "the route searches the engine's variables by process instance");
  assert.equal(res.status, 200);
  assert.deepEqual(JSON.parse(String(res.body)), {
    title: "Draft v2",
    img1: "data:image/png;base64,iVBORw0KGgo=",
    count: 3,
  }, "serialized-JSON values arrive parsed (strings as strings, numbers as numbers)");
});

test("/api/variables 400s without a processInstanceKey", async () => {
  const s = mountSurfaces(ctxWith({ taskInbox: { enabled: true, path: "/tasks" } }), fakeApp);
  const variables = s.routes.find(
    (r) => r.source === "surface:taskInbox" && r.method === "GET" && r.path.endsWith("/api/variables"),
  )!;
  const res = await call(variables);
  assert.equal(res.status, 400);
});

test("inbox client loads the task's variables and renders {{title}} + an =img1 image with them", async () => {
  // The acceptance scenario: a task whose variables include `title` and `img1`,
  // with a form using {{title}} and an image with source "=img1", renders both.
  // The server half (the /api/variables route) is covered above; here we pin the
  // CLIENT half: openForm must fetch the variables for the task's process
  // instance and hand them to the shared renderer as its context.
  const { page } = inboxRoutes(fakeEngine);
  const rendered = String((await call(page)).body);
  assert.ok(
    rendered.includes("'/api/variables?processInstanceKey='+encodeURIComponent(t.processInstanceKey)"),
    "openForm fetches the task's variables by its processInstanceKey",
  );
  assert.ok(rendered.includes("Promise.all(["), "form schema and variables load together");
  assert.ok(rendered.includes("context:context||{}"), "the variables are passed to NanoFormJs.renderForm as its context");
  // The renderer the page embeds must be the context-aware one: it templates
  // {{name}} in text components, resolves =varName image sources, and prefills
  // keyed inputs — all from that one context.
  assert.ok(rendered.includes("function fjTemplate"), "embedded renderer has {{name}} text templating");
  assert.ok(rendered.includes("function fjImageSrc"), "embedded renderer has the image source resolver");
  assert.ok(rendered.includes("njf-image"), "page styles the image component");
});

test("inbox client degrades to an empty context when the variables fetch fails", async () => {
  const { page } = inboxRoutes(fakeEngine);
  const rendered = String((await call(page)).body);
  // A failed variables fetch must not block the form: it falls back to {} so the
  // schema still renders (untemplated/unprefilled).
  assert.ok(
    rendered.includes(".catch(()=>({}))"),
    "a variables fetch failure degrades to an empty context rather than failing the form",
  );
});

// ── PR #604 review: the variables context is process-scoped, complete, and name-safe ─

test("/api/variables uses only process-level variables — sibling task-local scopes never leak, in any order", async () => {
  const rows = [
    { variableKey: "a", name: "title", value: JSON.stringify("process"), scopeKey: "pi-9", processInstanceKey: "pi-9", isTruncated: false },
    { variableKey: "b", name: "title", value: JSON.stringify("sibling-local"), scopeKey: "ei-1", processInstanceKey: "pi-9", isTruncated: false },
    { variableKey: "c", name: "only", value: JSON.stringify("sibling-only"), scopeKey: "ei-2", processInstanceKey: "pi-9", isTruncated: false },
  ];
  for (const order of [rows, [...rows].reverse()]) {
    const engine: EngineClient = { ...fakeEngine, searchVariables: async () => order };
    const s = mountSurfaces(ctxWith({ taskInbox: { enabled: true, path: "/tasks" } }), appWith(engine));
    const route = s.routes.find((r) => r.source === "surface:taskInbox" && r.path.endsWith("/api/variables"))!;
    const res = await call(route, { query: "processInstanceKey=pi-9" });
    assert.deepEqual(JSON.parse(String(res.body)), { title: "process" });
  }
});

test("/api/variables omits truncated previews so they can never be prefilled and submitted", async () => {
  const engine: EngineClient = {
    ...fakeEngine,
    searchVariables: async () => [
      { variableKey: "a", name: "big", value: JSON.stringify("clipped…"), scopeKey: "pi-9", processInstanceKey: "pi-9", isTruncated: true },
      { variableKey: "b", name: "small", value: JSON.stringify("ok"), scopeKey: "pi-9", processInstanceKey: "pi-9", isTruncated: false },
    ],
  };
  const s = mountSurfaces(ctxWith({ taskInbox: { enabled: true, path: "/tasks" } }), appWith(engine));
  const route = s.routes.find((r) => r.source === "surface:taskInbox" && r.path.endsWith("/api/variables"))!;
  const res = await call(route, { query: "processInstanceKey=pi-9" });
  assert.deepEqual(JSON.parse(String(res.body)), { small: "ok" });
});

test("/api/variables round-trips a variable named __proto__ as data", async () => {
  for (const value of ["scalar", { nested: 1 }]) {
    const engine: EngineClient = {
      ...fakeEngine,
      searchVariables: async () => [
        { variableKey: "a", name: "__proto__", value: JSON.stringify(value), scopeKey: "pi-9", processInstanceKey: "pi-9", isTruncated: false },
      ],
    };
    const s = mountSurfaces(ctxWith({ taskInbox: { enabled: true, path: "/tasks" } }), appWith(engine));
    const route = s.routes.find((r) => r.source === "surface:taskInbox" && r.path.endsWith("/api/variables"))!;
    const res = await call(route, { query: "processInstanceKey=pi-9" });
    const parsed = JSON.parse(String(res.body));
    assert.ok(Object.hasOwn(parsed, "__proto__"));
    assert.deepEqual(parsed.__proto__, value);
  }
});

// ── PR #604 round 4: inbox image URLs rebase onto the APP mount, not the inbox route ──

test("inbox client rebases image URLs onto the app mount (inbox route stripped), direct and proxied", async () => {
  const { page } = inboxRoutes(fakeEngine);
  const rendered = String((await call(page)).body);
  // The image resolver must NOT reuse BASE: BASE includes the inbox route
  // (location.pathname is ".../tasks"), so `/app/thumb.png` would become
  // `/tasks/app/thumb.png` — the inbox route has no /app handler, so the image
  // 404s. The client derives a separate app-mount prefix by stripping the
  // configured inbox route's segments, and the resolver prefixes THAT.
  assert.match(
    rendered,
    /const APP_BASE=BASE\.split\('\/'\)\.slice\(0,-INBOX_SEGMENTS\)\.join\('\/'\)/,
    "client derives the app mount by stripping the inbox route's segments from BASE",
  );
  assert.match(
    rendered,
    /resolveUrl:\(u\)=>u\.startsWith\('\/\/'\)\|\|\/\^\[a-zA-Z\]\[a-zA-Z0-9\+\.-\]\*:\/\.test\(u\)\?u:u\.startsWith\('\/'\)\?APP_BASE\+u:APP_BASE\+'\/'\+u/,
    "image resolver prefixes the app mount, not the inbox route",
  );
  // Direct deployment: page served at /tasks → BASE="/tasks", APP_BASE="".
  // Proxied: page at /console/app-view/<name>/tasks → APP_BASE="/console/app-view/<name>".
  // Both reduce to the same derivation; pin the behaviour with the derivation the
  // client ships (the default inbox path is single-segment):
  const derive = (pathname: string) => {
    const base = pathname.replace(/[/]+$/, "");
    const appBase = base.split("/").slice(0, -1).join("/");
    const resolveUrl = (u: string) => (u.startsWith("//") ? u : u.startsWith("/") ? appBase + u : appBase + "/" + u);
    return resolveUrl(u0);
  };
  const u0 = "/app/thumb.png";
  assert.equal(derive("/tasks"), "/app/thumb.png", "direct: the image URL keeps no inbox segment");
  assert.equal(
    derive("/console/app-view/my-app/tasks"),
    "/console/app-view/my-app/app/thumb.png",
    "proxied: the proxy prefix is kept, the inbox route is dropped",
  );
  // API fetches still use the inbox route (BASE) — only image rebasing moves to APP_BASE.
  assert.match(rendered, /fetch\(BASE\+path/, "api() still fetches under the inbox route");
});

// ── PR #604 round 5: APP_BASE strips the ENTIRE configured inbox path ──

test("inbox client derives APP_BASE from the configured inbox path's segment count (nested paths)", async () => {
  const { page } = inboxRoutes(fakeEngine);
  const rendered = String((await call(page)).body);
  // Stripping ONE trailing segment only works for a single-segment inbox path:
  // a configured nested path like /review/tasks would leave "/review" behind, so
  // /app/thumb.png resolves to /review/app/thumb.png (no handler — 404), and the
  // console proxy keeps the unwanted segment too. The client must strip as many
  // segments as the CONFIGURED inbox path has — numeric page metadata, not an
  // embedded path string (nothing manifest-supplied becomes markup/JS text).
  assert.match(
    rendered,
    /const INBOX_SEGMENTS=\d+;/,
    "the inbox path's segment count is embedded as numeric metadata",
  );
  assert.match(
    rendered,
    /const APP_BASE=BASE\.split\('\/'\)\.slice\(0,-INBOX_SEGMENTS\)\.join\('\/'\)/,
    "APP_BASE strips exactly INBOX_SEGMENTS segments from BASE",
  );
  // Pin the behaviour with the derivation the client ships, direct and proxied,
  // for single-segment AND nested inbox paths:
  const derive = (pathname: string, segments: number) => {
    const base = pathname.replace(/[/]+$/, "");
    const appBase = base.split("/").slice(0, -segments).join("/");
    const resolveUrl = (u: string) => (u.startsWith("//") ? u : u.startsWith("/") ? appBase + u : appBase + "/" + u);
    return resolveUrl(u0);
  };
  const u0 = "/app/thumb.png";
  assert.equal(derive("/tasks", 1), "/app/thumb.png", "direct, single-segment inbox path");
  assert.equal(
    derive("/console/app-view/my-app/tasks", 1),
    "/console/app-view/my-app/app/thumb.png",
    "proxied, single-segment inbox path",
  );
  assert.equal(derive("/review/tasks", 2), "/app/thumb.png", "direct, nested inbox path — no /review retained");
  assert.equal(
    derive("/console/app-view/my-app/review/tasks", 2),
    "/console/app-view/my-app/app/thumb.png",
    "proxied, nested inbox path — the proxy prefix is kept, the whole inbox route is dropped",
  );
});

test("inbox page embeds the configured inbox path's segment count, not the path string", async () => {
  // A nested configured path contributes exactly its segment count as metadata —
  // the path STRING itself is never embedded (the manifest→<script> injection
  // surface stays closed).
  for (const [path, segments] of [["/tasks", 1], ["/review/tasks", 2], ["/a/b/c", 3]] as const) {
    const s = mountSurfaces(ctxWith({ taskInbox: { enabled: true, path } }), appWith(fakeEngine));
    const page = s.routes.find((r) => r.source === "surface:taskInbox" && r.method === "GET" && !r.path.includes("/api/"))!;
    const body = String((await call(page)).body);
    assert.ok(body.includes(`const INBOX_SEGMENTS=${segments};`), `${path} → INBOX_SEGMENTS=${segments}`);
    if (path !== "/tasks") {
      assert.ok(!body.includes(path), `the path string ${path} is not embedded`);
    }
  }
});

// ── PR #604 round 7: repeated-slash inbox paths; relative image sources rebase too ──

test("inbox client counts repeated-slash slots when deriving the app base", async () => {
  // normalizeRoutePath collapses LEADING slashes and drops trailing ones but
  // preserves INTERIOR repeated slashes (router.ts), so a configured
  // "/review//tasks" is served verbatim. The page's BASE.split('/') then retains
  // the empty slot the double slash produces — the server-side segment count
  // must count the SAME slots, or the client strips too few and APP_BASE keeps
  // a segment that is not the app mount ("/review" instead of "").
  const s = mountSurfaces(ctxWith({ taskInbox: { enabled: true, path: "/review//tasks" } }), appWith(fakeEngine));
  const page = s.routes.find((r) => r.source === "surface:taskInbox" && r.method === "GET" && !r.path.includes("/api/"))!;
  const body = String((await call(page)).body);
  // "/review//tasks".split("/") → ["", "review", "", "tasks"] — 3 slots after the
  // leading slash, so the client must strip 3 (not the 2 non-empty segments).
  assert.ok(body.includes("const INBOX_SEGMENTS=3;"), "the repeated-slash slot is counted (3, not 2)");
  // Pin the derivation the client ships: BASE.split('/').slice(0,-INBOX_SEGMENTS).
  const derive = (pathname: string, segments: number) => {
    const base = pathname.replace(/[/]+$/, "");
    return base.split("/").slice(0, -segments).join("/");
  };
  assert.equal(derive("/review//tasks", 3), "", "direct: the whole inbox route is stripped");
  assert.equal(
    derive("/console/app-view/my-app/review//tasks", 3),
    "/console/app-view/my-app",
    "proxied: only the proxy prefix remains",
  );
  // …whereas the old non-empty-segment count (2) would retain "/review".
  assert.equal(derive("/review//tasks", 2), "/review", "the wrong count retains a bogus segment");
});

test("inbox client rebases scheme-less RELATIVE image sources onto the app mount", async () => {
  const { page } = inboxRoutes(fakeEngine);
  const rendered = String((await call(page)).body);
  // A source like "app/thumb.png" (no leading slash) is a scheme-less RELATIVE
  // path: left unchanged, the browser resolves it against the page URL, so a
  // nested inbox path (/review/tasks) requests /review/app/thumb.png — the inbox
  // route has no such handler (404). The resolver must rebase it onto APP_BASE
  // exactly like a root-relative source, while absolute http(s)/data: URLs still
  // pass through untouched.
  // Test the resolver the client ACTUALLY ships (extracted from the page), not a
  // re-implementation that could drift from it.
  const m = /resolveUrl:(\(u\)=>[^\n]*?),\n/.exec(rendered);
  assert.ok(m, "the inbox page wires a resolveUrl");
  const src = m[1];
  const resolve = (appBase: string): ((u: string) => string) => new Function("APP_BASE", `return ${src};`)(appBase);
  // Scheme-bearing (absolute) sources must pass through verbatim — never rebased
  // into a bogus '/https://…' app path.
  for (const base of ["", "/console/app-view/my-app"]) {
    for (const abs of ["https://cdn.example.com/t.png", "http://x.example/t.png", "data:image/png;base64,iVBORw0KGgo="]) {
      assert.equal(resolve(base)(abs), abs, `absolute ${abs} passes through under APP_BASE='${base}'`);
    }
  }
  const direct = resolve(""); // inbox at /review/tasks → APP_BASE ""
  assert.equal(direct("app/thumb.png"), "/app/thumb.png", "direct: a relative source lands on the app route, not /review/app/…");
  assert.equal(direct("/app/thumb.png"), "/app/thumb.png", "direct: a root-relative source is unchanged");
  const proxied = resolve("/console/app-view/my-app");
  assert.equal(
    proxied("app/thumb.png"),
    "/console/app-view/my-app/app/thumb.png",
    "proxied: a relative source lands under the app mount",
  );
  assert.equal(
    proxied("/app/thumb.png"),
    "/console/app-view/my-app/app/thumb.png",
    "proxied: a root-relative source still rebases onto the app mount",
  );
  // End-to-end: the shipped resolver followed by the renderer's post-resolution
  // allowlist keeps absolute https/data: sources intact and rejects '//host'.
  const allowlist = (u: string) =>
    /[\s\u0000-\u001f\u007f\\]/.test(u)
      ? null
      : /^data:image\/(png|jpeg|gif|webp)[;,]/i.test(u)
        ? u
        : /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(u)
          ? /^https?:\/\//i.test(u) ? u : null
          : u.startsWith("//") ? null : u;
  const pipeline = (u: string) => {
    const out = allowlist(resolve("/console/app-view/my-app")(u));
    return out;
  };
  assert.equal(pipeline("https://cdn.example.com/t.png"), "https://cdn.example.com/t.png", "absolute https survives the pipeline");
  assert.equal(
    pipeline("data:image/png;base64,iVBORw0KGgo="),
    "data:image/png;base64,iVBORw0KGgo=",
    "a data:image source survives the pipeline",
  );
  assert.equal(pipeline("//evil.example.com/x.png"), null, "protocol-relative is rejected before the resolver runs");
});
