import { test } from "node:test";
import assert from "node:assert/strict";
import type { EngineClient, HttpRequest, HttpResponse } from "../host.ts";
import { makeRouter } from "../router.ts";
import { createPagesRoutes, type PagesDataSource, type PagesDeps } from "./pages.ts";

function req(
  method: string,
  path: string,
  opts: { query?: string; body?: unknown } = {},
): HttpRequest {
  const bodyText = opts.body === undefined ? "" : JSON.stringify(opts.body);
  return {
    method,
    path,
    query: new URLSearchParams(opts.query ?? ""),
    headers: new Headers(),
    text: () => Promise.resolve(bodyText),
  };
}

interface FakeEngineCalls {
  created: { processDefinitionId: string; variables?: Record<string, unknown> }[];
  canceled: string[];
  messages: { name: string; correlationKey?: string; variables?: Record<string, unknown> }[];
}

function fakeEngine(): { engine: EngineClient; calls: FakeEngineCalls } {
  const calls: FakeEngineCalls = { created: [], canceled: [], messages: [] };
  const engine: EngineClient = {
    deployResources: async () => ({ deployed: 0 }),
    async createInstance(input: { processDefinitionId: string; variables?: Record<string, unknown> }) {
      calls.created.push(input);
      return { processInstanceKey: "pi-42" };
    },
    async cancelInstance(input: { processInstanceKey: string }) {
      calls.canceled.push(input.processInstanceKey);
    },
    async publishMessage(input: { name: string; correlationKey?: string; variables?: Record<string, unknown> }) {
      calls.messages.push(input);
    },
    async searchUserTasks() { return []; },
    async completeUserTask() {},
    async searchProcessInstances() { return []; },
    async registerWorker(jobType) { return { jobType, unsubscribe: async () => {} }; },
    async close() {},
  };
  return { engine, calls };
}

function fakeDb(overrides: Partial<PagesDataSource> = {}): PagesDataSource {
  return {
    schema: async () => [{ name: "orders" }],
    query: async (sql: string) => {
      if (/PRAGMA table_info/i.test(sql)) {
        return [{ name: "id" }, { name: "status" }, { name: "total" }];
      }
      return [{ id: 1, status: "new", total: 10 }];
    },
    ...overrides,
  };
}

function build(dbOverrides: Partial<PagesDataSource> = {}, deps: Partial<PagesDeps> = {}) {
  const { engine, calls } = fakeEngine();
  const db = fakeDb(dbOverrides);
  const readPage = async (path: string) => {
    if (path === "pages/home.page.json") return JSON.stringify({ title: "Home", nodes: [] });
    if (path === "pages/epic.page.json") return JSON.stringify({ title: "Epic Coordination", nodes: [] });
    throw new Error("not found");
  };
  const routes = createPagesRoutes({ pagesDir: "pages", homePage: "home", sourceName: "app" }, {
    db,
    engine,
    readPage,
    listPages: async () => ["home", "epic"],
    ...deps,
  });
  const router = makeRouter(routes);
  return { router, calls };
}

async function dispatch(method: string, path: string, opts?: { query?: string; body?: unknown }): Promise<HttpResponse> {
  const { router } = build();
  return router(req(method, path, opts));
}

test("GET / serves the renderer shell with the home marker", async () => {
  const res = await dispatch("GET", "/");
  assert.equal(res.status, 200);
  assert.match(res.headers?.["content-type"] ?? "", /text\/html/);
  assert.match(res.body ?? "", /data-home="home"/);
  // The runtime module is loaded by a *relative* src so it resolves against the
  // document's mount path — works both at the origin root and under the Nano
  // console's /console/app-view/<name>/ reverse proxy. A root-absolute
  // "/app/runtime.js" would 404 against the console origin and never hydrate.
  assert.match(res.body ?? "", /src="\.\/app\/runtime\.js"/);
  assert.doesNotMatch(res.body ?? "", /src="\/app\/runtime\.js"/);
});

test("the shell styles the app through the shared --nano-* token contract", async () => {
  const res = await dispatch("GET", "/");
  const html = res.body ?? "";
  // Body colours resolve through the console's token vocabulary, not hardcoded hex.
  assert.match(html, /background:var\(--nano-app\)/);
  assert.match(html, /color:var\(--nano-text\)/);
  assert.match(html, /--pc-accent:var\(--nano-accent\)/);
  // Self-contained defaults for standalone (CLI) runs: dark base + a light
  // palette gated on data-appearance, and prefers-color-scheme only until themed.
  assert.match(html, /--nano-accent:#8b5cf6/);
  assert.match(html, /\[data-appearance="light"\]/);
  assert.match(html, /:root:not\(\[data-appearance\]\)/);
});

test("GET /app/runtime.js serves the renderer module", async () => {
  const res = await dispatch("GET", "/app/runtime.js");
  assert.match(res.headers?.["content-type"] ?? "", /javascript/);
  assert.match(res.body ?? "", /pc:refresh/);
  // Endpoints are rebased against the served module URL so the app works under a
  // path-prefixed reverse proxy (Nano console embed), not just at the origin root.
  assert.match(res.body ?? "", /new URL\("\.\.\/", import\.meta\.url\)/);
  assert.match(res.body ?? "", /function apiUrl\(u\)/);
});

test("the renderer bridges the console theme over postMessage", async () => {
  const res = await dispatch("GET", "/app/runtime.js");
  const js = res.body ?? "";
  // Announces readiness to the framing console (same-origin, posture A).
  assert.match(js, /postMessage\(\{ type: "nano-app-ready" \}, window\.location\.origin\)/);
  // Only trusts the framing parent, and only accepts nano-theme messages.
  assert.match(js, /ev\.source === window\.parent/);
  // Same-origin posture A: a cross-origin framer is rejected before applyTheme.
  assert.match(js, /ev\.origin === window\.location\.origin/);
  assert.match(js, /msg\.type !== "nano-theme"/);
  // Mirrors the console appearance + lays --nano-* tokens onto :root; ignores
  // any property outside the shared token namespace.
  assert.match(js, /el\.dataset\.appearance = msg\.appearance/);
  assert.match(js, /k\.startsWith\("--nano-"\)/);
  assert.match(js, /el\.style\.setProperty\(k, v\)/);
});


test("renderer preserves grid row-detail expansion across refreshes", async () => {
  // Regression: the 5s poll rebuilds the whole tbody, which used to collapse an open
  // detail row (e.g. the escalation-answer form). The client now tracks open rowKeys
  // and reuses their built detail node so expansion (and a half-typed answer) survives.
  const res = await dispatch("GET", "/app/runtime.js");
  const js = res.body ?? "";
  assert.match(js, /const expanded = new Set\(\)/);
  assert.match(js, /const detailNodes = new Map\(\)/);
  assert.match(js, /expanded\.add\(key\)/);
  assert.match(js, /expanded\.delete\(key\)/);
  // A missing/null rowKey must be treated as keyless (null) rather than coerced to
  // the string "undefined"/"null", which would collide unrelated rows in the caches.
  assert.match(js, /rowKeyOf/);
  assert.match(js, /v == null \? null : String\(v\)/);
});

test("renderer keeps the detail input focused across the refresh poll", async () => {
  // Regression: #103 reused the open detail node so a half-typed answer survived, but
  // tbody.replaceChildren() still detaches (and so blurs) that node, dropping the caret
  // every refreshMs. The client now (1) skips the timer-driven poll while the user is
  // editing in the grid, and (2) restores focus + selection across any refresh that runs.
  const res = await dispatch("GET", "/app/runtime.js");
  const js = res.body ?? "";
  // (1) The automatic poll is gated on not-editing; an explicit pc:refresh still runs.
  assert.match(js, /const editingInGrid = \(\)\s*=>/);
  assert.match(js, /setInterval\(\s*\(\)\s*=>\s*\{\s*if\s*\(\s*!editingInGrid\(\)\s*\)\s*refresh\(\)\s*;?\s*\}\s*,\s*p\.refreshMs\s*\)/);
  // (2) Focus + caret are captured before replaceChildren() and restored to the reused node.
  assert.match(js, /const keepFocus = !!active && tbody\.contains\(active\)/);
  assert.match(js, /active\.selectionStart/);
  assert.match(js, /if \(keepFocus && active\.isConnected\)/);
  assert.match(js, /active\.setSelectionRange\(selStart, selEnd\)/);
  // contenteditable carets are preserved via the document selection range.
  assert.match(js, /active\.isContentEditable/);
  assert.match(js, /s\.addRange\(savedRange\)/);
});

test("renderer wires a column's linkField to a new-tab anchor", async () => {
  const res = await dispatch("GET", "/app/runtime.js");
  const js = res.body ?? "";
  // A column declaring `linkField` renders its text as a link to that field's
  // URL, opened safely in a new tab. Guard the whole shape so the feature can't
  // silently regress: the field is read, http(s) is required, and the anchor
  // opens in a new tab with a hardened rel.
  assert.match(js, /col\.linkField/);
  assert.match(js, /\^https\?:/);
  assert.match(js, /target: "_blank"/);
  assert.match(js, /rel: "noopener noreferrer"/);
});

test("renderer wires a column's processExplorer link to the console explorer", async () => {
  const res = await dispatch("GET", "/app/runtime.js");
  const js = res.body ?? "";
  // A column declaring `link: { kind: "processExplorer", keyField }` renders its
  // text as a link to the Nano console's explorer for the process instance whose
  // key is held in that field. Guard the whole shape so the primitive can't
  // silently regress: the discriminant + keyField are read, the console path is
  // constructed here (not from row data), the key is URL-encoded, and the anchor
  // opens in a new tab with a hardened rel.
  assert.match(js, /col\.link && col\.link\.kind === "processExplorer" && col\.link\.keyField/);
  assert.match(js, /"\/console\/explorer\?instance=" \+ encodeURIComponent\(String\(key\)\)/);
  assert.match(js, /target: "_blank"/);
  assert.match(js, /rel: "noopener noreferrer"/);
});

test("the renderer honours numeric actionForm fields", async () => {
  const res = await dispatch("GET", "/app/runtime.js");
  const js = res.body ?? "";
  // Fields declared `type: "number"` render a numeric <input> and their submitted
  // value is coerced to a real number (blank omitted so the action's default applies).
  assert.match(js, /f\.type === "number"/);
  assert.match(js, /Number\.isFinite\(num\)/);
  // Numeric branch sets inputmode="numeric" so mobile keyboards show a number pad.
  assert.match(js, /attrs\.inputmode = "numeric"/);
  // Blank and non-finite numeric values are omitted (continue) rather than sent,
  // so the action-side default applies and no raw string leaks through as a number.
  assert.match(js, /if \(t === ""\) continue;/);
  assert.match(js, /if \(!Number\.isFinite\(num\)\) continue;/);
});

test("renderer makes collapsible nodes persist their state across sessions", async () => {
  // A node with `collapsible` gets a clickable header that hides/shows the card
  // body, and the collapsed state is written to localStorage keyed by the home
  // page id + node id so it survives a full reload / new session (not just the
  // refresh poll). Storage access is guarded so private-mode browsers can't
  // break render.
  const res = await dispatch("GET", "/app/runtime.js");
  const js = res.body ?? "";
  assert.match(js, /function makeCollapsible\(node, card\)/);
  assert.match(js, /if \(!props\.collapsible\) return card;/);
  // Seed from defaultCollapsed the first time, then from persisted state.
  assert.match(js, /readCollapsed\(storageKey, !!props\.defaultCollapsed\)/);
  // Namespaced, per-node storage key — keyed by the *current* page id so two
  // pages that reuse a node id don't share collapse state across navigation.
  assert.match(js, /"pc:collapsed:" \+ CURRENT \+ ":" \+ \(node\.id/);
  // Persist on toggle.
  assert.match(js, /writeCollapsed\(storageKey, collapsed\)/);
  // Every storage access is wrapped so a throwing localStorage can't break the UI.
  assert.match(js, /localStorage\.getItem\(key\)/);
  assert.match(js, /localStorage\.setItem\(key, val \? "1" : "0"\)/);
  assert.match(js, /catch \(e\) \{\s*return dflt;/);
  // And the wrapper is actually applied at the dispatch layer.
  assert.match(js, /makeCollapsible\(n, \(RENDERERS\[n\.type\]/);
  // Non-card renderer output (e.g. text -> <p>) is nested whole inside a fresh
  // <section class="pc-card"> rather than having a <button>/<div> injected into
  // it — so the feature is valid markup across every node type, not just cards.
  assert.match(js, /const isCard = card\.tagName === "SECTION";/);
  assert.match(js, /const container = isCard \? card : el\("section", \{ class: "pc-card" \}\)/);
  assert.match(js, /body\.append\(card\)/);
  assert.match(js, /container\.append\(header, body\);\s*return container;/);
});

test("GET /app/pages/<id> returns the page json, 404 for unknown", async () => {
  const ok = await dispatch("GET", "/app/pages/home");
  assert.equal(ok.status, 200);
  assert.deepEqual(JSON.parse(ok.body ?? "{}").title, "Home");
  const miss = await dispatch("GET", "/app/pages/nope");
  assert.equal(miss.status, 404);
});

test("GET /app/pages indexes the available pages with titles + home flag", async () => {
  const res = await dispatch("GET", "/app/pages");
  assert.equal(res.status, 200);
  const body = JSON.parse(res.body ?? "{}");
  assert.equal(body.home, "home");
  const byId = Object.fromEntries((body.pages ?? []).map((p: { id: string }) => [p.id, p]));
  assert.deepEqual(byId.home, { id: "home", title: "Home", home: true });
  assert.deepEqual(byId.epic, { id: "epic", title: "Epic Coordination", home: false });
  // The exact index path must not be shadowed by the /app/pages/<id> prefix route.
  assert.equal((await dispatch("GET", "/app/pages/epic")).status, 200);
});

test("GET /app/pages is empty (not an error) when listing is unavailable", async () => {
  // listPages is optional — without it the index is an empty list, not a 500.
  const routes = createPagesRoutes({ pagesDir: "pages", homePage: "home", sourceName: "app" }, {
    db: fakeDb(),
    engine: fakeEngine().engine,
    readPage: async () => "{}",
  });
  const res = await makeRouter(routes)(req("GET", "/app/pages"));
  assert.equal(res.status, 200);
  assert.deepEqual(JSON.parse(res.body ?? "{}"), { pages: [], home: "home" });
});

test("the renderer routes between pages by hash and tears down grid polls", async () => {
  const res = await dispatch("GET", "/app/runtime.js");
  const js = res.body ?? "";
  // A page is chosen by the URL fragment (#/<page>), validated to a safe id, and
  // re-rendered on hashchange — proxy-safe because the hash never hits the server.
  assert.match(js, /const PAGE_ID = \/\^\[A-Za-z0-9_-/);
  assert.match(js, /function safePageId\(value\)/);
  assert.match(js, /function currentPage\(\)/);
  assert.match(js, /try \{\s*const raw = decodeURIComponent/s);
  assert.match(js, /catch \(e\) \{\s*return HOME;/s);
  assert.match(js, /location\.hash/);
  assert.match(js, /window\.addEventListener\("hashchange", renderPage\)/);
  assert.match(js, /async function renderPage\(\)/);
  // Navigation runs every registered disposer first, so a switched-away grid's
  // poll interval + pc:refresh listener are removed rather than leaking forever.
  assert.match(js, /const disposers = \[\]/);
  assert.match(js, /function teardown\(\)/);
  assert.match(js, /disposers\.push\(\(\) => document\.removeEventListener\("pc:refresh", refresh\)\)/);
  assert.match(js, /disposers\.push\(\(\) => clearInterval\(timer\)\)/);
});

test("the renderer ships a nav node (menu bar / rail) with in-app + external links", async () => {
  const res = await dispatch("GET", "/app/runtime.js");
  const js = res.body ?? "";
  // nav is a first-class node type.
  assert.match(js, /nav: renderNav/);
  assert.match(js, /function renderNav\(node\)/);
  // "rail" variant renders a side rail; anything else is a horizontal bar.
  assert.match(js, /p\.variant === "rail"/);
  assert.match(js, /"pc-nav pc-rail"/);
  assert.match(js, /"pc-nav pc-bar"/);
  // A page item becomes an in-app hash link, active-highlighted on the current page.
  assert.match(js, /const isPage = safePageId\(item\.page\)/);
  assert.match(js, /attrs\.href = "#\/" \+ encodeURIComponent\(item\.page\)/);
  assert.match(js, /item\.page === CURRENT/);
  assert.match(js, /aria-current/);
  // An external item is an http(s)-only, hardened new-tab link.
  assert.match(js, /\^https\?:\\\/\\\//);
  assert.match(js, /attrs\.rel = "noopener noreferrer"/);
  // items:"auto" (or omitted) enumerates every page from the index endpoint.
  assert.match(js, /getJSON\("\/app\/pages"\)/);
  // A rail is lifted into a left <aside>; the rest flow into a content column.
  assert.match(js, /pc-rail-wrap/);
  assert.match(js, /pc-layout/);
  assert.match(js, /pc-main-col/);
});

test("GET /app/data/<source>/<table> returns rows", async () => {
  const res = await dispatch("GET", "/app/data/app/orders");
  assert.equal(res.status, 200);
  const body = JSON.parse(res.body ?? "{}");
  assert.equal(body.rows.length, 1);
  assert.equal(body.rows[0].status, "new");
});

test("GET /app/data rejects unknown source, invalid + unknown table", async () => {
  assert.equal((await dispatch("GET", "/app/data/other/orders")).status, 404);
  const { router } = build();
  const unknownTable = await router(req("GET", "/app/data/app/customers"));
  assert.equal(unknownTable.status, 404);
});

test("GET /app/data whitelists filter columns", async () => {
  const { router } = build();
  const good = await router(req("GET", "/app/data/app/orders", { query: "where=status:new" }));
  assert.equal(good.status, 200);
  const bad = await router(req("GET", "/app/data/app/orders", { query: "where=evil:1" }));
  assert.equal(bad.status, 400);
});

test("POST /app/actions/start/<process> creates an instance", async () => {
  const { router, calls } = build();
  const res = await router(req("POST", "/app/actions/start/my-proc", { body: { variables: { a: 1 } } }));
  assert.equal(res.status, 200);
  assert.equal(JSON.parse(res.body ?? "{}").processInstanceKey, "pi-42");
  assert.equal(calls.created.length, 1);
  assert.equal(calls.created[0].processDefinitionId, "my-proc");
  assert.deepEqual(calls.created[0].variables, { a: 1 });
});

test("POST /app/actions/cancel cancels, 400 without a key", async () => {
  const { router, calls } = build();
  const ok = await router(req("POST", "/app/actions/cancel", { body: { processInstanceKey: "pi-9" } }));
  assert.equal(ok.status, 200);
  assert.deepEqual(calls.canceled, ["pi-9"]);
  const bad = await router(req("POST", "/app/actions/cancel", { body: {} }));
  assert.equal(bad.status, 400);
});

test("POST /app/actions/cancel uses the injected cancel primitive and returns its result", async () => {
  const seen: string[] = [];
  const cancel: PagesDeps["cancel"] = async (key) => {
    seen.push(key);
    return { ok: true, processInstanceKey: key, state: "TERMINATED", reconciled: 1 };
  };
  const { router } = build({}, { cancel });
  const res = await router(req("POST", "/app/actions/cancel", { body: { processInstanceKey: "pi-7" } }));
  assert.equal(res.status, 200);
  assert.deepEqual(seen, ["pi-7"]);
  assert.deepEqual(JSON.parse(res.body ?? "{}"), {
    ok: true,
    processInstanceKey: "pi-7",
    state: "TERMINATED",
    reconciled: 1,
  });
});

test("POST /app/actions/cancel surfaces a 502 when the cancel primitive reports failure", async () => {
  const cancel: PagesDeps["cancel"] = async (key) => ({
    ok: false,
    processInstanceKey: key,
    state: "ACTIVE",
    reconciled: 0,
    error: "engine rejected the cancellation",
  });
  const { router } = build({}, { cancel });
  const res = await router(req("POST", "/app/actions/cancel", { body: { processInstanceKey: "pi-8" } }));
  assert.equal(res.status, 502);
  assert.equal(JSON.parse(res.body ?? "{}").ok, false);
  assert.match(JSON.parse(res.body ?? "{}").error, /engine rejected/);
});

test("POST /app/actions/cancel maps a throwing cancel primitive to a 502", async () => {
  const cancel: PagesDeps["cancel"] = async () => {
    throw new Error("boom");
  };
  const { router } = build({}, { cancel });
  const res = await router(req("POST", "/app/actions/cancel", { body: { processInstanceKey: "pi-x" } }));
  assert.equal(res.status, 502);
  assert.equal(JSON.parse(res.body ?? "{}").ok, false);
});

test("POST /app/actions/message publishes, 400 on missing fields", async () => {
  const { router, calls } = build();
  const ok = await router(req("POST", "/app/actions/message", {
    body: { name: "answered", correlationKey: "k1", variables: { answer: "yes" } },
  }));
  assert.equal(ok.status, 200);
  assert.equal(calls.messages.length, 1);
  assert.equal(calls.messages[0].name, "answered");
  const noName = await router(req("POST", "/app/actions/message", { body: { correlationKey: "k" } }));
  assert.equal(noName.status, 400);
  const noKey = await router(req("POST", "/app/actions/message", { body: { name: "m" } }));
  assert.equal(noKey.status, 400);
});

test("GET /app/data quotes table/column identifiers in the emitted SQL", async () => {
  const seen: string[] = [];
  const db = fakeDb({
    query: async (sql: string) => {
      seen.push(sql);
      if (/PRAGMA table_info/i.test(sql)) {
        return [{ name: "id" }, { name: "status" }, { name: "total" }];
      }
      return [{ id: 1 }];
    },
  });
  const routes = createPagesRoutes({ pagesDir: "pages", homePage: "home", sourceName: "app" }, {
    db,
    engine: fakeEngine().engine,
    readPage: async () => "{}",
  });
  const router = makeRouter(routes);
  const res = await router(req("GET", "/app/data/app/orders", {
    query: "where=status:new&order=total:desc",
  }));
  assert.equal(res.status, 200);
  const pragma = seen.find((s) => /PRAGMA table_info/i.test(s))!;
  assert.match(pragma, /table_info\("orders"\)/);
  const select = seen.find((s) => /^SELECT/.test(s))!;
  assert.match(select, /FROM "orders"/);
  assert.match(select, /WHERE "status" = \?/);
  assert.match(select, /ORDER BY "total" DESC/);
});

test("GET /app/data returns a structured 500 when the SELECT query throws", async () => {
  const db = fakeDb({
    query: async (sql: string) => {
      if (/PRAGMA table_info/i.test(sql)) return [{ name: "id" }, { name: "status" }];
      throw new Error("disk gone");
    },
  });
  const routes = createPagesRoutes({ pagesDir: "pages", homePage: "home", sourceName: "app" }, {
    db,
    engine: fakeEngine().engine,
    readPage: async () => "{}",
  });
  const res = await makeRouter(routes)(req("GET", "/app/data/app/orders"));
  assert.equal(res.status, 500);
  assert.match(JSON.parse(res.body ?? "{}").error, /disk gone/);
});

test("rowLimit respects an explicit 0 and falls back for non-finite values", async () => {
  const limits: string[] = [];
  const mkDb = () => fakeDb({
    query: async (sql: string) => {
      if (/PRAGMA table_info/i.test(sql)) return [{ name: "id" }];
      const m = sql.match(/LIMIT (\S+)/);
      if (m) limits.push(m[1]);
      return [];
    },
  });
  const run = async (rowLimit: number | undefined) => {
    const routes = createPagesRoutes({ pagesDir: "p", homePage: "h", sourceName: "app", rowLimit }, {
      db: mkDb(),
      engine: fakeEngine().engine,
      readPage: async () => "{}",
    });
    return makeRouter(routes)(req("GET", "/app/data/app/orders"));
  };
  await run(0);
  await run(Infinity);
  await run(undefined);
  assert.deepEqual(limits, ["0", "200", "200"]);
});
