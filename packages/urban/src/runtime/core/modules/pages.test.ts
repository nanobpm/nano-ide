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
  // The runtime module is loaded by a *relative*, *content-fingerprinted* src so it resolves
  // against the document's mount path — works both at the origin root and under the Nano
  // console's /console/app-view/<name>/ reverse proxy. A root-absolute path would 404 against
  // the console origin; a non-fingerprinted URL would let a stale browser cache replay an old
  // module after an upgrade (silently breaking every page action).
  assert.match(res.body ?? "", /src="\.\/app\/runtime\.[0-9a-f]{8}\.js"/);
  assert.doesNotMatch(res.body ?? "", /src="\/app\/runtime\./);
  // The shell itself must never be pinned by the browser (it carries the current module hash).
  assert.match(res.headers?.["cache-control"] ?? "", /no-cache/);
});

test("the API docs badge links via a document-relative href (proxy-safe)", async () => {
  // With an `api` binding, the shell renders a persistent "API docs" badge. Its
  // href must be DOCUMENT-relative (./app/api-docs), mirroring the runtime.js
  // script tag, so it resolves against the shell's mount root. A root-absolute
  // "/app/api-docs" would escape the Nano console's /console/app-view/<name>/
  // reverse proxy and open the console origin (e.g. :8080/app/api-docs) instead
  // of the app's own docs — the port-mismatch bug this guards against.
  const { engine } = fakeEngine();
  const routes = createPagesRoutes(
    { pagesDir: "pages", homePage: "home", sourceName: "app", apiDocsPath: "/app/api-docs" },
    {
      db: fakeDb(),
      engine,
      readPage: async () => JSON.stringify({ title: "Home", nodes: [] }),
      listPages: async () => ["home"],
    },
  );
  const res = await makeRouter(routes)(req("GET", "/"));
  assert.match(res.body ?? "", /class="pc-apidocs"/);
  assert.match(res.body ?? "", /href="\.\/app\/api-docs"/);
  assert.doesNotMatch(res.body ?? "", /href="\/app\/api-docs"/);
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

test("the warn badge stays legible in light appearance", async () => {
  const res = await dispatch("GET", "/");
  const html = res.body ?? "";
  // The warn badge sits on --nano-warn, which is a bright amber in dark mode
  // (dark text reads well) but a dark orange in light mode (#b45309), where the
  // same dark text collapses to near-zero contrast. Both light paths — the
  // console-themed [data-appearance="light"] and the standalone
  // prefers-color-scheme fallback — must flip the warn label to white so it
  // stays readable.
  assert.match(html, /:root\[data-appearance="light"\]\s*\.pc-badge-warn\s*\{\s*color:#fff;\s*\}/);
  assert.match(
    html,
    /@media \(prefers-color-scheme: light\)\s*\{\s*:root:not\(\[data-appearance\]\)\s*\.pc-badge-warn\s*\{\s*color:#fff;\s*\}\s*\}/,
  );
});

test("grid uses fixed layout + wrapping so several wide columns can't overflow the page", async () => {
  // Regression: with table-layout:auto a per-cell max-width let two long
  // free-text columns (e.g. the epic detail's coordination-notes files+note, or
  // trial-merge-results heads+conflicts+failing+summary) each claim ~32rem, and
  // their summed content widths overran the page's width regardless of the
  // viewport. table-layout:fixed divides the width across columns and wraps text
  // within each; overflow-wrap:anywhere still breaks space-less tokens (a 40-char
  // SHA, a JSON blob) inside the column instead of forcing a horizontal scrollbar.
  const res = await dispatch("GET", "/");
  const html = res.body ?? "";
  const tableRule = (html.match(/table\.pc-grid\s*\{[^}]*\}/) ?? [""])[0];
  assert.ok(tableRule, "table.pc-grid rule must be present");
  assert.match(tableRule, /table-layout:\s*fixed/);
  const cellRule = (html.match(/table\.pc-grid th,\s*table\.pc-grid td\s*\{[^}]*\}/) ?? [""])[0];
  assert.ok(cellRule, "grid th/td rule must be present");
  assert.match(cellRule, /overflow-wrap:anywhere/);
  // The per-cell max-width cap was the root cause of the overflow: guard against
  // any future change silently reintroducing it (which would pass the checks above).
  assert.doesNotMatch(cellRule, /max-width:/);
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

test("the fingerprinted runtime URL from the shell is served immutable; the shell references it", async () => {
  // The shell's <script src> must point at a route the router actually serves, and that route
  // must carry long-lived immutable caching (the URL is unique per content, so it can never go
  // stale). This is the cache-bust that stops an upgraded app from replaying an old module.
  const shell = await dispatch("GET", "/");
  const m = (shell.body ?? "").match(/src="\.(\/app\/runtime\.[0-9a-f]{8}\.js)"/);
  assert.ok(m, "shell must reference a fingerprinted runtime URL");
  const res = await dispatch("GET", m![1]);
  assert.equal(res.status, 200);
  assert.match(res.headers?.["content-type"] ?? "", /javascript/);
  assert.match(res.body ?? "", /pc:refresh/);
  assert.match(res.headers?.["cache-control"] ?? "", /immutable/);
  assert.match(res.headers?.["cache-control"] ?? "", /max-age=31536000/);
});

test("the legacy /app/runtime.js URL still serves the module, but no-cache", async () => {
  // Back-compat + defence in depth: an old cached shell (or any client) hitting the unhashed URL
  // still gets the current bytes, and `no-cache` forces revalidation instead of a stale replay.
  const res = await dispatch("GET", "/app/runtime.js");
  assert.equal(res.status, 200);
  assert.match(res.headers?.["content-type"] ?? "", /javascript/);
  assert.match(res.body ?? "", /pc:refresh/);
  assert.match(res.headers?.["cache-control"] ?? "", /no-cache/);
});

test("the shell renders an API-docs badge only when an apiDocsPath is provided", async () => {
  const routes = createPagesRoutes(
    { pagesDir: "pages", homePage: "home", sourceName: "app", apiDocsPath: "/app/api-docs" },
    { db: fakeDb(), engine: fakeEngine().engine, readPage: async () => "{}" },
  );
  const withBadge = (await makeRouter(routes)(req("GET", "/"))).body ?? "";
  assert.match(withBadge, /class="pc-apidocs"/);
  assert.match(withBadge, /href="\.\/app\/api-docs"/);
  // Opens in a new tab with a hardened rel (no reverse-tabnabbing handle).
  assert.match(withBadge, /rel="noopener noreferrer"/);

  // No `api` binding → no badge element (the CSS rule is always present in the shell styles).
  const noBadge = (await dispatch("GET", "/")).body ?? "";
  assert.doesNotMatch(noBadge, /class="pc-apidocs"/);
});

test("page actions are route-driven: the runtime ships a single callRoute dispatcher, no bespoke kinds", async () => {
  const res = await dispatch("GET", "/app/runtime.js");
  const js = res.body ?? "";
  // A single primitive resolves { path, method?, body? } and POSTs it — there is no per-kind
  // branching. The template resolver splices {{form}} / {{row}} and {{form.KEY}} / {{row.KEY}}.
  assert.match(js, /async function runRoute\(action, ctx\)/);
  assert.match(js, /function resolveTemplate\(node, ctx\)/);
  assert.match(js, /function lookupToken\(path, ctx\)/);
  // The form default body is the { variables } envelope, so plain forms hit start operations
  // without any per-form config; row/detail forms carry an explicit body template instead.
  assert.match(js, /body = \{ variables: ctx\.form \}/);
  // Path tokens are URL-encoded (real keys like owner/repo#123 must not break the path).
  assert.match(js, /encodeURIComponent\(String\(v\)\)/);
  // The removed bespoke action kinds no longer appear anywhere in the client runtime.
  assert.doesNotMatch(js, /p\.action\.kind/);
  assert.doesNotMatch(js, /correlationKeyField/);
  assert.doesNotMatch(js, /action\.kind === "(startProcess|publishMessage|cancelProcess)"/);
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

test("renderer preserves inner scroll depth across the refresh poll", async () => {
  // Regression: an open detail row is reused across the 5s poll, but tbody.replaceChildren()
  // detaches it, which resets the scrollTop of any inner overflow:auto container — so a
  // scrolled-into transcript (.pc-transcript, max-height + overflow:auto) jumped back to the
  // top every refreshMs. The client now captures scroll offsets of scrolled descendants
  // before the swap and restores them on the nodes that stay connected afterwards.
  const res = await dispatch("GET", "/app/runtime.js");
  const js = res.body ?? "";
  // Offsets are captured from scrolled descendants before replaceChildren()…
  assert.match(js, /const scrollSaved = \[\]/);
  assert.match(js, /if\s*\(\s*sc\.scrollTop\s*\|\|\s*sc\.scrollLeft\s*\)\s*scrollSaved\.push/);
  // …and restored only on nodes re-attached by the rebuild (still connected).
  assert.match(js, /if\s*\(\s*sc\.isConnected\s*\)\s*\{\s*sc\.scrollTop\s*=\s*top\s*;\s*sc\.scrollLeft\s*=\s*left\s*;\s*\}/);
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

test("renderer wires a column's badge to a tone-classed pill shown only when present", async () => {
  const res = await dispatch("GET", "/app/runtime.js");
  const js = res.body ?? "";
  // A column declaring `badge` renders a compact circular pill (e.g. a red "1"
  // flagging an incident) only when the field value is non-empty; an empty value
  // leaves the cell blank so the column is unobtrusive until it matters. Guard
  // the shape: presence-gated on the trimmed field, tone is allow-listed
  // (default danger), the label defaults to "1", and the full field text becomes
  // the tooltip.
  assert.match(js, /if\s*\(col\.badge\)/);
  assert.match(js, /text\.trim\(\)\s*===\s*""/);
  assert.match(js, /t\s*===\s*"warn"\s*\|\|\s*t\s*===\s*"ok"\s*\|\|\s*t\s*===\s*"info"\s*\?\s*t\s*:\s*"danger"/);
  assert.match(js, /col\.badge\.label\s*==\s*null\s*\?\s*"1"/);
  assert.match(js, /class:\s*"pc-badge pc-badge-"\s*\+\s*tone/);
  assert.match(js, /title:\s*text/);
  assert.match(js, /"aria-label":\s*text/);
});

test("renderer wires a column's processExplorer link to the console explorer", async () => {
  const res = await dispatch("GET", "/app/runtime.js");
  const js = res.body ?? "";
  // A column declaring `link: { kind: "processExplorer", keyField }` renders its
  // text as a link to the Nano console's explorer for the process instance whose
  // key is held in that field. Guard the whole shape so the primitive can't
  // silently regress: the discriminant + keyField are read, the key is trimmed
  // (whitespace-only keys don't produce a link), the console path is constructed
  // here (not from row data), the trimmed key is URL-encoded, and the anchor
  // opens in a new tab with a hardened rel.
  assert.match(js, /col\.link && col\.link\.kind === "processExplorer" && col\.link\.keyField/);
  assert.match(js, /String\(key\)\.trim\(\)/);
  assert.match(js, /"\/console\/explorer\?instance="\s*\+\s*encodeURIComponent\(keyStr\)/);
  assert.match(js, /target:\s*"_blank"/);
  assert.match(js, /rel:\s*"noopener noreferrer"/);
  // Embedded in the console, a plain click routes the host explorer in place via
  // hostNavigate("processExplorer", {instance}) + preventDefault; a modified
  // click (new-tab intent) short-circuits so the native _blank anchor wins.
  assert.match(js, /hostNavigate\("processExplorer",\s*\{\s*instance:\s*keyStr\s*\}\)/);
  // Non-primary buttons (middle/right) and modified clicks keep the native
  // new-tab behavior; only a plain primary click routes in-host.
  assert.match(js, /ev\.button !== 0/);
  assert.match(js, /ev\.metaKey \|\| ev\.ctrlKey \|\| ev\.shiftKey \|\| ev\.altKey/);
  assert.match(js, /ev\.preventDefault\(\)/);
});

test("renderer binds a route param: parseRoute splits page/param, filters + text consume it (#134)", async () => {
  const res = await dispatch("GET", "/app/runtime.js");
  const js = res.body ?? "";
  // A route is #/<page>/<url-encoded-param>. parseRoute splits on the FIRST "/"
  // BEFORE decoding so a param carrying encoded slashes/hashes (a plan_key like
  // "owner/repo#123") survives; the param segment is decoded verbatim into PARAM.
  assert.match(js, /const slash = raw\.indexOf\("\/"\)/);
  assert.match(js, /const paramRaw = slash >= 0 \? raw\.slice\(slash \+ 1\) : ""/);
  assert.match(js, /param = paramRaw \? decodeURIComponent\(paramRaw\) : ""/);
  assert.match(js, /let PARAM = parseRoute\(\)\.param/);
  // renderPage refreshes PARAM from the current route on every (re)render.
  assert.match(js, /const route = parseRoute\(\);\s*CURRENT = route\.page;\s*PARAM = route\.param;/s);
  // A datasource filter with { eqParam: true } binds its value to the live PARAM,
  // so one page template scopes every section to the selected entity.
  assert.match(js, /else if \(f\.eqParam\) qs\.push\("where=" \+ encodeURIComponent\(f\.field \+ ":" \+ PARAM\)\)/);
  // {{param}} interpolates into text nodes as DOM text (never markup). A function
  // replacement inserts PARAM literally, so replacement patterns inside a param id
  // can't be reinterpreted.
  assert.match(js, /function interpParam\(s\)/);
  assert.match(js, /replace\(\/\\\{\\\{param\\\}\\\}\/g, \(\) => PARAM\)/);
  assert.match(js, /interpParam\(node\.props\.text\)/);
  // A grid whose active filter binds to the route param renders zero rows (no data
  // request) when no param is present, rather than emitting a where clause of
  // field-colon-empty (server reads that as field equals empty string and would
  // surface empty-valued rows).
  assert.match(js, /const paramScoped = \(activeFilter \|\| \[\]\)\.some\(\(f\) => f && f\.eqParam\)/);
  assert.match(js, /paramScoped && PARAM === ""\s*\?\s*\{ rows: \[\] \}/s);
});

test("renderer wires a column's page link to an in-app scoped hash route", async () => {
  const res = await dispatch("GET", "/app/runtime.js");
  const js = res.body ?? "";
  // link: { kind: "page", page, keyField } → an in-app #/<page>/<key> hash link
  // (no new tab, no server hit). The page id is safe-id-validated, the key is
  // trimmed + URL-encoded into the param tail, and a blank/keyless cell stays text.
  assert.match(js, /col\.link && col\.link\.kind === "page" && col\.link\.page && col\.link\.keyField/);
  assert.match(js, /safePageId\(col\.link\.page\)/);
  assert.match(js, /"#\/" \+ encodeURIComponent\(col\.link\.page\) \+ "\/" \+ encodeURIComponent\(keyStr\)/);
  // In-app: NOT a new-tab link (no target/rel on this anchor).
  assert.match(js, /el\("a", \{ class: "pc-link", href \}, text\)/);
});

test("renderer groups a dataGrid by a field into persisted collapsible bands (waves)", async () => {
  const res = await dispatch("GET", "/app/runtime.js");
  const js = res.body ?? "";
  // groupBy partitions rows into collapsible groups; each header toggles its
  // members as a unit and the collapsed state is persisted (survives poll+reload).
  assert.match(js, /function appendRows\(rows\)/);
  assert.match(js, /const groupBy = p\.groupBy/);
  assert.match(js, /if \(!groupBy \|\| typeof groupBy !== "string"\) \{ for \(const row of rows\) renderRow\(row, null\); return; \}/);
  // Numeric-aware ascending group order (waves 1,2,10 sort naturally).
  assert.match(js, /const na = Number\(a\), nb = Number\(b\)/);
  // Collapsed state persisted per page + node + group value via the shared helpers.
  assert.match(js, /readCollapsed\(gkey, !!p\.groupDefaultCollapsed\)/);
  assert.match(js, /writeCollapsed\(gkey, gcollapsed\)/);
  assert.match(js, /"pc:collapsed:" \+ CURRENT \+ ":" \+ \(node\.id \|\| p\.title \|\| "grid"\) \+ ":g:" \+ gv/);
  // A collapsed group hides every member row; expanded restores data rows and
  // leaves detail rows at their own expansion state.
  assert.match(js, /m\.tr\.hidden = gcollapsed/);
  assert.match(js, /class: "pc-group-header"/);
  // The group toggle exposes its expanded/collapsed state to assistive tech,
  // mirroring makeCollapsible's header (screen readers announce the change).
  assert.match(js, /btn\.setAttribute\("aria-expanded", String\(!gcollapsed\)\)/);
  // refresh() renders through appendRows so grouping applies on every poll.
  assert.match(js, /tbody\.replaceChildren\(\);\s*appendRows\(rows\);/s);
});

test("renderer supports an opt-in sticky nav bar", async () => {
  const res = await dispatch("GET", "/app/runtime.js");
  const js = res.body ?? "";
  const css = (await dispatch("GET", "/")).body ?? "";
  // A bar nav with { sticky: true } gets the pc-sticky class (rails are excluded).
  assert.match(js, /const barSticky = !rail && p\.sticky === true/);
  assert.match(js, /\(barSticky \? " pc-sticky" : ""\)/);
  // The CSS pins it to the viewport top with a solid background.
  assert.match(css, /\.pc-bar\.pc-sticky \{[^}]*position:sticky[^}]*top:0/);
});

test("renderer exposes an embed-gated host-navigation bridge", async () => {
  const res = await dispatch("GET", "/app/runtime.js");
  const js = res.body ?? "";
  // In-host navigation is gated on being embedded in a SAME-ORIGIN console
  // iframe: standalone (or a cross-origin framer, where postMessage to our own
  // origin could never be delivered) hostNavigate returns false so callers keep
  // the native new-window anchor. The payload is structured (target + params)
  // and posted to the console origin — the host builds its own route, so row
  // data can't smuggle a path. The same-origin gate reads parent.location.origin
  // in a try/catch (a cross-origin parent throws under the same-origin policy).
  assert.match(js, /window\.parent\.location\.origin === window\.location\.origin/);
  assert.match(js, /const NANO_EMBEDDED =/);
  assert.match(js, /function hostNavigate\(target, params\)/);
  assert.match(js, /if \(!NANO_EMBEDDED\) return false;/);
  assert.match(
    js,
    /window\.parent\.postMessage\(\s*\{\s*type:\s*"nano-navigate",\s*target:\s*target,\s*params:\s*params\s*\}\s*,\s*window\.location\.origin\s*\)/,
  );
  // The theme bridge reuses the same embed flag (no second window.parent probe).
  assert.match(js, /if \(NANO_EMBEDDED\) \{/);
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

test("the renderer honours boolean (checkbox) actionForm fields", async () => {
  const res = await dispatch("GET", "/app/runtime.js");
  const js = res.body ?? "";
  // Fields declared `type: "checkbox"` render a real <input type="checkbox">…
  assert.match(js, /f\.type === "checkbox"/);
  assert.match(js, /el\("input", \{ type: "checkbox" \}\)/);
  // …whose default checked state comes from `default`/`checked` on the field…
  assert.match(js, /f\.default === true \|\| f\.checked === true/);
  // …and whose submitted value is always a real boolean (never a string), so a
  // strict `=== true` check on the action side sees the intended value.
  assert.match(js, /variables\[k\] = input\.checked === true;/);
  // A post-submit reset restores a checkbox to its declared default (read off the
  // input's defaultChecked) rather than clearing `.value` (a no-op for a checkbox).
  assert.match(js, /input\.checked = input\.defaultChecked;/);
});

test("the renderer enforces required actionForm fields client-side, blocking submit with an inline hint", async () => {
  const res = await dispatch("GET", "/app/runtime.js");
  const js = res.body ?? "";
  // A field declared `required: true` is tracked in a Set and given an inline
  // error node; the label carries a danger-toned "*" marker before submit.
  assert.match(js, /required\.add\(f\.key\)/);
  assert.match(js, /reqMark = \(f\) =>/);
  assert.match(js, /class: "pc-req"/);
  // The input is marked aria-required, and a clear-on-edit handler wipes the hint
  // the moment the user starts fixing the field (input for text/number, change for
  // a checkbox).
  assert.match(js, /input\.setAttribute\("aria-required", "true"\)/);
  assert.match(js, /wireField\(f, input, ferr, "input"\)/);
  assert.match(js, /wireField\(f, input, ferr, "change"\)/);
  // Submit is GATED: an empty required text/number or an unchecked required
  // checkbox is "missing"; the first offender is focused and the submit RETURNS
  // early (never round-trips to the server).
  assert.match(js, /input\.checked !== true/);
  assert.match(js, /!Number\.isFinite\(Number\(val\)\)/);
  assert.match(js, /if \(firstInvalid\)/);
  assert.match(js, /Please fill in the required fields\./);
  assert.match(js, /firstInvalid\.focus\(\)/);
  assert.match(js, /input\.classList\.add\("pc-invalid"\)/);
  // Editing a required field after a blocked submit clears the summary banner too,
  // so "Please fill in the required fields." never lingers stale while correcting.
  assert.match(js, /msg\.textContent = "";\s*\n\s*msg\.className = "pc-msg";/);
  // A per-field custom message (`requiredMessage`) overrides the default "Required".
  assert.match(js, /reqMsg\.get\(k\) \|\| "Required"/);
  assert.match(js, /f\.requiredMessage/);
});

test("the shell styles required-field markers and inline field errors", async () => {
  const res = await dispatch("GET", "/");
  const html = res.body ?? "";
  // The "*" required marker and the inline per-field error both resolve through
  // the shared danger token, and an empty error node collapses (no reserved gap).
  assert.match(html, /\.pc-req \{ color:var\(--nano-danger\)/);
  assert.match(html, /\.pc-field-err \{ font-size:.75rem; color:var\(--nano-danger\)/);
  assert.match(html, /\.pc-field-err:empty \{ display:none; \}/);
  assert.match(html, /input\.pc-invalid/);
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
  // The hash is parsed into a page + optional param by parseRoute(); the page
  // segment is decoded and safe-id-validated (falling back to HOME).
  assert.match(js, /function parseRoute\(\)/);
  assert.match(js, /const raw = \(location\.hash \|\| ""\)\.replace/s);
  assert.match(js, /if \(safePageId\(p\)\) \{ page = p; pageOk = true; \}/s);
  // A stray param is only carried when the page segment resolved to a real page,
  // so a malformed/unknown page (#/not-a-page/x) falls back to HOME without
  // inheriting x (which would otherwise silently scope home's eqParam grids).
  assert.match(js, /if \(pageOk\) \{ try \{ param = paramRaw \? decodeURIComponent\(paramRaw\) : ""; \}/s);
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

test("the renderer ships a button node that opens a copy-pasteable modal", async () => {
  const res = await dispatch("GET", "/app/runtime.js");
  const js = res.body ?? "";
  // button is a first-class node type.
  assert.match(js, /button: renderButton/);
  assert.match(js, /function renderButton\(node\)/);
  // A ghost variant renders the muted outline style; a button carries its modal.
  assert.match(js, /p\.variant === "ghost"/);
  assert.match(js, /btn\.addEventListener\("click", \(\) => openModal\(m\)\)/);
  // The modal is appended to <body>, is dismissable, and cleans up its keydown.
  assert.match(js, /function openModal\(m\)/);
  assert.match(js, /class: "pc-modal-overlay"/);
  assert.match(js, /"aria-modal": "true"/);
  assert.match(js, /if \(ev\.key === "Escape"\) \{ close\(\); return; \}/);
  assert.match(js, /document\.removeEventListener\("keydown", onKey\)/);
  // {{appBase}} in copy text is rebased onto the absolute mount root so an
  // external agent gets a fetchable URL.
  assert.match(js, /function resolveCopyText\(text\)/);
  assert.match(js, /split\("\{\{appBase\}\}"\)\.join\(APP_BASE\.toString\(\)\)/);
  // Copy is clipboard-first with a sandbox-safe execCommand fallback.
  assert.match(js, /async function copyToClipboard\(text\)/);
  assert.match(js, /navigator\.clipboard\.writeText/);
  assert.match(js, /document\.execCommand\("copy"\)/);
  // The fallback textarea is torn down in a finally so a throwing select()/
  // execCommand never leaves a detached node accreting in <body> on retry.
  assert.match(js, /finally \{ ta\.remove\(\); \}/);
  // The dialog carries an accessible name (labelled by its title, or a fallback
  // aria-label) so screen readers don't announce an unnamed dialog.
  assert.match(js, /"aria-labelledby": titleId/);
  assert.match(js, /"aria-label": "Dialog"/);
  // An open modal is registered with teardown() so a page switch disposes it
  // instead of leaking a stale overlay + document-level keydown listener.
  assert.match(js, /disposers\.push\(close\)/);
  // A manual close removes its own disposer entry, so repeated open/close cycles
  // don't accrete dead close() closures on the disposers stack.
  assert.match(js, /disposers\.indexOf\(close\)/);
  assert.match(js, /disposers\.splice\(i, 1\)/);
  // Focus is restored to the previously-focused element on close, and Tab is
  // trapped inside the dialog so it can't reach the inert page behind the overlay.
  assert.match(js, /const prevFocus = document\.activeElement/);
  assert.match(js, /if \(ev\.key !== "Tab"\) return/);
  assert.match(js, /ev\.preventDefault\(\); last\.focus\(\)/);
  assert.match(js, /ev\.preventDefault\(\); first\.focus\(\)/);
  // Only one modal opens at a time: a second open (e.g. double-click) is dropped
  // so overlays and document-level keydown listeners never stack.
  assert.match(js, /let modalOpen = false/);
  assert.match(js, /if \(modalOpen\) return/);
  assert.match(js, /modalOpen = true/);
  assert.match(js, /modalOpen = false/);
  // The aria-labelledby title id is unique per modal instance so it can't
  // collide with a pre-existing page id and mis-associate the label.
  assert.match(js, /let modalSeq = 0/);
  assert.match(js, /"pc-modal-title-" \+ \(\+\+modalSeq\)/);
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
