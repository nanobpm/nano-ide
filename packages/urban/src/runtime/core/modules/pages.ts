// The Urban App page runtime as a runtime SURFACE (ADR 0042 §3, ADR 0055 phase 2).
//
// Ported from the console-generated `app-pages.ts` (`@nanobpm/app`). It turns a composed
// `page.json` (authored in the console Page Composer) into a served, data-bound screen
// with no hand-written frontend or API. Where the generated module took an injected
// `db`/`nano` and served its own Deno HTTP server, this version binds to the runtime
// seams: the datasource gateway (`app.data.open(source)`), the `EngineClient`, and the
// host's `readTextFile`, and contributes `Route`s to the runtime's shared HTTP server.
//
// Endpoints (ADR 0026 §1 action API):
//   GET  /              (+ /app/runtime.js)         → the schema-driven browser renderer
//   GET  /app/pages/<id>                            → the page's page.json
//   GET  /app/data/<source>/<table>[?where&order]   → rows (filtered/ordered, whitelisted)
//   POST /app/actions/start/<process>               → engine.createInstance
//   POST /app/actions/cancel                        → engine.cancelInstance
//   POST /app/actions/message                       → engine.publishMessage
//
// Page actions are ROUTE-DRIVEN: an `actionForm`/rowAction/detail-form `action` is just
// `{ path, method?, body?, successLabel? }`. The client POSTs the resolved body (default
// `{ variables: <form> }`) to `path`, templating `{{form.KEY}}` / `{{row.KEY}}` (and the
// whole-object `{{form}}` / `{{row}}`) tokens. There are NO bespoke action kinds — a form
// reaches start/cancel/message above, an OpenAPI operation under /app/api, or any app route
// uniformly by naming its path.

import type { AppApi, RuntimeContext } from "../context.ts";
import { errorMessage, isRecord } from "../guards.ts";
import type { EngineClient } from "../host.ts";
import { html, json, type Route } from "../router.ts";
import { cancelInstanceReconciling, type CancelInstanceResult } from "./cancel.ts";
import { apiDocsPath } from "./api.ts";
import { quoteIdent } from "./gateway.ts";

/** The subset of the datasource gateway the page runtime needs. */
export interface PagesDataSource {
  query(sql: string, params?: unknown[]): Promise<Record<string, unknown>[]>;
  schema(): Promise<{ name: string }[]>;
}

export interface PagesOptions {
  /** Directory holding `*.page.json` (relative to the app root). Default `pages`. */
  pagesDir?: string;
  /** The page served at `/`. Default `home`. */
  homePage?: string;
  /** Max rows a `dataGrid` fetch returns. Default 200. */
  rowLimit?: number;
  /** The injected default datasource name (the alias apps bind to). Default `app`. */
  sourceName?: string;
  /**
   * The app's Swagger UI route (from the `api` binding, resolved by `apiDocsPath`). When set,
   * the shell renders a persistent "API docs" badge linking to it — so a spec-first app surfaces
   * its interactive docs from its own UI for free. Omitted → no badge (app declares no `api`).
   */
  apiDocsPath?: string;
}

export interface PagesDeps {
  db: PagesDataSource;
  engine: EngineClient;
  /** Read a page file; injectable for tests. */
  readPage(path: string): Promise<string>;
  /**
   * List the available page ids (the `*.page.json` basenames under `pagesDir`),
   * powering the `/app/pages` index endpoint and a `nav` node's `items: "auto"`.
   * Optional; when absent the index is empty. Injectable for tests.
   */
  listPages?(): Promise<string[]>;
  /**
   * Cancel a process instance honestly: terminate it, verify it is actually gone, and reconcile
   * any `instanceTracking` row bound to its key. Injected by `mountPages` (bound to the app's
   * engine, datasource, and instanceTracking bindings). When absent, the `/app/actions/cancel`
   * route falls back to a bare `engine.cancelInstance` (used by tests that inject no cancel dep).
   */
  cancel?(processInstanceKey: string): Promise<CancelInstanceResult>;
}

/** A JavaScript-body response (the renderer module served at the fingerprinted
 * `/app/runtime.<hash>.js`, and its `/app/runtime.js` back-compat route). */
function javascript(
  body: string,
  status = 200,
  extraHeaders?: Record<string, string>,
): { status: number; headers: Record<string, string>; body: string } {
  return {
    status,
    headers: { "content-type": "text/javascript; charset=utf-8", ...extraHeaders },
    body,
  };
}

/** A SQL identifier guard — a table name must be a bare identifier *and* a known table
 * (checked against `schema()`), so `/app/data/:table` can never inject SQL. */
const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Build the page-runtime routes over an injected datasource + engine. Pure over its deps
 * so it is unit-testable without a real host/server (see pages.test.ts).
 */
export function createPagesRoutes(opts: PagesOptions, deps: PagesDeps): Route[] {
  const pagesDir = opts.pagesDir ?? "pages";
  const homePage = opts.homePage ?? "home";
  const rowLimitRaw = opts.rowLimit ?? 200;
  const rowLimit = Number.isFinite(rowLimitRaw) ? Math.max(0, Math.floor(rowLimitRaw)) : 200;
  const sourceName = opts.sourceName ?? "app";
  const { db, engine, readPage, listPages, cancel } = deps;

  // The table-name whitelist is memoised: an Urban app runs its migrations at boot
  // (before serving), so the schema is stable for the process lifetime, and the renderer
  // refreshes grids repeatedly — re-introspecting on every `/app/data` hit would be a hot
  // path. Introspect once, lazily, and reuse. A rejected introspection is NOT cached (the
  // in-flight promise is cleared on failure) so a transient error doesn't wedge every
  // future request.
  let tableNames: Promise<Set<string>> | null = null;
  const knownTables = (): Promise<Set<string>> =>
    (tableNames ??= db.schema().then(
      (t) => new Set(t.map((x) => x.name)),
      (err) => {
        tableNames = null;
        throw err;
      },
    ));

  // Per-table column whitelist, introspected once per table via `PRAGMA table_info`.
  // Every filter/order column named in a `/app/data` query is checked against this set
  // before it reaches the SQL, so an attacker-supplied `where`/`order` can never inject.
  const tableColumns = new Map<string, Promise<Set<string>>>();
  const knownColumns = (table: string): Promise<Set<string>> => {
    const cached = tableColumns.get(table);
    if (cached) return cached;
    const p = db
      .query(`PRAGMA table_info(${quoteIdent(table)})`)
      .then((rows) => new Set(rows.map((r) => String(r.name))))
      .catch((err) => {
        tableColumns.delete(table);
        throw err;
      });
    tableColumns.set(table, p);
    return p;
  };

  const routes: Route[] = [];
  const shell = html(rendererShell(homePage, opts.apiDocsPath));
  // The shell must never be pinned by the browser: it carries the *current* fingerprinted
  // runtime URL, so a stale shell would keep pointing at an old module hash. `no-cache` forces
  // a revalidation on every load; the shell body is tiny, and the expensive module it references
  // is what gets the long-lived immutable caching (via its content-hashed URL).
  shell.headers = { ...shell.headers, "cache-control": "no-cache" };

  // ── the renderer shell + module ─────────────────────────────────────────
  routes.push({ method: "GET", path: "/", source: "surface:pages", handler: () => shell });
  routes.push({ method: "GET", path: "/index.html", source: "surface:pages", handler: () => shell });
  // The fingerprinted module URL (referenced by the shell): unique per content, so cache it hard.
  routes.push({
    method: "GET",
    path: RUNTIME_JS_PATH,
    source: "surface:pages",
    handler: () => javascript(RENDERER_JS, 200, { "cache-control": IMMUTABLE_CACHE }),
  });
  // Back-compat / defence in depth: the legacy unhashed URL keeps working, but is served
  // `no-cache` so any client (or cached shell) that still requests it always revalidates and
  // gets the current bytes instead of replaying a heuristically-cached older copy.
  routes.push({
    method: "GET",
    path: "/app/runtime.js",
    source: "surface:pages",
    handler: () => javascript(RENDERER_JS, 200, { "cache-control": "no-cache" }),
  });

  // ── GET /app/pages (index of available pages) ───────────────────────────
  // Powers multi-page navigation: a `nav` node with `items: "auto"` lists every
  // page here, and it lets any client enumerate the app's screens. Each entry
  // carries the page's own `title` (best-effort — an unreadable/!JSON page still
  // appears by id) and a `home` flag. Registered as an exact path so it never
  // shadows the `/app/pages/<id>` prefix route below.
  routes.push({
    method: "GET",
    path: "/app/pages",
    source: "surface:pages",
    handler: async () => {
      const ids = listPages ? await listPages().catch(() => []) : [];
      const pages: { id: string; title: string; home: boolean }[] = [];
      for (const id of ids) {
        if (!/^[A-Za-z0-9_-]+$/.test(id)) continue;
        let title = id;
        try {
          const doc = JSON.parse(await readPage(`${pagesDir}/${id}.page.json`));
          if (isRecord(doc) && typeof doc.title === "string" && doc.title) title = doc.title;
        } catch {
          // Unreadable or non-JSON page: still list it by id.
        }
        pages.push({ id, title, home: id === homePage });
      }
      return json({ pages, home: homePage });
    },
  });

  // ── GET /app/pages/<id> ─────────────────────────────────────────────────
  routes.push({
    method: "GET",
    path: "/app/pages/",
    prefix: true,
    source: "surface:pages",
    handler: async (req) => {
      const m = req.path.match(/^\/app\/pages\/([A-Za-z0-9_-]+)$/);
      if (!m) return json({ error: "not found" }, 404);
      const id = m[1];
      try {
        const text = await readPage(`${pagesDir}/${id}.page.json`);
        return { status: 200, headers: { "content-type": "application/json" }, body: text };
      } catch {
        return json({ error: `page "${id}" not found` }, 404);
      }
    },
  });

  // ── GET /app/data/<source>/<table> ──────────────────────────────────────
  routes.push({
    method: "GET",
    path: "/app/data/",
    prefix: true,
    source: "surface:pages",
    handler: async (req) => {
      const m = req.path.match(/^\/app\/data\/([A-Za-z0-9_-]+)\/([A-Za-z0-9_]+)$/);
      if (!m) return json({ error: "not found" }, 404);
      const source = m[1];
      const table = m[2];
      // v1 exposes only the injected default datasource; a request naming any other
      // source is rejected rather than silently served off the default.
      if (source !== sourceName) return json({ error: `unknown datasource "${source}"` }, 404);
      if (!IDENT.test(table)) return json({ error: "invalid table name" }, 400);
      let tables: Set<string>;
      try {
        tables = await knownTables();
      } catch {
        return json({ error: "schema introspection failed" }, 500);
      }
      if (!tables.has(table)) return json({ error: `unknown table "${table}"` }, 404);
      // Parse ?where=col:value (equality) or ?where=col:in:v1,v2 (set membership),
      // repeatable and ANDed, plus ?order=col:dir. Every column is whitelisted against
      // the table's real columns before it reaches the SQL; values are always bound as
      // `?` parameters (commas in an `in` list split values).
      let columns: Set<string>;
      try {
        columns = await knownColumns(table);
      } catch {
        return json({ error: "schema introspection failed" }, 500);
      }
      const params: unknown[] = [];
      const clauses: string[] = [];
      for (const raw of req.query.getAll("where")) {
        const colon = raw.indexOf(":");
        if (colon <= 0) return json({ error: "invalid where clause" }, 400);
        const field = raw.slice(0, colon);
        const rest = raw.slice(colon + 1);
        if (!columns.has(field)) return json({ error: `unknown column "${field}"` }, 400);
        if (rest.startsWith("in:")) {
          const values = rest.slice(3).split(",");
          clauses.push(`${quoteIdent(field)} IN (${values.map(() => "?").join(", ")})`);
          for (const v of values) params.push(v);
        } else {
          clauses.push(`${quoteIdent(field)} = ?`);
          params.push(rest);
        }
      }
      let orderSql = "";
      const orderRaw = req.query.get("order");
      if (orderRaw) {
        const colon = orderRaw.indexOf(":");
        const field = colon > 0 ? orderRaw.slice(0, colon) : orderRaw;
        const dir = colon > 0 && orderRaw.slice(colon + 1).toLowerCase() === "desc" ? "DESC" : "ASC";
        if (!columns.has(field)) return json({ error: `unknown column "${field}"` }, 400);
        orderSql = ` ORDER BY ${quoteIdent(field)} ${dir}`;
      }
      const whereSql = clauses.length ? ` WHERE ${clauses.join(" AND ")}` : "";
      try {
        const rows = await db.query(
          `SELECT * FROM ${quoteIdent(table)}${whereSql}${orderSql} LIMIT ${rowLimit}`,
          params,
        );
        return json({ rows });
      } catch (e) {
        return json({ error: errorMessage(e) }, 500);
      }
    },
  });

  // ── POST /app/actions/start/<process> ───────────────────────────────────
  routes.push({
    method: "POST",
    path: "/app/actions/start/",
    prefix: true,
    source: "surface:pages",
    handler: async (req) => {
      const m = req.path.match(/^\/app\/actions\/start\/([A-Za-z0-9_.-]+)$/);
      if (!m) return json({ error: "not found" }, 404);
      const process = m[1];
      let variables: Record<string, unknown> = {};
      try {
        const body = JSON.parse((await req.text()) || "{}");
        if (isRecord(body)) {
          const v = body.variables;
          // Only a plain object is a valid variable map — reject arrays/scalars/null so a
          // malformed body can't reach the engine as bad `variables`.
          if (isRecord(v)) {
            variables = v;
          }
        }
      } catch {
        return json({ error: "body must be JSON" }, 400);
      }
      try {
        const res = await engine.createInstance({ processDefinitionId: process, variables });
        return json({ processInstanceKey: res.processInstanceKey ?? null });
      } catch (e) {
        return json({ error: errorMessage(e) }, 502);
      }
    },
  });

  // ── POST /app/actions/cancel ────────────────────────────────────────────
  routes.push({
    method: "POST",
    path: "/app/actions/cancel",
    source: "surface:pages",
    handler: async (req) => {
      let key: string | number | undefined;
      try {
        const body = JSON.parse((await req.text()) || "{}");
        const k = isRecord(body) ? body.processInstanceKey : undefined;
        if (typeof k === "string" || typeof k === "number") key = k;
      } catch {
        return json({ error: "body must be JSON" }, 400);
      }
      if (key === undefined || key === "") return json({ error: "processInstanceKey is required" }, 400);
      // The reconcile-aware primitive verifies the real post-cancel state and flips the tracked
      // row immediately; a !ok result means the engine did NOT stop the instance, so surface 502.
      if (cancel) {
        try {
          const result = await cancel(String(key));
          return json(result, result.ok ? 200 : 502);
        } catch (e) {
          // Defensive: the primitive is designed not to throw, but if it ever does, mirror the
          // fallback path's honest 502 rather than letting the request reject as a 500.
          return json({ ok: false, processInstanceKey: String(key), error: errorMessage(e) }, 502);
        }
      }
      try {
        await engine.cancelInstance({ processInstanceKey: String(key) });
        return json({ ok: true });
      } catch (e) {
        return json({ error: errorMessage(e) }, 502);
      }
    },
  });

  // ── POST /app/actions/message ───────────────────────────────────────────
  routes.push({
    method: "POST",
    path: "/app/actions/message",
    source: "surface:pages",
    handler: async (req) => {
      let name = "";
      let correlationKey = "";
      let variables: Record<string, unknown> = {};
      try {
        const parsed: unknown = JSON.parse((await req.text()) || "{}");
        const body = isRecord(parsed) ? parsed : {};
        if (typeof body?.name === "string") name = body.name;
        if (typeof body?.correlationKey === "string" || typeof body?.correlationKey === "number") {
          correlationKey = String(body.correlationKey);
        }
        const v = body?.variables;
        if (isRecord(v)) {
          variables = v;
        }
      } catch {
        return json({ error: "body must be JSON" }, 400);
      }
      if (!name) return json({ error: "message name is required" }, 400);
      if (!correlationKey) return json({ error: "correlationKey is required" }, 400);
      try {
        await engine.publishMessage({ name, correlationKey, variables });
        return json({ ok: true });
      } catch (e) {
        return json({ error: errorMessage(e) }, 502);
      }
    },
  });

  return routes;
}

export interface PagesHandle {
  readonly name: string;
  routes: Route[];
  describe(): Record<string, unknown>;
}

/**
 * Mount the `pages` surface when enabled in the manifest. Binds the page runtime to the
 * app's datasource gateway (`app.data.open(source)`), engine, and the host's file read.
 * Returns no routes when the surface is disabled or absent.
 */
export function mountPages(ctx: RuntimeContext, app: AppApi): PagesHandle {
  const decl = ctx.manifest.surfaces?.pages;
  if (!decl?.enabled) {
    return { name: "pages", routes: [], describe: () => ({ enabled: false }) };
  }
  const opts: PagesOptions = {
    pagesDir: typeof decl.pagesDir === "string" ? decl.pagesDir : undefined,
    homePage: typeof decl.homePage === "string" ? decl.homePage : undefined,
    rowLimit: typeof decl.rowLimit === "number" ? decl.rowLimit : undefined,
    sourceName: typeof decl.sourceName === "string" ? decl.sourceName : undefined,
    // Link the shell's "API docs" badge to the app's Swagger UI when it declares an `api`
    // binding (resolved by the api module, so the path never drifts from where docs mount).
    apiDocsPath: apiDocsPath(ctx.manifest),
  };
  const sourceName = opts.sourceName ?? "app";
  const bindings = ctx.manifest.instanceTracking ?? [];
  const routes = createPagesRoutes(opts, {
    db: app.data.open(sourceName),
    engine: app.engine,
    cancel: (key) => cancelInstanceReconciling(app, bindings, key),
    readPage: (p) => ctx.host.readTextFile(p),
    listPages: async () => {
      const dir = opts.pagesDir ?? "pages";
      const names = await ctx.host.listDir(dir).catch(() => []);
      return names
        .filter((n) => n.endsWith(".page.json"))
        .map((n) => n.slice(0, -".page.json".length));
    },
  });
  ctx.host.log("info", "pages surface mounted", { source: sourceName, home: opts.homePage ?? "home" });
  return {
    name: "pages",
    routes,
    describe: () => ({ enabled: true, source: sourceName, home: opts.homePage ?? "home" }),
  };
}

function escapeAttr(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function rendererShell(homePage: string, apiDocsPath?: string): string {
  // A persistent "API docs" badge (spec-first apps get their Swagger UI linked from their own
  // UI for free). `target="_blank"` + hardened `rel` so the docs open without giving the docs
  // tab a handle back to this window (reverse-tabnabbing).
  //
  // The href must be DOCUMENT-relative, exactly like the `./app/runtime.<hash>.js` script tag below:
  // the shell is served at the app's mount root (always a trailing "/"), which is the origin
  // root for a direct run (CLI on :3000) but a path prefix under the Nano console's reverse
  // proxy (/console/app-view/<name>/). A root-absolute "/app/api-docs" would escape that prefix
  // and open the CONSOLE origin (e.g. :8080/app/api-docs) instead of the app's docs. Strip the
  // single leading slash so it rebases onto the mount root; leave a protocol-relative "//host"
  // (which apiDocsPath never emits) untouched.
  const badgeHref =
    apiDocsPath && apiDocsPath.startsWith("/") && !apiDocsPath.startsWith("//")
      ? `./${apiDocsPath.slice(1)}`
      : apiDocsPath;
  const apiDocsBadge = apiDocsPath
    ? `\n  <a class="pc-apidocs" href="${escapeAttr(badgeHref!)}" target="_blank" rel="noopener noreferrer">API docs \u2197</a>`
    : "";
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Urban App</title>
  <style>${RENDERER_CSS}</style>
</head>
<body>${apiDocsBadge}
  <main id="page" data-home="${escapeAttr(homePage)}"><p class="pc-empty">Loading…</p></main>
  <script type="module" src=".${RUNTIME_JS_PATH}"></script>
</body>
</html>`;
}

// The app's stylesheet resolves every colour through the Nano console's
// semantic `--nano-*` token contract (see the Magikcraft/nano-bpm repo's
// `console/src/theme/tokens.css` — MIRROR: keep the palettes below in sync). When the app is embedded in the
// console it inherits nothing across the iframe boundary, so the console
// postMessages its resolved tokens + appearance and the runtime lays them onto
// this document's :root (see RENDERER_JS). Standalone (CLI on :3000) there is no
// console, so the defaults below stand on their own: dark by default, light when
// the OS asks for it and nothing has themed us. `--pc-*` are kept as thin
// aliases so existing class rules re-resolve through the shared tokens.
// The single mobile breakpoint (max-width) for the urban responsive primitive
// (#268). ONE source of truth: it is interpolated into both the shell CSS
// `@media` query (which drives the pure-CSS card flip / nav collapse / button
// stacking) AND the runtime's `matchMedia` mode-switch (which only Tier-2's
// optional page-level `mobile` layout variant needs), so the two can never
// drift apart on where "narrow" begins.
const MOBILE_MAX_WIDTH = "640px";

const RENDERER_CSS = `
:root {
  color-scheme: dark;
  --nano-app:#0b0b10; --nano-panel:#10101a; --nano-raised:#16161f; --nano-inset:#08080c; --nano-hover:#1e1e2a;
  --nano-edge:#24242f; --nano-edge-strong:#383848;
  --nano-text:#f2f2f7; --nano-text-muted:#a3a3b2; --nano-text-faint:#6e6e80;
  --nano-accent:#8b5cf6; --nano-accent-strong:#a78bfa; --nano-accent-2:#22d3ee; --nano-on-accent:#ffffff;
  --nano-ok:#34d399; --nano-warn:#fbbf24; --nano-danger:#fb7185; --nano-info:#38bdf8;
}
:root[data-appearance="light"] {
  color-scheme: light;
  --nano-app:#f5f5f9; --nano-panel:#fdfdfe; --nano-raised:#ffffff; --nano-inset:#ededf3; --nano-hover:#e8e8f0;
  --nano-edge:#e2e2ea; --nano-edge-strong:#c5c5d4;
  --nano-text:#1a1a22; --nano-text-muted:#565664; --nano-text-faint:#8c8c9c;
  --nano-accent:#7c3aed; --nano-accent-strong:#6d28d9; --nano-accent-2:#0891b2; --nano-on-accent:#ffffff;
  --nano-ok:#059669; --nano-warn:#b45309; --nano-danger:#e11d48; --nano-info:#0369a1;
}
@media (prefers-color-scheme: light) {
  /* Standalone only: follow the OS until the console (which sets data-appearance) themes us. */
  :root:not([data-appearance]) {
    color-scheme: light;
    --nano-app:#f5f5f9; --nano-panel:#fdfdfe; --nano-raised:#ffffff; --nano-inset:#ededf3; --nano-hover:#e8e8f0;
    --nano-edge:#e2e2ea; --nano-edge-strong:#c5c5d4;
    --nano-text:#1a1a22; --nano-text-muted:#565664; --nano-text-faint:#8c8c9c;
    --nano-accent:#7c3aed; --nano-accent-strong:#6d28d9; --nano-accent-2:#0891b2; --nano-on-accent:#ffffff;
    --nano-ok:#059669; --nano-warn:#b45309; --nano-danger:#e11d48; --nano-info:#0369a1;
  }
}
:root { --pc-edge:var(--nano-edge); --pc-accent:var(--nano-accent); }
* { box-sizing: border-box; }
body { margin:0; font:15px/1.5 system-ui,sans-serif; padding:2rem; max-width:64rem; margin-inline:auto; background:var(--nano-app); color:var(--nano-text); }
.pc-empty { color:var(--nano-text-faint); }
.pc-apidocs { position:fixed; top:.75rem; right:.75rem; z-index:10; font-size:.8rem; text-decoration:none; padding:.3rem .6rem; border:1px solid var(--nano-edge); border-radius:999px; background:var(--nano-panel); color:var(--nano-text-muted); }
.pc-apidocs:hover { color:var(--nano-text); border-color:var(--nano-accent); }
.pc-heading { font-size:1.6rem; font-weight:650; margin:0 0 .25rem; }
.pc-sub { color:var(--nano-text-muted); margin:.25rem 0 1rem; }
.pc-body { margin:.5rem 0; }
.pc-card { border:1px solid var(--nano-edge); border-radius:.6rem; padding:1rem 1.15rem; margin:1rem 0; background:var(--nano-panel); }
.pc-card h2 { font-size:1rem; margin:0 0 .75rem; }
.pc-field { display:flex; flex-direction:column; gap:.25rem; margin-bottom:.6rem; }
.pc-field label { font-size:.8rem; color:var(--nano-text-muted); }
.pc-field input:not([type=checkbox]) { padding:.5rem .6rem; border:1px solid var(--nano-edge); border-radius:.4rem; font:inherit; background:var(--nano-inset); color:var(--nano-text); }
.pc-field-check label { display:flex; flex-direction:row; align-items:center; gap:.5rem; font-size:.9rem; color:var(--nano-text); cursor:pointer; }
.pc-field-check input { width:auto; padding:0; accent-color:var(--nano-accent); cursor:pointer; }
.pc-btn { padding:.5rem .9rem; border:0; border-radius:.4rem; background:var(--nano-accent); color:var(--nano-on-accent); font:inherit; cursor:pointer; }
.pc-btn:disabled { opacity:.5; cursor:default; }
.pc-msg { font-size:.85rem; margin-top:.5rem; min-height:1.2em; }
.pc-msg.err { color:var(--nano-danger); }
.pc-msg.ok { color:var(--nano-ok); }
.pc-req { color:var(--nano-danger); font-weight:600; }
.pc-field-err { font-size:.75rem; color:var(--nano-danger); margin:.1rem 0 0; }
.pc-field-err:empty { display:none; }
.pc-field input.pc-invalid, .pc-field-check input.pc-invalid { border-color:var(--nano-danger); outline-color:var(--nano-danger); }
table.pc-grid { width:100%; border-collapse:collapse; font-size:.9rem; table-layout:fixed; }
/* table-layout:fixed divides the available width across columns and wraps text
   within each, so a grid with several long free-text columns (e.g. the epic
   detail's coordination-notes / trial-merge-results) can't sum its columns'
   content widths past the page — the failure mode of table-layout:auto, where a
   per-cell max-width let two wide columns each claim ~32rem and overrun the page.
   overflow-wrap:anywhere additionally breaks space-less tokens (a 40-char SHA, a
   JSON blob) so they wrap inside the column instead of forcing a scrollbar.
   vertical-align:top keeps a multi-line cell aligned with its single-line
   neighbours. */
table.pc-grid th, table.pc-grid td { text-align:left; padding:.4rem .6rem; border-bottom:1px solid var(--nano-edge); overflow-wrap:anywhere; word-wrap:break-word; vertical-align:top; }
table.pc-grid th { font-weight:600; color:var(--nano-text-muted); }
/* A cell's optional muted second line (col.subtitleField / subtitleTemplate):
   the identity key rendered under the title, GitHub/Linear style. Plain DOM
   text (never a link/href source), smaller and muted so the primary line leads. */
.pc-cell-sub { font-size:.8rem; color:var(--nano-text-muted); margin-top:.1rem; }
/* One-line clamp (col.truncate): stop a bounded column wrapping and show an
   ellipsis, with the full value carried in a title=/aria-label tooltip. Needs a
   bounded column (per-column width/weight) to clip against; a native <col> width
   is honoured under table-layout:fixed. Applied to the primary and, when present,
   the subtitle line so both stay single-line. */
.pc-truncate { white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.pc-tabs { display:flex; gap:.5rem; margin-bottom:.75rem; }
.pc-tab { padding:.35rem .8rem; border:1px solid var(--nano-edge); border-radius:.4rem; background:transparent; color:inherit; font:inherit; cursor:pointer; }
.pc-tab.active { background:var(--nano-accent); color:var(--nano-on-accent); border-color:var(--nano-accent); }
.pc-btn-sm { padding:.25rem .55rem; font-size:.8rem; margin-right:.3rem; }
.pc-chevron { background:transparent; color:inherit; border:1px solid var(--nano-edge); }
.pc-row-actions { white-space:nowrap; text-align:right; }
.pc-detail { padding:.75rem .25rem; }
.pc-detail-field { display:flex; gap:.5rem; font-size:.85rem; margin:.15rem 0; }
.pc-detail-label { color:var(--nano-text-muted); min-width:8rem; }
.pc-link { color:var(--nano-accent); }
.pc-badge { display:inline-flex; align-items:center; justify-content:center; min-width:1.35rem; height:1.35rem; box-sizing:border-box; padding:0 .4rem; border-radius:999px; font-size:.72rem; font-weight:700; line-height:1; color:#fff; background:var(--nano-danger); }
.pc-badge-danger { background:var(--nano-danger); }
.pc-badge-warn { background:var(--nano-warn); color:#3a2a00; }
.pc-badge-ok { background:var(--nano-ok); }
.pc-badge-info { background:var(--nano-info); }
/* Live row-count pill (dataGrid showCount): a subtle, neutral count distinct from
   the coloured status badges, legible in the collapse header while collapsed. */
.pc-count-badge { color:var(--nano-text); background:var(--nano-inset); border:1px solid var(--nano-edge); font-weight:600; }
:root[data-appearance="light"] .pc-badge-warn { color:#fff; }
@media (prefers-color-scheme: light) { :root:not([data-appearance]) .pc-badge-warn { color:#fff; } }
/* Pipeline / stepper cell (issue #265): a per-row, multi-stage horizontal
   progress track rendered by pipelineCell. Only the track/stage chrome lives
   here (the .pc-pipe classes); per-stage badges and locus links reuse the
   .pc-badge and .pc-link classes.
   All colours come from the shared --nano-* tokens so light/dark themes work.
   Stage treatments: done = filled/ok-tinted, active = lit accent, active+ok =
   success (✓), active+failed = danger (✕), active+blocked = warn (⊘), upcoming =
   faint/ghosted, skip (not-in-path) = dashed. */
.pc-pipe { display:flex; align-items:center; flex-wrap:wrap; gap:.15rem; font-size:.8rem; }
.pc-pipe-stage { display:inline-flex; align-items:center; gap:.3rem; padding:.12rem .5rem; border:1px solid var(--nano-edge); border-radius:999px; background:transparent; color:var(--nano-text-muted); white-space:nowrap; }
.pc-pipe-label { color:inherit; }
.pc-pipe-mark { font-weight:700; line-height:1; }
.pc-pipe-conn { flex:0 0 auto; width:.9rem; height:2px; border-radius:1px; background:var(--nano-edge); }
.pc-pipe-conn.filled { background:var(--nano-ok); }
.pc-pipe-done { color:var(--nano-text); border-color:var(--nano-ok); background:var(--nano-hover); }
.pc-pipe-active { color:var(--nano-text); font-weight:650; border-color:var(--nano-accent); background:var(--nano-hover); box-shadow:0 0 0 1px var(--nano-accent) inset; }
.pc-pipe-active.pc-pipe-ok { border-color:var(--nano-ok); box-shadow:0 0 0 1px var(--nano-ok) inset; }
.pc-pipe-active.pc-pipe-ok .pc-pipe-mark { color:var(--nano-ok); }
.pc-pipe-active.pc-pipe-failed { border-color:var(--nano-danger); box-shadow:0 0 0 1px var(--nano-danger) inset; }
.pc-pipe-active.pc-pipe-failed .pc-pipe-mark { color:var(--nano-danger); }
.pc-pipe-active.pc-pipe-blocked { border-color:var(--nano-warn); box-shadow:0 0 0 1px var(--nano-warn) inset; }
.pc-pipe-active.pc-pipe-blocked .pc-pipe-mark { color:var(--nano-warn); }
.pc-pipe-upcoming { color:var(--nano-text-faint); border-color:var(--nano-edge); opacity:.75; }
.pc-pipe-skip { color:var(--nano-text-faint); border-style:dashed; opacity:.6; }
.pc-child { margin:.6rem 0; }
.pc-child-title { font-size:.8rem; font-weight:600; color:var(--nano-text-muted); margin-bottom:.25rem; }
.pc-transcript { white-space:pre-wrap; max-height:22rem; overflow:auto; background:var(--nano-inset); padding:.5rem; border-radius:.4rem; font-size:.8rem; margin-top:.4rem; }
.pc-subform { margin-top:.75rem; padding:.6rem; border:1px dashed var(--nano-edge); border-radius:.5rem; }
.pc-subform-title { font-weight:600; font-size:.85rem; margin-bottom:.4rem; }
.pc-prompt { font-size:.85rem; color:var(--nano-text-muted); margin-bottom:.4rem; white-space:pre-wrap; }
.pc-textarea { width:100%; min-height:4rem; padding:.5rem; border:1px solid var(--nano-edge); border-radius:.4rem; font:inherit; background:var(--nano-inset); color:var(--nano-text); }
.pc-collapse-header { display:flex; align-items:center; gap:.5rem; width:100%; margin:0 0 .75rem; padding:0; background:transparent; border:0; color:inherit; font:inherit; font-size:1rem; font-weight:600; cursor:pointer; text-align:left; }
.pc-chevron-inline { color:var(--nano-text-faint); font-size:.75rem; width:1em; }
.pc-card-body[hidden] { display:none; }
/* Grid group headers (dataGrid groupBy): a full-width, clickable band that
   collapses/expands its member rows; the collapsed state is persisted. */
.pc-group-header td { padding:0; background:var(--nano-inset); border-top:1px solid var(--nano-edge); }
.pc-group-toggle { display:flex; align-items:center; gap:.5rem; width:100%; padding:.4rem .6rem; background:transparent; border:0; color:inherit; font:inherit; font-weight:600; cursor:pointer; text-align:left; }
.pc-group-toggle:hover { background:var(--nano-hover); }
.pc-group-title { font-size:.9rem; }
/* A standalone button node + the modal it opens (e.g. a copy-pasteable prompt). */
.pc-buttonrow { margin:1rem 0; }
.pc-btn-ghost { background:transparent; color:var(--nano-text-muted); border:1px solid var(--nano-edge); }
.pc-btn-ghost:hover { color:var(--nano-text); border-color:var(--nano-accent); }
.pc-modal-overlay { position:fixed; inset:0; z-index:1000; display:flex; align-items:center; justify-content:center; padding:1.5rem; background:rgba(0,0,0,.55); }
.pc-modal { background:var(--nano-panel); border:1px solid var(--nano-edge-strong); border-radius:.6rem; padding:1.25rem 1.35rem; max-width:44rem; width:100%; max-height:85vh; overflow:auto; box-shadow:0 12px 40px rgba(0,0,0,.45); }
.pc-modal-title { font-size:1.15rem; margin:0 0 .5rem; }
.pc-modal-desc { color:var(--nano-text-muted); margin:0 0 .75rem; font-size:.9rem; white-space:pre-wrap; }
.pc-modal-code { white-space:pre-wrap; word-break:break-word; background:var(--nano-inset); border:1px solid var(--nano-edge); border-radius:.4rem; padding:.75rem; font:.82rem/1.5 ui-monospace,SFMono-Regular,Menlo,monospace; max-height:45vh; overflow:auto; margin:0 0 .85rem; color:var(--nano-text); }
.pc-modal-actions { display:flex; gap:.5rem; justify-content:flex-end; }
/* Multi-page navigation: a horizontal menu bar or a vertical side rail. */
.pc-layout { display:flex; gap:1.5rem; align-items:flex-start; }
.pc-rail-wrap { flex:0 0 12rem; position:sticky; top:1rem; align-self:flex-start; }
.pc-main-col { flex:1 1 auto; min-width:0; }
.pc-nav-title { font-weight:650; }
.pc-bar { display:flex; align-items:center; gap:.6rem; flex-wrap:wrap; border-bottom:1px solid var(--nano-edge); padding-bottom:.6rem; margin-bottom:1.25rem; }
/* Opt-in sticky bar: stays pinned to the viewport top while the page scrolls.
   The negative inline margin + matching padding lets its background span the
   body's 2rem inline padding so scrolled content never shows beside it, and a
   solid app-colored background hides content passing underneath. */
.pc-bar.pc-sticky { position:sticky; top:0; z-index:20; background:var(--nano-app); margin-inline:-2rem; padding-inline:2rem; padding-top:.6rem; }
.pc-bar .pc-nav-title { margin-right:.5rem; }
.pc-bar .pc-nav-items { display:flex; gap:.25rem; flex-wrap:wrap; }
.pc-rail { display:flex; flex-direction:column; gap:.5rem; }
.pc-rail .pc-nav-title { margin-bottom:.25rem; padding:0 .7rem; }
.pc-rail .pc-nav-items { display:flex; flex-direction:column; gap:.15rem; }
.pc-nav-link { display:flex; align-items:center; gap:.4rem; padding:.4rem .7rem; border-radius:.4rem; color:var(--nano-text-muted); text-decoration:none; font-size:.9rem; }
.pc-nav-link:hover { background:var(--nano-hover); color:var(--nano-text); }
.pc-nav-link.active { background:var(--nano-accent); color:var(--nano-on-accent); }
.pc-nav-icon { line-height:1; }
.pc-nav-empty { color:var(--nano-text-faint); font-size:.85rem; padding:.4rem .7rem; }
/* The per-row mobile "More" toggle (revealing mobile:{priority:"hidden"} columns)
   only exists for the card view — hidden on the desktop table, shown by the
   mobile @media below. Base-hidden here so a grid renders byte-for-byte
   unchanged on desktop even when it carries hidden-column hints. */
.pc-mcard-toggle { display:none; }
/* ── Urban responsive / mobile primitive (#268) ──────────────────────────
   Below MOBILE_MAX_WIDTH every app adapts to a phone with ZERO page-schema
   change. The dense dataGrid — the one primitive CSS alone can't reflow — flips
   from a wide <table> to a stacked card list purely from the per-cell
   'data-label' the renderer already stamps on (no JS branching): thead is
   hidden, each <tr> becomes a bordered card and each <td> a full-width
   label:value line whose label is the column header. The nav collapses to a
   thumb-reachable scrollable bottom bar, buttons/form actions go full-width
   single column, and text reflows on its own. The breakpoint is interpolated
   from the shared MOBILE_MAX_WIDTH constant so it can't drift from the runtime's
   matchMedia. */
@media (max-width:${MOBILE_MAX_WIDTH}) {
  body { padding:1rem; }
  /* dataGrid → card list. Once cells are display:block the fixed colgroup width
     is irrelevant, so a wide table stops overflowing the phone. table-layout is
     reset to auto so the block cells size to content. */
  table.pc-grid { table-layout:auto; }
  table.pc-grid, table.pc-grid tbody, table.pc-grid tr, table.pc-grid td { display:block; width:auto; }
  table.pc-grid colgroup, table.pc-grid thead { display:none; }
  table.pc-grid tr { border:1px solid var(--nano-edge); border-radius:.6rem; padding:.55rem .75rem; margin:.6rem 0; background:var(--nano-panel); }
  table.pc-grid td { border-bottom:0; padding:.15rem 0; display:flex; gap:.75rem; justify-content:space-between; align-items:baseline; }
  /* label:value — the column header (data-label) prefixes the value as a muted
     caption on the same line. Suppressed for the title, chip, actions and any
     colspan (group/empty/error) cells below. */
  table.pc-grid td[data-label]::before { content:attr(data-label); color:var(--nano-text-muted); font-size:.72rem; font-weight:600; text-transform:uppercase; letter-spacing:.03em; flex:0 0 auto; }
  /* The derived (or mobile:{priority:"primary"}-hinted) card title leads the
     card: larger, full width, no label caption. */
  table.pc-grid td.pc-mcell-primary { display:block; font-size:1rem; font-weight:650; padding-top:.15rem; }
  table.pc-grid td.pc-mcell-primary::before { content:none; }
  /* A badge column becomes a left-aligned status chip with no caption. */
  table.pc-grid td.pc-mcell-chip { justify-content:flex-start; }
  table.pc-grid td.pc-mcell-chip::before { content:none; }
  /* An empty badge cell (row value blank) still carries the chip class but has no
     child content; without this it renders as a blank flex row (padding/gap) that
     leaves a stray empty line in the card. Collapse those empty chip cells (#268). */
  table.pc-grid td.pc-mcell-chip:empty { display:none; }
  /* Low-value (mobile:{priority:"hidden"}) columns drop off the card until the
     row's "More" toggle opens them; on desktop they render as normal columns. */
  table.pc-grid td.pc-mcell-hidden { display:none; }
  table.pc-grid tr.pc-open td.pc-mcell-hidden { display:flex; }
  .pc-mcard-toggle { display:block; padding:.3rem 0 0; }
  .pc-mcard-toggle .pc-more { width:100%; margin-right:0; }
  /* Row actions stack full-width under the card body. */
  table.pc-grid td.pc-row-actions { display:flex; flex-wrap:wrap; gap:.4rem; text-align:left; padding-top:.45rem; white-space:normal; }
  table.pc-grid td.pc-row-actions::before { content:none; }
  table.pc-grid td.pc-row-actions .pc-btn { flex:1 1 auto; margin-right:0; }
  /* Group-header + empty/error rows span the full card width with no caption. */
  table.pc-grid td[colspan] { display:block; }
  table.pc-grid td[colspan]::before { content:none; }
  .pc-group-header td { padding:0; }
  /* Nav → horizontally-scrollable bar (bar) / inline stack (rail). The bar keeps
     its normal top-of-flow position and scrolls sideways when the pages overflow;
     an opt-in sticky bar stays pinned to the top via the desktop .pc-sticky rule
     (top:0). A rail drops its fixed side column and flows inline. */
  .pc-layout { display:block; }
  .pc-rail-wrap { position:static; flex-basis:auto; width:auto; margin:0 0 1rem; }
  .pc-rail .pc-nav-items { flex-direction:row; flex-wrap:wrap; }
  .pc-bar { flex-wrap:nowrap; overflow-x:auto; }
  .pc-bar.pc-sticky { position:sticky; }
  .pc-bar .pc-nav-items { flex-wrap:nowrap; }
  .pc-nav-link { white-space:nowrap; }
  .pc-tabs { overflow-x:auto; }
  /* Buttons / form actions go full-width single-column. */
  .pc-buttonrow .pc-btn, .pc-card .pc-btn { width:100%; }
  .pc-modal { max-width:100%; }
  .pc-modal-actions { flex-direction:column; }
  .pc-modal-actions .pc-btn { width:100%; }
}
`;

// The schema-driven browser renderer (ADR 0042 §3). Plain ES module string served at
// /app/runtime.js — it does NOT ship Craft.js (authoring is console-side only). It
// fetches the home page's page.json and renders text / actionForm / dataGrid nodes,
// wiring actionForm → /app/actions/start and dataGrid → /app/data (with a refresh).
const RENDERER_JS = String.raw`
const root = document.getElementById("page");
const HOME = root.dataset.home || "home";

// Single mobile breakpoint, interpolated from the same MOBILE_MAX_WIDTH constant
// as the shell CSS @media so the JS mode-switch and the pure-CSS card flip can
// never drift on where "narrow" begins (#268). Only Tier-2 (an optional
// page-level 'mobile' layout variant) needs this JS switch — the dataGrid card
// flip, nav collapse and button/form stacking are all pure CSS + data-label.
const MOBILE_MQ = window.matchMedia("(max-width:${MOBILE_MAX_WIDTH})");
function isNarrow() { return MOBILE_MQ.matches; }

// ── Multi-page routing (hash-based, reverse-proxy safe) ──────────────────
// Pages are selected by the URL fragment (#/<page>) so navigation never hits
// the server and works identically at the origin root and under the Nano
// console's /console/app-view/<name>/ path-prefixed proxy (the hash is never
// sent upstream). An empty/invalid hash falls back to the home page. Only a
// safe id charset is accepted so the fragment can't smuggle a path/URL.
const PAGE_ID = /^[A-Za-z0-9_-]+$/;
function safePageId(value) {
  return typeof value === "string" && PAGE_ID.test(value);
}
// A route is #/<page> or #/<page>/<url-encoded-param>. We split on the FIRST
// "/" *before* decoding, so a param that itself contains encoded slashes or
// hashes (e.g. a plan_key "owner/repo#123" carried as "owner%2Frepo%23123")
// survives intact instead of the inner "%2F" being decoded into a second
// segment. The page segment is still restricted to the safe id charset; the
// param is opaque free text (bound only as a whitelisted '?' SQL value, or
// interpolated as DOM text — never as HTML/markup).
function parseRoute() {
  const raw = (location.hash || "").replace(/^#\/?/, "");
  const slash = raw.indexOf("/");
  const pageRaw = slash >= 0 ? raw.slice(0, slash) : raw;
  const paramRaw = slash >= 0 ? raw.slice(slash + 1) : "";
  let page = HOME, param = "", pageOk = false;
  try { const p = decodeURIComponent(pageRaw); if (safePageId(p)) { page = p; pageOk = true; } } catch (e) { /* keep HOME */ }
  // Only carry the param when the page segment resolved to a real (safe-id) page.
  // A malformed/unknown page like #/not-a-page/x falls back to HOME and must NOT
  // inherit x, or that stray param would silently scope every eqParam grid and
  // {{param}} on the home page to an entity the user never selected.
  if (pageOk) { try { param = paramRaw ? decodeURIComponent(paramRaw) : ""; } catch (e) { param = ""; } }
  return { page, param };
}
function currentPage() { return parseRoute().page; }
let CURRENT = currentPage();
// The current route param (the "/<param>" tail, or "" when absent). Exposed to a
// page's datasource filters (a filter with { eqParam: true } binds its value to
// this) and to {{param}} text interpolation, so one page template can scope
// every section to a selected entity (e.g. an epic's plan_key).
let PARAM = parseRoute().param;
// Monotonic render token. renderPage() is async and fires from both hashchange
// and the matchMedia viewport-crossing handler, so two invocations can overlap
// and their fetches resolve out of order. Each render captures the token it
// bumped to; after its await it only touches the DOM if it is still the latest,
// so a stale navigation/viewport render can't overwrite a newer one.
let renderSeq = 0;

// Per-render teardown. Each dataGrid registers its poll interval + pc:refresh
// listener here; navigating to another page runs every disposer before the new
// page renders, so a switched-away grid stops polling (otherwise every visited
// page would leave a live setInterval fetching forever).
const disposers = [];
function teardown() {
  while (disposers.length) {
    try { disposers.pop()(); } catch (e) { /* best-effort cleanup */ }
  }
}

// Monotonic counter for per-modal element ids. aria-labelledby needs a unique
// title id: a fixed id would clash if the page already contains that id, and
// mis-associate the label for assistive tech.
let modalSeq = 0;
// At most one modal is open at a time. A double-click (or two rapid button
// clicks) would otherwise stack multiple overlays + document-level keydown
// listeners; this guard keeps a single dialog + handler live.
let modalOpen = false;

// Theme bridge for the Nano console embed. The app runs in a sandboxed,
// same-origin iframe, so the console's --nano-* custom properties and its
// data-appearance never cascade in. Instead the console postMessages its
// resolved tokens; we lay them onto this document's :root and mirror the
// appearance. Standalone (no console parent) nothing is posted, so the CSS
// defaults stand. We announce readiness so the console can push the theme even
// if its first message raced our listener install.
function applyTheme(msg) {
  if (!msg || msg.type !== "nano-theme") return;
  const el = document.documentElement;
  if (msg.appearance === "light" || msg.appearance === "dark") el.dataset.appearance = msg.appearance;
  const vars = msg.vars;
  if (vars && typeof vars === "object") {
    for (const [k, v] of Object.entries(vars)) {
      // Only accept the shared token namespace; ignore anything else.
      if (typeof k === "string" && k.startsWith("--nano-") && typeof v === "string") {
        el.style.setProperty(k, v);
      }
    }
  }
}
// True when this app runs inside the Nano console's same-origin iframe (vs a
// standalone CLI run). Gates the theme bridge below AND in-host link navigation:
// embedded, a processExplorer link routes the console in place; standalone, the
// link keeps its native new-window behavior. The same-origin probe matters: a
// cross-origin framer is also window.parent, but postMessage to our own origin
// would never reach it and hostNavigate would still preventDefault the link —
// so a cross-origin embed must fall through to the native _blank anchor. Reading
// parent.location.origin throws under the same-origin policy for a cross-origin
// parent, so the try/catch is the origin gate.
const NANO_EMBEDDED = (() => {
  if (!window.parent || window.parent === window) return false;
  try {
    return window.parent.location.origin === window.location.origin;
  } catch {
    return false;
  }
})();

// Ask the framing console to navigate in-host. Returns true when a message was
// posted (embedded) so the caller can suppress the native anchor; false
// standalone so it falls through to the new-window <a>. The payload is
// structured (target + params), never a raw href — the console constructs its
// own route, so app/row data can't smuggle a path or scheme across the boundary.
function hostNavigate(target, params) {
  if (!NANO_EMBEDDED) return false;
  window.parent.postMessage({ type: "nano-navigate", target: target, params: params }, window.location.origin);
  return true;
}

if (NANO_EMBEDDED) {
  window.addEventListener("message", (ev) => {
    // Same-origin proxy (posture A): only trust a message from the framing
    // parent AND from our own origin. ev.source alone is insufficient — a
    // cross-origin page that frames a standalone run becomes window.parent, so
    // an origin check is what actually pins the trust boundary.
    if (ev.origin === window.location.origin && ev.source === window.parent) applyTheme(ev.data);
  });
  window.parent.postMessage({ type: "nano-app-ready" }, window.location.origin);
}

// Resolve every app endpoint against where THIS module was actually served from,
// so absolute-looking "/app/…" paths work both at the origin root (direct run,
// e.g. the CLI on :3000) and under a path-prefixed reverse proxy (the Nano
// console embeds the app at /console/app-view/<name>/). "../" drops the trailing
// "app/runtime.js" to land on the app's mount root (always ends in "/").
const APP_BASE = new URL("../", import.meta.url);
function apiUrl(u) {
  // Rebase root-absolute app paths ("/app/…") onto the mount root. Leave a
  // protocol-relative ("//host/…") or otherwise non-root-relative string alone —
  // only a single leading slash denotes an app path we own.
  return typeof u === "string" && u.startsWith("/") && !u.startsWith("//")
    ? new URL(u.slice(1), APP_BASE).toString()
    : u;
}

async function getJSON(url, opts) {
  const r = await fetch(apiUrl(url), opts);
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(body.error || ("HTTP " + r.status));
  return body;
}

// ── route-driven actions ────────────────────────────────────────────────
// Every page action is a single primitive: POST (or any method) the resolved
// body to an app route path. There are NO bespoke action kinds — a form/row
// reaches process start, message publish, cancel, an OpenAPI operation, a
// webhook, or any app route uniformly by naming its path. Path + body may
// interpolate the current form fields and (for grid rows/detail forms) the row
// via {{form.KEY}} / {{row.KEY}} tokens; the whole-string tokens {{form}} and
// {{row}} splice the object itself (type-preserving), so a body of
// "variables": "{{form}}" sends the form object as the variable map.
function lookupToken(path, ctx) {
  const segs = String(path).split(".");
  const head = segs[0];
  let base = head === "form" ? (ctx.form || {}) : head === "row" ? (ctx.row || {}) : undefined;
  for (let i = 1; i < segs.length; i++) base = base == null ? undefined : base[segs[i]];
  return base;
}
function resolveTemplate(node, ctx) {
  if (typeof node === "string") {
    const whole = node.match(/^\{\{\s*([\w.]+)\s*\}\}$/);
    if (whole) return lookupToken(whole[1], ctx);
    return node.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, k) => {
      const v = lookupToken(k, ctx);
      return v == null ? "" : String(v);
    });
  }
  if (Array.isArray(node)) return node.map((n) => resolveTemplate(n, ctx));
  if (node && typeof node === "object") {
    // Null-proto target so a template key like "__proto__" can't trigger prototype
    // mutation (prototype-pollution class) when copied into the resolved object.
    const out = Object.create(null);
    for (const [k, v] of Object.entries(node)) out[k] = resolveTemplate(v, ctx);
    return out;
  }
  return node;
}
async function runRoute(action, ctx) {
  if (!action || typeof action.path !== "string" || action.path === "") {
    throw new Error("This action has no route configured (action.path is missing or blank)");
  }
  const path = action.path.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, k) => {
    const v = lookupToken(k, ctx);
    return v == null ? "" : encodeURIComponent(String(v));
  });
  const method = String(action.method || "POST").toUpperCase();
  let body;
  if (action.body !== undefined) body = resolveTemplate(action.body, ctx);
  else if (ctx.form) body = { variables: ctx.form };
  else body = {};
  const opts = { method, headers: { "content-type": "application/json" } };
  if (method !== "GET" && method !== "HEAD") opts.body = JSON.stringify(body);
  return getJSON(path, opts);
}

function el(tag, attrs = {}, ...kids) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") n.className = v;
    else if (k.startsWith("on") && typeof v === "function") n.addEventListener(k.slice(2), v);
    else if (v != null) n.setAttribute(k, v);
  }
  for (const kid of kids) n.append(kid);
  return n;
}

// Interpolate the {{param}} token in a schema-supplied string with the current
// route param. The result is only ever set as DOM text (textContent), so the
// substituted value cannot inject markup. Other tokens are left untouched.
// A function replacement inserts PARAM literally; a plain string replacement would
// treat replacement patterns inside PARAM (an id like the dollar-one token) as
// special and render the wrong text.
function interpParam(s) {
  return typeof s === "string" ? s.replace(/\{\{param\}\}/g, () => PARAM) : s;
}

// Interpolate {{field}} tokens in a column's per-cell template with values from
// the row, coercing each to a string (null/undefined → ""). Like interpParam the
// result is only ever set as DOM text (textContent via el()), so a substituted
// row value cannot inject markup or attributes. A function replacement inserts
// each value literally, so a "$"-bearing value can't be reinterpreted as a
// replacement pattern. Unknown tokens (no such field) render empty rather than
// throwing, matching interpParam. This is a dumb text formatter: no expressions,
// arithmetic, or conditionals — just field splicing. Only the row's own
// fields resolve (own-property gate, enumerable or not): an inherited
// Object.prototype key (toString, constructor, …) counts as unknown and
// renders "", so a token can't pick up prototype cruft instead of blank.
function interpTemplate(tpl, row) {
  return typeof tpl === "string"
    ? tpl.replace(/\{\{([^{}]+)\}\}/g, (_m, name) => {
        const key = name.trim();
        const v = Object.prototype.hasOwnProperty.call(row, key) ? row[key] : null;
        return v == null ? "" : String(v);
      })
    : tpl;
}
function renderText(node) {
  const v = node.props.variant;
  const cls = v === "heading" ? "pc-heading" : v === "sub" ? "pc-sub" : "pc-body";
  return el(v === "heading" ? "h1" : "p", { class: cls }, interpParam(node.props.text) || "");
}

// Copy text to the clipboard, resiliently. The async Clipboard API is tried
// first, but it can reject inside a sandboxed console iframe (no clipboard-write
// permission) — so fall back to a hidden <textarea> + execCommand("copy"), which
// works under a user gesture with only allow-scripts. Returns whether a copy
// succeeded so the caller can nudge the user to ⌘/Ctrl+C when both paths fail.
async function copyToClipboard(text) {
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch (_e) { /* fall through to the execCommand path */ }
  const ta = document.createElement("textarea");
  try {
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.top = "-1000px";
    ta.style.opacity = "0";
    document.body.append(ta);
    ta.select();
    return document.execCommand("copy");
  } catch (_e) { return false; }
  // Always remove the hidden textarea, even if select()/execCommand threw, so a
  // failed copy never leaves a detached node accreting in <body> on retry.
  finally { ta.remove(); }
}

// Rebase the sole {{appBase}} token in author-supplied copy text onto the app's
// absolute mount root (always ends in "/"), so a prompt like
// "read {{appBase}}app/api/agent" resolves to a URL an external agent can fetch —
// the console proxy path when embedded, the app origin when standalone. No other
// interpolation happens: copy text is otherwise emitted verbatim.
function resolveCopyText(text) {
  return typeof text === "string" ? text.split("{{appBase}}").join(APP_BASE.toString()) : "";
}

// Open a lightweight modal appended to <body>. Closes on the ✕/Close button, a
// backdrop click, Escape, or a page switch; the keydown listener is removed on
// close so it never leaks, and close() is registered with teardown() so
// navigating away (hashchange → renderPage → teardown) tears down any open modal
// instead of leaving a stale overlay + document-level listener alive. When it
// carries copyText it renders a scrollable code block plus a Copy button (see
// copyToClipboard for the sandbox-safe fallback).
function openModal(m) {
  // Only one modal at a time — drop a second (e.g. double-click) open so we
  // never stack overlays or register duplicate document-level keydown handlers.
  if (modalOpen) return;
  modalOpen = true;
  const overlay = el("div", { class: "pc-modal-overlay" });
  // role="dialog" + aria-modal need an accessible name: label by the visible
  // title when present, else fall back to a generic aria-label so screen readers
  // don't announce an unnamed dialog. The title id is unique per instance so it
  // can't collide with a pre-existing page id.
  const titleId = m.title ? "pc-modal-title-" + (++modalSeq) : null;
  const dialog = el("div", titleId
    ? { class: "pc-modal", role: "dialog", "aria-modal": "true", "aria-labelledby": titleId }
    : { class: "pc-modal", role: "dialog", "aria-modal": "true", "aria-label": "Dialog" });
  if (m.title) dialog.append(el("h2", { class: "pc-modal-title", id: titleId }, m.title));
  if (m.description) dialog.append(el("p", { class: "pc-modal-desc" }, m.description));
  const copyText = resolveCopyText(m.copyText);
  if (copyText) dialog.append(el("pre", { class: "pc-modal-code" }, copyText));
  const actions = el("div", { class: "pc-modal-actions" });
  // Remember what had focus so we can restore it on close — a keyboard/screen
  // reader user returns to where they were instead of being dumped at <body>.
  const prevFocus = document.activeElement;
  let closed = false;
  function close() {
    if (closed) return;
    closed = true;
    modalOpen = false;
    document.removeEventListener("keydown", onKey);
    overlay.remove();
    // A manual close (button / Escape / backdrop) never pops the disposers
    // stack, so drop our own entry here — otherwise repeated open/close cycles
    // accrete dead close() closures until the next page navigation runs teardown.
    const i = disposers.indexOf(close);
    if (i !== -1) disposers.splice(i, 1);
    if (prevFocus && typeof prevFocus.focus === "function") prevFocus.focus();
  }
  // Focusable descendants of the dialog, in DOM order, for the Tab focus trap.
  function focusables() {
    return Array.prototype.slice.call(dialog.querySelectorAll(
      'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
    )).filter((n) => !n.disabled);
  }
  function onKey(ev) {
    if (ev.key === "Escape") { close(); return; }
    if (ev.key !== "Tab") return;
    // Trap Tab within the dialog so focus can't slip behind the overlay onto the
    // inert page underneath — that would break aria-modal semantics.
    const f = focusables();
    if (!f.length) return;
    const first = f[0];
    const last = f[f.length - 1];
    if (ev.shiftKey && document.activeElement === first) { ev.preventDefault(); last.focus(); }
    else if (!ev.shiftKey && document.activeElement === last) { ev.preventDefault(); first.focus(); }
  }
  if (copyText) {
    const label = m.copyLabel || "Copy";
    const copyBtn = el("button", { class: "pc-btn pc-btn-sm", type: "button" }, label);
    copyBtn.addEventListener("click", async () => {
      const ok = await copyToClipboard(copyText);
      copyBtn.textContent = ok ? "Copied ✓" : "Press ⌘/Ctrl+C";
      setTimeout(() => { copyBtn.textContent = label; }, 2200);
    });
    actions.append(copyBtn);
  }
  const closeBtn = el("button", { class: "pc-btn pc-btn-sm pc-btn-ghost", type: "button" }, m.closeLabel || "Close");
  closeBtn.addEventListener("click", close);
  actions.append(closeBtn);
  dialog.append(actions);
  overlay.append(dialog);
  // A click on the backdrop (never the dialog itself) dismisses.
  overlay.addEventListener("click", (ev) => { if (ev.target === overlay) close(); });
  document.addEventListener("keydown", onKey);
  document.body.append(overlay);
  // A page switch runs teardown() before the next render — dispose the modal
  // there too so navigating away never leaves a stale overlay + keydown listener.
  disposers.push(close);
  closeBtn.focus();
}

// A standalone button node. Clicking it opens props.modal — used e.g. to surface
// a copy-pasteable "point your agent here" prompt. props.variant === "ghost"
// renders the muted outline style. A button without a modal is inert.
function renderButton(node) {
  const p = node.props || {};
  const btn = el(
    "button",
    { class: "pc-btn" + (p.variant === "ghost" ? " pc-btn-ghost" : ""), type: "button" },
    p.label || "Open",
  );
  const m = p.modal && typeof p.modal === "object" ? p.modal : null;
  if (m) btn.addEventListener("click", () => openModal(m));
  return el("div", { class: "pc-buttonrow" }, btn);
}

// A grid td cell with three column-declared rendering modes, checked in order:
//   1. badge — a compact status indicator, gated on a non-empty field value
//      (see the detailed note at the check below).
//   2. linkField — the cell text becomes a link to the URL held in that other
//      field. Only http(s) hrefs are linked (a javascript:/other-scheme URL
//      smuggled through row data falls back to plain text).
//   3. link: { kind: "processExplorer", keyField } — a structured, engine-aware
//      link: the cell text links to the Nano console's explorer view for the
//      process instance whose key is held in the row's keyField. The console
//      path is constructed HERE (never taken from row data) and the key is
//      URL-encoded, so row data can't smuggle a path or scheme; only a
//      non-empty key (after trimming surrounding whitespace) produces a link.
//      Unknown link kinds fall back to plain text so an unrecognised schema
//      can't render a broken anchor.
// The external linkField anchor always opens in a new tab (rel=noopener
// noreferrer). The processExplorer anchor does too when the app runs
// standalone, but when embedded in the console a plain click instead routes the
// host's own explorer view in place via the nano-navigate postMessage bridge
// (a modified/middle click keeps the new-tab behavior). Shared by the top-level
// grid and child grids.
//
// Cell TEXT (the 'text' local below): the visible string a cell renders. By
// default it is the column's single 'field' value, but an optional
// 'col.template' string wins: its {{field}} tokens are spliced from the row
// (interpTemplate) into DOM text. A template lets one cell combine several
// fields / add surrounding text (e.g. "{{current_wave}}/{{wave_count}}")
// without denormalising a display column into the datasource. The template
// drives the rendered text for the plain, linkField and link
// (page/processExplorer) paths — a link's href still comes from its own
// keyField/linkField, never the template. The 'badge' presence gate and its
// tooltip stay keyed to the raw 'field' value (a badge shows a fixed glyph, not
// the field text), so a template does not change badge behaviour. Sorting,
// groupBy and orderBy also key off real fields, never the rendered template.
//
// Two-line identity + one-line clamp (additive, opt-in, backward-compatible):
// a column may also declare 'subtitleField'/'subtitleTemplate' to render a muted
// second line under the primary text (the identity key beneath a title, GitHub/
// Linear style) and 'truncate: true' to clamp each line to one row with an
// ellipsis and a full-text title/aria-label tooltip (pairs with a per-column
// width/weight — see buildColgroup — to give the clip a bounded column). The
// subtitle is ALWAYS plain DOM text, never an href source. With none of these
// set the cell is a single inline node exactly as before (see cellTd).
// Build an in-app hash route to another page, scoped to a row key: #/<page>/<key>.
// The page id is validated against the safe-id charset and the key must be
// non-empty (after trimming); either failing yields "" (no link). The key is
// URL-encoded into the route's param tail, which parseRoute() decodes back
// verbatim, so row data can't smuggle a path or scheme. SINGLE source of truth
// for the page-link href so the grid's link cell and the pipeline locus link
// (issue #265) can't drift on how the route is built.
function pageHashHref(page, key) {
  const keyStr = key == null ? "" : String(key).trim();
  if (!safePageId(page) || keyStr === "") return "";
  return "#/" + encodeURIComponent(page) + "/" + encodeURIComponent(keyStr);
}

// Coerce a not-in-path value (issue #265) into a Set of stage keys. Accepts an
// array of keys or a comma/whitespace-separated string; null/undefined → empty
// set. Used to mark the stages a given row skips (dashed/omitted).
function toStageSet(v) {
  if (Array.isArray(v)) return new Set(v.map((s) => String(s)));
  if (v == null) return new Set();
  return new Set(String(v).split(/[\s,]+/).filter((s) => s !== ""));
}

function gridCell(col, row, role) {
  // Mobile card attributes stamped on every td so a dataGrid can flip to a
  // stacked card list below the breakpoint with no JS branching (#268):
  // 'data-label' drives the pure-CSS label:value line (the column header, or a
  // mobile:{label} override), and the role class picks the card region (title /
  // status chip / secondary field / hidden). The role is derived by convention
  // (classifyColumns) and refinable per-column via col.mobile.priority.
  const mrole = role || "secondary";
  const mlabel =
    col.mobile && typeof col.mobile.label === "string"
      ? col.mobile.label
      : col.header != null
        ? String(col.header)
        : String(col.field == null ? "" : col.field);
  const mob = { class: "pc-mcell pc-mcell-" + mrole, "data-label": mlabel };
  // Raw single-field value: drives the badge presence gate + tooltip and any
  // field-derived defaults. Kept separate from the (possibly templated) display
  // text so a template never re-lights or blanks a badge.
  const rawText = row[col.field] == null ? "" : String(row[col.field]);
  // Visible text: a col.template (interpolated from the row) wins over the
  // raw field value, else the field value is shown verbatim.
  const text = typeof col.template === "string" ? interpTemplate(col.template, row) : rawText;
  // 1. badge — a compact status indicator. When the row's field value is
  //    non-empty (truthy after trimming) render a small circular badge (e.g. a
  //    red "1" dot flagging an incident) whose tooltip is the full field text;
  //    when empty the cell stays blank so the column is unobtrusive until it
  //    matters. tone (danger|warn|ok|info, default danger) picks the color and
  //    label the glyph inside (default "1"). Label/tone come from the app
  //    schema (trusted); the tooltip is row data set via title/textContent
  //    (DOM-escaped by the platform, so no HTML/attribute injection). The full
  //    field text is also mirrored into aria-label so assistive tech announces
  //    the incident/status text (the visible "1" glyph alone is not meaningful).
  if (col.badge) {
    // Even when blank, stamp data-label (the "every td carries data-label"
    // invariant): the cell still collapses on mobile via the pc-mcell-chip:empty
    // rule (attributes don't defeat :empty), so this keeps empty and non-empty
    // badge cells consistent without re-lighting the label.
    if (rawText.trim() === "") return el("td", { class: "pc-mcell pc-mcell-chip", "data-label": mlabel });
    const t = col.badge.tone;
    const tone = t === "warn" || t === "ok" || t === "info" ? t : "danger";
    const label = col.badge.label == null ? "1" : String(col.badge.label);
    return el(
      "td",
      mob,
      el("span", { class: "pc-badge pc-badge-" + tone, title: rawText, "aria-label": rawText }, label),
    );
  }
  // Optional second line (col.subtitleField / subtitleTemplate): a muted key
  // under the primary title. subtitleTemplate wins (interpolated from the row);
  // else the raw subtitleField value. Absent/null → "" → no extra line. It is
  // ALWAYS plain DOM text (see cellTd), never a link/href source — a subtitle
  // cannot smuggle a scheme or path, only linkField/keyField drive hrefs.
  const subRaw =
    col.subtitleField != null && row[col.subtitleField] != null ? String(row[col.subtitleField]) : "";
  const subText = typeof col.subtitleTemplate === "string" ? interpTemplate(col.subtitleTemplate, row) : subRaw;
  const truncate = col.truncate === true;
  // pipeline (issue #265): a dataGrid column declaring kind:"pipeline" renders
  // the ordered stages as a per-row horizontal progress track (upstream-filled
  // → active-lit → downstream-ghosted, not-in-path dashed). It owns the whole
  // cell, so it returns here before the link chain below. Gated purely on the
  // discriminator so every existing column mode is untouched when it is absent;
  // unknown/missing pipeline config degrades to plain cell text (never throws),
  // exactly as an unrecognised link.kind falls back today.
  if (col.kind === "pipeline") return pipelineCell(col, row, text, subText, truncate, mob);
  // Primary inline content: an anchor for a valid link mode (checked in the same
  // badge < linkField < link(page) < link(processExplorer) precedence as before),
  // else the plain display text. Each link mode only claims the cell while
  // 'primary' is still the bare text — an invalid href falls through to the next
  // mode and ultimately to plain text, exactly as the early-return chain did.
  let primary = text;
  if (col.linkField) {
    const href = row[col.linkField] == null ? "" : String(row[col.linkField]);
    if (text !== "" && /^https?:\/\//i.test(href)) {
      primary = el("a", { class: "pc-link", href, target: "_blank", rel: "noopener noreferrer" }, text);
    }
  }
  if (primary === text && col.link && col.link.kind === "page" && col.link.page && col.link.keyField) {
    // An in-app link to another page, scoped to this row: #/<page>/<key>. Built
    // via pageHashHref (the single source of truth for the route): the page id is
    // validated against the safe-id charset and the key must be non-empty, so a
    // blank/keyless cell stays plain text. Navigation is a pure hash change
    // (no new tab, no server hit) — the SPA router re-renders in place.
    const href = pageHashHref(col.link.page, row[col.link.keyField]);
    if (text !== "" && href !== "") {
      primary = el("a", { class: "pc-link", href }, text);
    }
  }
  if (primary === text && col.link && col.link.kind === "processExplorer" && col.link.keyField) {
    const key = row[col.link.keyField];
    const keyStr = key == null ? "" : String(key).trim();
    if (text !== "" && keyStr !== "") {
      const href = "/console/explorer?instance=" + encodeURIComponent(keyStr);
      primary = el("a", {
        class: "pc-link",
        href,
        target: "_blank",
        rel: "noopener noreferrer",
        // Embedded in the console a plain primary click routes the host's
        // explorer in place (via the nano-navigate bridge) instead of opening
        // a new window. A non-primary button (middle/right = new-tab/context
        // intent), a modified click (⌘/ctrl/shift/alt = new-tab intent) and
        // any standalone run fall through to the native anchor above.
        onclick: (ev) => {
          if (ev.button !== 0) return;
          if (ev.metaKey || ev.ctrlKey || ev.shiftKey || ev.altKey) return;
          if (hostNavigate("processExplorer", { instance: keyStr })) ev.preventDefault();
        },
      }, text);
    }
  }
  return cellTd(primary, text, subText, truncate, mob);
}

// Compose a grid <td> from its primary inline content (a string or an anchor),
// an optional muted subtitle line, and optional one-line truncation. With
// NEITHER a subtitle nor truncation the cell is exactly the single inline node
// as before, so existing grids render byte-for-byte unchanged (backward
// compatible). When either is set the content is wrapped in a .pc-cell-main
// line and, if a subtitle is present, a .pc-cell-sub line beneath it. truncate
// adds .pc-truncate (nowrap + ellipsis) to each line and mirrors the full text
// into title=/aria-label so the clipped value is still recoverable on hover and
// to assistive tech. When the primary is an element (a link cell's <a>), title=/
// aria-label= are ALSO mirrored onto it: HTML does not inherit those to
// descendants, so hovering the link text or naming the anchor for assistive tech
// would otherwise miss the full value the wrapper carries. The subtitle is set as
// DOM text only — never an href. 'tdAttrs' (the mobile card attrs: data-label +
// role class, see gridCell) is applied to whichever <td> shape is returned so
// the CSS-only card flip labels every cell identically (#268).
function cellTd(primary, primaryText, subText, truncate, tdAttrs) {
  const td = tdAttrs || {};
  if (subText === "" && !truncate) return el("td", td, primary);
  const mainAttrs = { class: "pc-cell-main" + (truncate ? " pc-truncate" : "") };
  if (truncate && primaryText !== "") {
    mainAttrs.title = primaryText; mainAttrs["aria-label"] = primaryText;
    if (primary && typeof primary.setAttribute === "function") {
      primary.setAttribute("title", primaryText); primary.setAttribute("aria-label", primaryText);
    }
  }
  const main = el("div", mainAttrs, primary);
  if (subText === "") return el("td", td, main);
  const subAttrs = { class: "pc-cell-sub" + (truncate ? " pc-truncate" : "") };
  if (truncate) { subAttrs.title = subText; subAttrs["aria-label"] = subText; }
  return el("td", td, main, el("div", subAttrs, subText));
}

// Classify each grid column into a mobile-card region so a dataGrid flips to a
// stacked card list below the breakpoint with ZERO page-schema change (#268).
// Convention (Tier 0): the first non-badge column is the card title (primary), a
// badge column is a status chip, and everything else is a secondary label:value
// row. Tier 1 refines it — a column may carry mobile:{priority:"primary" |
// "secondary" | "hidden"}: an explicit "primary" suppresses the auto title pick
// so a later column can lead the card, "hidden" drops the column off the card
// (behind the row's "More" toggle), and "secondary" forces a plain field row.
function classifyColumns(cols) {
  const list = cols || [];
  const explicitPrimary = list.some((c) => c && c.mobile && c.mobile.priority === "primary");
  let titleTaken = explicitPrimary;
  return list.map((col) => {
    const pr = col && col.mobile ? col.mobile.priority : null;
    if (pr === "primary") return "primary";
    if (pr === "secondary") return "secondary";
    if (pr === "hidden") return "hidden";
    if (col && col.badge) return "chip";
    if (!titleTaken) { titleTaken = true; return "primary"; }
    return "secondary";
  });
}

// Per-row mobile "More" toggle cell: reveals the mobile:{priority:"hidden"} columns
// a narrow viewport drops off the card. The cell is base-hidden (display:none) so
// the desktop table is byte-for-byte unchanged; clicking flips .pc-open on the row,
// swaps the label, and updates aria-expanded so the reveal state is exposed to
// assistive tech (#268). One implementation shared by the top-level grid and child
// grids so the affordance — and its accessibility — can't drift between them.
function mobileMoreCell(tr) {
  const moreBtn = el("button",
    { class: "pc-btn pc-btn-sm pc-btn-ghost pc-more", type: "button", "aria-expanded": "false" }, "More");
  moreBtn.addEventListener("click", () => {
    const open = tr.classList.toggle("pc-open");
    moreBtn.textContent = open ? "Less" : "More";
    moreBtn.setAttribute("aria-expanded", String(open));
  });
  return el("td", { class: "pc-mcard-toggle" }, moreBtn);
}

// Pipeline / stepper cell (issue #265) — a dataGrid column with kind:"pipeline"
// renders a per-row, multi-stage horizontal progress track. It is RENDER-ONLY:
// stage state is read straight from the row fields the app supplies; no
// app-specific stage derivation lives here. Column config (all fields are the
// NAMES of row fields, mirroring the issue sketch):
//   { kind:"pipeline",
//     stages:[{key,label},...],   // ordered stage definitions (required)
//     activeField:"stage",        // row field → the current stage's key
//     stateField:"stage_state",   // row field → ok | active | failed | blocked
//     badgeField:"attention",     // optional row field → per-stage badge text
//     notInPathField:"skipped",   // optional row field → stages this row skips
//     notInPath:["converging"],   // static fallback used only when no field given
//     locus:{ field:"pr_key", stage?:"<key>",
//             link:{ kind:"page", page:"home" } } }  // optional out-link
// Rendering: stages BEFORE the active one are filled/completed, the active stage
// is lit (its treatment driven by stateField — success ✓ vs failure ✕ vs blocked
// ⊘ are made unmistakably distinct), in-path stages AFTER it are ghosted, and any
// stage in the row's not-in-path set is dashed. Reuses .pc-badge*/.pc-link and
// the shared pageHashHref route builder — no parallel implementations. Unknown or
// missing config (no stages array) degrades gracefully to plain cell text.
function pipelineCell(col, row, text, subText, truncate, tdAttrs) {
  const stages = Array.isArray(col.stages) ? col.stages : [];
  // Graceful fallback: an unrecognised/empty pipeline config renders plain text,
  // exactly like an unknown link.kind — never throws.
  if (stages.length === 0) return cellTd(text, text, subText, truncate, tdAttrs);
  // The current stage's key, matched against stages[].key to find the active index.
  const activeKey = col.activeField != null && row[col.activeField] != null ? String(row[col.activeField]) : "";
  let activeIdx = -1;
  for (let i = 0; i < stages.length; i++) if (String(stages[i].key) === activeKey) activeIdx = i;
  // The active stage's state drives its lit/failed/blocked treatment. Anything
  // outside the allow-list (or absent) is treated as an in-progress "active".
  const stRaw = col.stateField != null && row[col.stateField] != null ? String(row[col.stateField]) : "";
  const state = stRaw === "ok" || stRaw === "failed" || stRaw === "blocked" ? stRaw : "active";
  // Not-in-path (skipped) stages: driven per-row from notInPathField when given,
  // else the static notInPath config (per the issue: "per row, from a field").
  const skip =
    col.notInPathField != null && row[col.notInPathField] != null
      ? toStageSet(row[col.notInPathField])
      : toStageSet(col.notInPath);
  // Optional per-stage badge (escalation/attention → warn, blocked/failure →
  // danger), reusing .pc-badge tone classes — no new badge styles.
  const badgeText = col.badgeField != null && row[col.badgeField] != null ? String(row[col.badgeField]) : "";
  const badgeTone = state === "failed" || state === "blocked" ? "danger" : "warn";
  // Optional locus out-link: the relevant stage (default the active one, or
  // locus.stage by key) becomes an in-app page link when the row's locus key is
  // non-empty. Href comes from the shared pageHashHref builder (safePageId guard,
  // encodeURIComponent) — a blank key yields "" so the stage stays plain.
  const locus = col.locus;
  const locusKey = locus && locus.field != null && row[locus.field] != null ? String(row[locus.field]) : "";
  const locusHref =
    locus && locus.link && locus.link.kind === "page" && locus.link.page ? pageHashHref(locus.link.page, locusKey) : "";
  const track = el("div", {
    class: "pc-pipe",
    role: "list",
    "aria-label": "Progress" + (activeIdx >= 0 ? ": " + labelOf(stages[activeIdx]) : ""),
  });
  for (let i = 0; i < stages.length; i++) {
    const s = stages[i];
    const skipped = skip.has(String(s.key));
    // Connector between adjacent stages; filled up to and including the active stage.
    if (i > 0) {
      const filled = activeIdx >= 0 && i <= activeIdx && !skipped ? " filled" : "";
      track.append(el("span", { class: "pc-pipe-conn" + filled, "aria-hidden": "true" }));
    }
    let cls;
    let word;
    let glyph = "";
    let current = false;
    if (skipped) {
      cls = "pc-pipe-skip"; word = "skipped";
    } else if (activeIdx >= 0 && i < activeIdx) {
      cls = "pc-pipe-done"; word = "completed";
    } else if (i === activeIdx) {
      current = true;
      if (state === "failed") { cls = "pc-pipe-active pc-pipe-failed"; word = "failed"; glyph = "\u2715"; }
      else if (state === "blocked") { cls = "pc-pipe-active pc-pipe-blocked"; word = "blocked"; glyph = "\u2298"; }
      else if (state === "ok") { cls = "pc-pipe-active pc-pipe-ok"; word = "done"; glyph = "\u2713"; }
      else { cls = "pc-pipe-active"; word = "current"; }
    } else {
      cls = "pc-pipe-upcoming"; word = "upcoming";
    }
    const isLocus = locusHref !== "" && (locus.stage != null ? String(s.key) === String(locus.stage) : i === activeIdx);
    const label = labelOf(s);
    const labelNode = isLocus
      ? el("a", { class: "pc-link pc-pipe-label", href: locusHref }, label)
      : el("span", { class: "pc-pipe-label" }, label);
    const attrs = { class: "pc-pipe-stage " + cls, role: "listitem", "aria-label": label + " \u2014 " + word };
    if (current) attrs["aria-current"] = "step";
    const stage = el("span", attrs, labelNode);
    if (glyph !== "") stage.append(el("span", { class: "pc-pipe-mark", "aria-hidden": "true" }, glyph));
    if (current && badgeText.trim() !== "") {
      stage.append(el("span", { class: "pc-badge pc-badge-" + badgeTone, title: badgeText, "aria-label": badgeText }, badgeText));
    }
    track.append(stage);
  }
  // The mobile card attrs (data-label + role class, #268) stamped by gridCell are
  // merged onto the pipeline <td> too, alongside its own pc-pipe-cell class, so a
  // pipeline column labels and classifies identically under the CSS-only card flip.
  const cellAttrs = { ...(tdAttrs || {}), class: (tdAttrs && tdAttrs.class ? tdAttrs.class + " " : "") + "pc-pipe-cell" };
  return el("td", cellAttrs, track);
}

// A stage's visible label: its declared label, else its key as a fallback.
function labelOf(stage) {
  return stage.label == null ? String(stage.key) : String(stage.label);
}

// Parse a "<number>%" width into its numeric percentage, or null if the string
// is not a bare percentage (e.g. "22rem", "120px") — used to decide whether the
// remainder left for weighted columns can be computed.
function colWidthPct(width) {
  const m = /^\s*([0-9]*\.?[0-9]+)%\s*$/.exec(width);
  return m ? parseFloat(m[1]) : null;
}

// A column carries an explicit width only when it is a non-empty string. Single
// source of truth so colWidthStyle/buildColgroup can't drift on what "explicit"
// means (which columns win verbatim, consume the remainder, or use their weight).
function hasExplicitWidth(col) {
  return typeof col.width === "string" && col.width !== "";
}

// A column's <col> width for the grid's <colgroup>: an explicit col.width string
// ("40%", "22rem") wins verbatim; else a positive numeric col.weight is
// normalised across the weighted columns into a percentage share of the width
// left over by explicit columns (remainderPct); else null (no width — the column
// shares the remainder equally under table-layout:fixed).
function colWidthStyle(col, weightTotal, remainderPct) {
  if (hasExplicitWidth(col)) return col.width;
  if (typeof col.weight === "number" && col.weight > 0 && weightTotal > 0) {
    return Math.round((col.weight / weightTotal) * remainderPct * 100) / 100 + "%";
  }
  return null;
}

// Build a <colgroup> that sizes the grid's columns so table-layout:fixed stops
// splitting width equally. Returns null when no column declares width/weight, so
// an unsized grid emits no colgroup and lays out exactly as today. 'extraCount'
// adds trailing unsized <col>s for the row-actions/detail column so the sized
// data columns stay aligned with their headers.
function buildColgroup(cols, extraCount) {
  const hasSizing = cols.some(
    (c) => hasExplicitWidth(c) || (typeof c.weight === "number" && c.weight > 0),
  );
  if (!hasSizing) return null;
  // Only columns that will actually use their weight (no explicit width — an
  // explicit width wins verbatim in colWidthStyle and never consumes weight)
  // contribute to weightTotal; counting a width-bearing column's weight here
  // would inflate the divisor and shrink the truly-weighted columns' share.
  let weightTotal = 0;
  for (const c of cols)
    if (!hasExplicitWidth(c) && typeof c.weight === "number" && c.weight > 0) weightTotal += c.weight;
  // Weighted columns share only the width the explicit columns leave behind, so
  // mixing e.g. width:"40%" with weighted columns can't oversubscribe past 100%.
  // The remainder is only computable when every explicit width is a percentage;
  // if any uses an absolute/relative unit (rem/px) we can't subtract it from
  // 100%, so weighted columns fall back to a share of the full width.
  let explicitPctTotal = 0;
  let allExplicitArePct = true;
  for (const c of cols) {
    if (hasExplicitWidth(c)) {
      const pct = colWidthPct(c.width);
      if (pct === null) allExplicitArePct = false;
      else explicitPctTotal += pct;
    }
  }
  const remainderPct = allExplicitArePct ? Math.max(0, 100 - explicitPctTotal) : 100;
  const colEls = cols.map((c) => {
    const w = colWidthStyle(c, weightTotal, remainderPct);
    return el("col", w ? { style: "width:" + w } : {});
  });
  for (let i = 0; i < extraCount; i++) colEls.push(el("col", {}));
  return el("colgroup", {}, ...colEls);
}

function renderActionForm(node) {
  const p = node.props;
  const card = el("section", { class: "pc-card" });
  if (p.title) card.append(el("h2", {}, p.title));
  // Map/null-proto stores so a schema field keyed __proto__/constructor can't
  // pollute Object.prototype or shadow inherited props (prototype-pollution class).
  const inputs = new Map();
  const fieldTypes = new Map();
  // Client-side required-field validation state: the set of required keys, each
  // field's custom message, and its inline error node (populated on a blocked
  // submit, cleared as soon as the user edits the field).
  const required = new Set();
  const reqMsg = new Map();
  const errs = new Map();
  // A required field's label carries a danger-toned "*" so the requirement is
  // visible BEFORE submit; spread into el(...) — an empty array adds no child.
  const reqMark = (f) => (f.required === true ? [el("span", { class: "pc-req", title: "Required" }, " *")] : []);
  // Register a field's inline error node and, when required, mark the input
  // (aria-required) and wire a clear-on-edit handler so a hint disappears the
  // moment the user starts fixing it. Editing a required field also clears the
  // blocked-submit summary ("Please fill in the required fields.") so it never
  // lingers as a stale/misleading banner while the user is correcting input.
  const wireField = (f, input, ferr, evt) => {
    errs.set(f.key, ferr);
    if (f.required !== true) return;
    required.add(f.key);
    if (typeof f.requiredMessage === "string" && f.requiredMessage !== "") reqMsg.set(f.key, f.requiredMessage);
    input.setAttribute("aria-required", "true");
    input.addEventListener(evt, () => {
      input.classList.remove("pc-invalid");
      input.removeAttribute("aria-invalid");
      ferr.textContent = "";
      msg.textContent = "";
      msg.className = "pc-msg";
    });
  };
  for (const f of p.fields || []) {
    const kind = f.type === "checkbox" ? "checkbox" : (f.type === "number" ? "number" : "text");
    fieldTypes.set(f.key, kind);
    const ferr = el("p", { class: "pc-field-err" });
    if (kind === "checkbox") {
      // A boolean field renders a real checkbox; its default checked state comes
      // from default/checked on the field (unset -> unchecked). We record that on
      // the input's defaultChecked so a post-submit reset can restore it without a
      // side map that could drift from the actual input.
      const checked = f.default === true || f.checked === true;
      const input = el("input", { type: "checkbox" });
      input.defaultChecked = checked;
      input.checked = checked;
      inputs.set(f.key, input);
      wireField(f, input, ferr, "change");
      // Input-first, wrapped in the label so the whole row is a click target.
      card.append(
        el("div", { class: "pc-field pc-field-check" }, el("label", {}, input, " " + (f.label || f.key), ...reqMark(f)), ferr),
      );
      continue;
    }
    const attrs = { type: kind, placeholder: f.label || f.key };
    if (kind === "number") {
      attrs.inputmode = "numeric";
      if (f.min != null) attrs.min = String(f.min);
      if (f.max != null) attrs.max = String(f.max);
      attrs.step = f.step != null ? String(f.step) : "1";
    }
    const input = el("input", attrs);
    inputs.set(f.key, input);
    wireField(f, input, ferr, "input");
    card.append(el("div", { class: "pc-field" }, el("label", {}, f.label || f.key, ...reqMark(f)), input, ferr));
  }
  const msg = el("p", { class: "pc-msg" });
  const btn = el("button", { class: "pc-btn" }, p.submitLabel || "Submit");
  btn.addEventListener("click", async () => {
    // Required-field gate: block the submit and surface an inline hint on each
    // empty required field (a text/number left blank, a required checkbox left
    // unchecked), focusing the first offender — so a missing value never
    // round-trips to the server only to bounce back as a generic error.
    let firstInvalid = null;
    for (const [k, input] of inputs) {
      const ferr = errs.get(k);
      if (ferr) ferr.textContent = "";
      input.classList.remove("pc-invalid");
      input.removeAttribute("aria-invalid");
      if (!required.has(k)) continue;
      const type = fieldTypes.get(k);
      const val = String(input.value).trim();
      const missing = type === "checkbox"
        ? input.checked !== true
        : type === "number"
          ? (val === "" || !Number.isFinite(Number(val)))
          : val === "";
      if (missing) {
        if (ferr) ferr.textContent = reqMsg.get(k) || "Required";
        input.classList.add("pc-invalid");
        input.setAttribute("aria-invalid", "true");
        if (!firstInvalid) firstInvalid = input;
      }
    }
    if (firstInvalid) {
      msg.className = "pc-msg err";
      msg.textContent = "Please fill in the required fields.";
      firstInvalid.focus();
      return;
    }
    const variables = Object.create(null);
    for (const [k, input] of inputs) {
      if (fieldTypes.get(k) === "checkbox") {
        // Always emit a real boolean (checked -> true / false), never a string,
        // so a strict equality check on the action side sees the intended value.
        variables[k] = input.checked === true;
      } else if (fieldTypes.get(k) === "number") {
        const t = String(input.value).trim();
        // Blank → omit so the action-side default applies; a non-finite parse
        // (NaN/Infinity) is also omitted rather than smuggling a raw string
        // process variable through, which would defeat the numeric coercion.
        if (t === "") continue;
        const num = Number(t);
        if (!Number.isFinite(num)) continue;
        variables[k] = num;
      } else {
        variables[k] = input.value;
      }
    }
    btn.disabled = true; msg.className = "pc-msg"; msg.textContent = "Submitting…";
    try {
      // Route-driven: POST the form (as { variables } by default, or the action's
      // own body template) to the action's route path. correlationKey / process /
      // message are expressed by the path + body template the page author supplies,
      // e.g. { path: "/app/actions/message", body: { name, correlationKey, variables: "{{form}}" } }.
      const res = await runRoute(p.action, { form: variables });
      msg.className = "pc-msg ok";
      msg.textContent = (p.action && p.action.successLabel) ||
        (res && res.processInstanceKey != null ? "Started (instance " + res.processInstanceKey + ")" : "Done");
      for (const [k, input] of inputs) {
        // Text/number inputs clear; a checkbox resets to its declared default,
        // read straight off the input's defaultChecked (no side map to drift).
        if (fieldTypes.get(k) === "checkbox") input.checked = input.defaultChecked;
        else input.value = "";
      }
      document.dispatchEvent(new CustomEvent("pc:refresh"));
    } catch (e) {
      msg.className = "pc-msg err"; msg.textContent = String(e.message || e);
    } finally { btn.disabled = false; }
  });
  card.append(btn, msg);
  return card;
}

// Accessible name for the row-count badge. The visible text is just a number, so an
// aria-label would override it with a bare "row count" (the count — the important part —
// is dropped). Instead name it "N row(s)" and keep it in sync with the text on refresh.
// Single source of truth for both the initial render and every refresh below.
function rowCountLabel(n) { return n + (n === 1 ? " row" : " rows"); }

function renderDataGrid(node) {
  const p = node.props;
  const card = el("section", { class: "pc-card" });
  // Opt-in live row-count badge ("showCount"). Rendered inside the <h2> so a plain
  // (non-collapsible) grid surfaces it beside the title; makeCollapsible re-homes it
  // into the collapse header so it stays visible — and refresh-updated — while the
  // section is collapsed. refresh() below rewrites its text on every poll/pc:refresh.
  const countBadge = p.showCount ? el("span", { class: "pc-badge pc-count-badge", "aria-label": rowCountLabel(0) }, "0") : null;
  if (p.title || countBadge) {
    const h2 = el("h2", {}, p.title || "");
    if (countBadge) { if (p.title) h2.append(" "); h2.append(countBadge); }
    card.append(h2);
  }
  const cols = p.columns || [];
  // Mobile card roles per column (derived by convention, refined by
  // col.mobile.priority) so the grid can flip to a stacked card list on a phone
  // (#268). 'hasHidden' gates the per-row "More" toggle that reveals the columns
  // a mobile:{priority:"hidden"} hint drops off the card.
  const roles = classifyColumns(cols);
  const hasHidden = roles.indexOf("hidden") >= 0;
  const tabs = p.tabs || [];
  const rowActions = p.rowActions || [];
  const detail = p.detail || null;
  const hasExtra = rowActions.length > 0 || detail != null;
  let activeFilter = p.data.filter || [];

  if (tabs.length) {
    const bar = el("div", { class: "pc-tabs" });
    activeFilter = tabs[0].filter || [];
    tabs.forEach((t, i) => {
      const b = el("button", { class: "pc-tab" + (i === 0 ? " active" : "") }, t.label);
      b.addEventListener("click", () => {
        activeFilter = t.filter || [];
        for (const c of bar.children) c.classList.remove("active");
        b.classList.add("active");
        refresh();
      });
      bar.append(b);
    });
    card.append(bar);
  }

  const headCells = cols.map((c) => el("th", {}, c.header || c.field));
  if (hasExtra) headCells.push(el("th", {}, ""));
  const thead = el("thead", {}, el("tr", {}, ...headCells));
  const tbody = el("tbody", {});
  // A <colgroup> (present only when a column declares width/weight) sizes the
  // columns so table-layout:fixed stops splitting width equally; it must precede
  // <thead> in the table.
  const colgroup = buildColgroup(cols, hasExtra ? 1 : 0);
  const table = colgroup
    ? el("table", { class: "pc-grid" }, colgroup, thead, tbody)
    : el("table", { class: "pc-grid" }, thead, tbody);
  card.append(table);
  const span = String((cols.length || 1) + (hasExtra ? 1 : 0));

  // Expansion state has to outlive the poll: refresh() rebuilds the whole tbody
  // every refreshMs, so without this an open detail row (where you answer an
  // escalation) would collapse on the next tick. We remember which rowKeys are
  // open, and reuse the already-built detail <tr> for them across refreshes so a
  // half-typed answer survives too. Keyed by p.rowKey; grids without one keep the
  // old (collapse-on-refresh) behavior.
  const expanded = new Set();
  const detailNodes = new Map();
  // A row only participates in expansion/detail-node caching if it has a real
  // (non-null) rowKey. Coercing a missing key through String() would yield the
  // literal "undefined"/"null" and collide unrelated rows, so treat it as keyless.
  const rowKeyOf = (row) => {
    if (!p.rowKey) return null;
    const v = row[p.rowKey];
    return v == null ? null : String(v);
  };

  function dataUrl(source, tbl, filters, order) {
    let u = "/app/data/" + encodeURIComponent(source) + "/" + encodeURIComponent(tbl);
    const qs = [];
    for (const f of filters || []) {
      if (Array.isArray(f.in)) qs.push("where=" + encodeURIComponent(f.field + ":in:" + f.in.join(",")));
      else if (f.eqParam) qs.push("where=" + encodeURIComponent(f.field + ":" + PARAM));
      else qs.push("where=" + encodeURIComponent(f.field + ":" + f.eq));
    }
    if (order && order.field) qs.push("order=" + encodeURIComponent(order.field + ":" + (order.dir || "asc")));
    return qs.length ? u + "?" + qs.join("&") : u;
  }

  async function fireAction(action, row) {
    // Route-driven row action: POST the action's body template (default {})
    // to its route path, with {{row.KEY}} tokens resolved from this row.
    return runRoute(action, { row });
  }

  function rowActionButton(row, ra) {
    if (ra.showWhenField && !row[ra.showWhenField]) return null;
    const b = el("button", { class: "pc-btn pc-btn-sm" }, ra.label);
    b.addEventListener("click", async (ev) => {
      ev.stopPropagation();
      if (ra.confirm && !confirm(ra.confirm)) return;
      b.disabled = true;
      try {
        await fireAction(ra.action, row);
        document.dispatchEvent(new CustomEvent("pc:refresh"));
      } catch (e) {
        b.disabled = false;
        alert(String(e.message || e));
      }
    });
    return b;
  }

  function detailForm(row) {
    const f = detail.form;
    if (!f || !row[f.showWhenField]) return null;
    const box = el("div", { class: "pc-subform" });
    if (f.title) box.append(el("div", { class: "pc-subform-title" }, f.title));
    if (f.promptField && row[f.promptField] != null) {
      box.append(el("div", { class: "pc-prompt" }, String(row[f.promptField])));
    }
    const input = el("textarea", { class: "pc-textarea", placeholder: f.inputLabel || f.inputKey });
    const msg = el("p", { class: "pc-msg" });
    const btn = el("button", { class: "pc-btn pc-btn-sm" }, f.submitLabel || "Submit");
    btn.addEventListener("click", async () => {
      btn.disabled = true; msg.className = "pc-msg"; msg.textContent = "Sending…";
      try {
        // The textarea value is the form's single field (f.inputKey); route + body
        // template come from f.action, e.g. { path: "/app/actions/message",
        // body: { name, correlationKey: "{{row.pr_key}}", variables: "{{form}}" } }.
        // Null-proto so an f.inputKey of "__proto__"/"constructor" can't mutate a prototype.
        const form = Object.create(null); form[f.inputKey] = input.value;
        await runRoute(f.action, { form, row });
        msg.className = "pc-msg ok"; msg.textContent = (f.action && f.action.successLabel) || "Sent";
        document.dispatchEvent(new CustomEvent("pc:refresh"));
      } catch (e) {
        btn.disabled = false; msg.className = "pc-msg err"; msg.textContent = String(e.message || e);
      }
    });
    box.append(el("div", { class: "pc-field" }, input), btn, msg);
    return box;
  }

  async function childGrid(cg, row) {
    const wrap = el("div", { class: "pc-child" });
    if (cg.title) wrap.append(el("div", { class: "pc-child-title" }, cg.title));
    const ccols = cg.columns || [];
    const croles = classifyColumns(ccols);
    const chasHidden = croles.indexOf("hidden") >= 0;
    const cbody = el("tbody", {});
    const ccolgroup = buildColgroup(ccols, cg.lazyField ? 1 : 0);
    const cthead = el("thead", {}, el("tr", {}, ...ccols.map((c) => el("th", {}, c.header || c.field)),
      ...(cg.lazyField ? [el("th", {}, "")] : [])));
    const ctable = ccolgroup
      ? el("table", { class: "pc-grid" }, ccolgroup, cthead, cbody)
      : el("table", { class: "pc-grid" }, cthead, cbody);
    wrap.append(ctable);
    try {
      const { rows } = await getJSON(dataUrl(cg.source || "app", cg.table,
        [{ field: cg.childField, eq: row[cg.parentField] }], cg.orderBy));
      const cspan = String((ccols.length || 1) + (cg.lazyField ? 1 : 0));
      if (!rows.length) {
        cbody.append(el("tr", {}, el("td", { colspan: cspan }, "None")));
      }
      for (const cr of rows) {
        const cells = ccols.map((c, i) => gridCell(c, cr, croles[i]));
        if (cg.lazyField) {
          const lf = cg.lazyField;
          const has = cr[lf.field] != null && String(cr[lf.field]).trim() !== "";
          const cell = el("td", {});
          if (has) {
            const toggle = el("button", { class: "pc-btn pc-btn-sm" }, lf.label || "Show");
            const pre = el("pre", { class: "pc-transcript", hidden: "" });
            pre.textContent = String(cr[lf.field]);
            toggle.addEventListener("click", () => {
              pre.hidden = !pre.hidden;
              toggle.textContent = pre.hidden ? (lf.label || "Show") : "Hide";
            });
            cell.append(toggle, pre);
          }
          cells.push(cell);
        }
        // Child grids classify columns into the same mobile roles (including
        // "hidden") as the top-level grid, so they need the same per-row "More"
        // toggle — without it a mobile:{priority:"hidden"} child column would be
        // permanently unreachable on a narrow viewport (#268).
        const ctr = el("tr", {}, ...cells);
        if (chasHidden) ctr.append(mobileMoreCell(ctr));
        cbody.append(ctr);
      }
    } catch (e) {
      cbody.append(el("tr", {}, el("td", { colspan: cspan }, String(e.message || e))));
    }
    return wrap;
  }

  function detailPanel(row) {
    const box = el("div", { class: "pc-detail" });
    if (detail.linkField && row[detail.linkField]) {
      const href = String(row[detail.linkField]);
      // Render as a link only for http(s); anything else (e.g. a javascript: URL
      // smuggled through row data) is shown as inert text. External links get
      // rel="noopener noreferrer" so the opened page can't reach window.opener.
      if (/^https?:\/\//i.test(href)) {
        box.append(el("a", { class: "pc-link", href, target: "_blank", rel: "noopener noreferrer" }, href));
      } else {
        box.append(el("span", { class: "pc-link" }, href));
      }
    }
    for (const df of detail.fields || []) {
      box.append(el("div", { class: "pc-detail-field" },
        el("span", { class: "pc-detail-label" }, df.label || df.field),
        el("span", {}, row[df.field] == null ? "" : String(row[df.field]))));
    }
    for (const cg of detail.children || []) {
      const holder = el("div", {});
      box.append(holder);
      childGrid(cg, row).then((w) => holder.replaceChildren(w));
    }
    const form = detailForm(row);
    if (form) box.append(form);
    return box;
  }

  function renderRow(row, sink) {
    const cells = cols.map((c, i) => gridCell(c, row, roles[i]));
    const key = rowKeyOf(row);
    let toggle = null;
    if (hasExtra) {
      const actionCell = el("td", { class: "pc-row-actions" });
      if (detail) {
        toggle = el("button", { class: "pc-btn pc-btn-sm pc-chevron" }, "▸");
        actionCell.append(toggle);
      }
      for (const ra of rowActions) {
        const b = rowActionButton(row, ra);
        if (b) actionCell.append(b);
      }
      cells.push(actionCell);
    }
    // Per-row "More" toggle: only when a mobile:{priority:"hidden"} hint drops
    // columns off the card. Appended after the <tr> is built (the toggle wires a
    // click against its own row) and shared with child grids via mobileMoreCell so
    // the reveal affordance and its aria state can't drift (#268).
    const tr = el("tr", {}, ...cells);
    if (hasHidden) tr.append(mobileMoreCell(tr));
    tbody.append(tr);
    // When grouping, the caller collects every <tr> this row produced (the data
    // row plus any detail row) so a group header can hide/show them as one unit.
    if (sink) sink.push({ tr, isDetail: false, key });
    if (detail && toggle) {
      const isOpen = key != null && expanded.has(key);
      // Reuse an already-built detail row for an open PR across refreshes so its
      // expanded state — and any half-typed escalation answer in the form — survives
      // the poll. A closed (or keyless) row always gets a fresh, lazily-built panel.
      let entry = key != null ? detailNodes.get(key) : null;
      if (!(isOpen && entry && entry.built)) {
        const dtr = el("tr", { hidden: isOpen ? null : "" }, el("td", { colspan: span }));
        entry = { dtr, built: false };
        if (key != null) detailNodes.set(key, entry);
        if (isOpen) { entry.built = true; dtr.firstChild.append(detailPanel(row)); }
      }
      const dtr = entry.dtr;
      toggle.textContent = dtr.hidden ? "▸" : "▾";
      toggle.addEventListener("click", (ev) => {
        ev.stopPropagation();
        const open = dtr.hidden;
        dtr.hidden = !open;
        toggle.textContent = open ? "▾" : "▸";
        if (open) {
          if (key != null) expanded.add(key);
          if (!entry.built) { entry.built = true; dtr.firstChild.append(detailPanel(row)); }
        } else if (key != null) {
          expanded.delete(key);
        }
      });
      tbody.append(dtr);
      if (sink) sink.push({ tr: dtr, isDetail: true, key });
    }
  }

  // Append the fetched rows into the tbody, either flat (default) or partitioned
  // into collapsible groups when the grid declares 'groupBy: "<field>"'. Each
  // group renders a clickable header row ("<Label> <value> (<count>)") that
  // collapses/expands its member rows as one unit; the collapsed state is
  // persisted (localStorage, keyed by page + node + group value) so it survives
  // both the refresh poll and a full reload — the same durability the top-level
  // 'collapsible' node wrapper gives. Group order is numeric-aware ascending
  // (so waves 1,2,10 sort naturally), falling back to lexical for non-numeric
  // keys. 'groupDefaultCollapsed' seeds each group collapsed until toggled.
  function appendRows(rows) {
    const groupBy = p.groupBy;
    // Treat a non-string groupBy as "no grouping": labelBase calls groupBy.charAt()
    // below, so a truthy non-string (number/object from a malformed page schema)
    // would throw at render time and break the whole page instead of one grid.
    if (!groupBy || typeof groupBy !== "string") { for (const row of rows) renderRow(row, null); return; }
    const order = [];
    const groups = new Map();
    for (const row of rows) {
      const gvRaw = row[groupBy];
      const gv = gvRaw == null ? "" : String(gvRaw);
      if (!groups.has(gv)) { groups.set(gv, []); order.push(gv); }
      groups.get(gv).push(row);
    }
    order.sort((a, b) => {
      const na = Number(a), nb = Number(b);
      if (a !== "" && b !== "" && !Number.isNaN(na) && !Number.isNaN(nb)) return na - nb;
      return a < b ? -1 : a > b ? 1 : 0;
    });
    const labelBase = p.groupLabel != null
      ? String(p.groupLabel)
      : groupBy.charAt(0).toUpperCase() + groupBy.slice(1);
    for (const gv of order) {
      const groupRows = groups.get(gv);
      const gkey = "pc:collapsed:" + CURRENT + ":" + (node.id || p.title || "grid") + ":g:" + gv;
      let gcollapsed = readCollapsed(gkey, !!p.groupDefaultCollapsed);
      const chevron = el("span", { class: "pc-chevron-inline" }, gcollapsed ? "▸" : "▾");
      const label = (gv === "" ? labelBase + " —" : labelBase + " " + gv) + " (" + groupRows.length + ")";
      const btn = el("button", { class: "pc-group-toggle", type: "button" },
        chevron, el("span", { class: "pc-group-title" }, label));
      tbody.append(el("tr", { class: "pc-group-header" }, el("td", { colspan: span }, btn)));
      const members = [];
      for (const row of groupRows) renderRow(row, members);
      const applyGroup = () => {
        chevron.textContent = gcollapsed ? "▸" : "▾";
        btn.setAttribute("aria-expanded", String(!gcollapsed));
        for (const m of members) {
          m.tr.hidden = gcollapsed
            ? true
            : (m.isDetail ? !(m.key != null && expanded.has(m.key)) : false);
        }
      };
      btn.addEventListener("click", () => {
        gcollapsed = !gcollapsed;
        writeCollapsed(gkey, gcollapsed);
        applyGroup();
      });
      applyGroup();
    }
  }

  // Is the user actively typing inside this grid? tbody.replaceChildren() in refresh()
  // detaches the subtree, and detaching the node that holds document.activeElement blurs
  // it — so an open detail form (where you answer an escalation) loses focus every
  // refreshMs even though #103 preserves its half-typed value. Used to skip the poll.
  const editingInGrid = () => {
    const a = document.activeElement;
    if (!a || !tbody.contains(a)) return false;
    return a.tagName === "INPUT" || a.tagName === "TEXTAREA" || a.tagName === "SELECT" || a.isContentEditable;
  };

  async function refresh() {
    try {
      // A grid scoped to a route param (any eqParam filter) means "show the rows
      // for the selected entity". With no param present, PARAM is empty and emitting
      // a where clause of field-colon-empty would read server-side as field equals
      // empty string and surface empty-valued rows. That is not the selected entity's
      // rows (there is no selection), so short-circuit to zero rows without a request.
      const paramScoped = (activeFilter || []).some((f) => f && f.eqParam);
      const { rows } = paramScoped && PARAM === ""
        ? { rows: [] }
        : await getJSON(dataUrl(p.data.source, p.data.table, activeFilter, p.data.orderBy));
      // Live row-count badge: reflect the currently-fetched, filtered (active-tab)
      // set — exactly what the body renders — on every refresh (poll + pc:refresh),
      // whether the section is expanded or collapsed.
      if (countBadge) { countBadge.textContent = String(rows.length); countBadge.setAttribute("aria-label", rowCountLabel(rows.length)); }
      // Forget expansion / cached detail nodes for rows no longer present so the maps
      // don't grow without bound and a stale answer can't resurface on a key reuse.
      if (p.rowKey) {
        const live = new Set();
        for (const r of rows) { const k = rowKeyOf(r); if (k != null) live.add(k); }
        for (const k of [...detailNodes.keys()]) if (!live.has(k)) detailNodes.delete(k);
        for (const k of [...expanded]) if (!live.has(k)) expanded.delete(k);
      }
      // Capture focus + caret before the DOM swap. replaceChildren() detaches (and so blurs)
      // the reused detail node; re-appending it restores its value but not its focus. If the
      // very same node is re-attached (an open, still-present row), put the caret back.
      const active = document.activeElement;
      const keepFocus = !!active && tbody.contains(active);
      let selStart = null, selEnd = null, savedRange = null;
      if (keepFocus) {
        if (active.isContentEditable) {
          // contenteditable has no selectionStart — its caret lives in the document
          // selection. The reused node is re-attached, so the cloned range still points
          // at live containers and can be restored after focus.
          try { const s = document.getSelection(); if (s && s.rangeCount) savedRange = s.getRangeAt(0).cloneRange(); } catch (e) { /* selection unavailable */ }
        } else {
          try { selStart = active.selectionStart; selEnd = active.selectionEnd; } catch (e) { /* non-text field */ }
        }
      }
      // Capture scroll offsets of scrolled descendants before the swap. An open detail node is
      // reused (same element instance), but replaceChildren() detaches it, which resets the
      // scrollTop/scrollLeft of any inner scroll container (e.g. a scrolled-into .pc-transcript,
      // max-height + overflow:auto) back to 0. Only built (open) detail subtrees are re-attached
      // by the rebuild, so walk just those — not the whole grid — to keep this O(open panels)
      // rather than O(grid size). Restoration below skips any node that isn't re-attached.
      const scrollSaved = [];
      for (const entry of detailNodes.values()) {
        if (!entry.built) continue;
        for (const sc of entry.dtr.querySelectorAll("*")) {
          if (sc.scrollTop || sc.scrollLeft) scrollSaved.push([sc, sc.scrollTop, sc.scrollLeft]);
        }
      }
      tbody.replaceChildren();
      appendRows(rows);
      if (!rows.length) tbody.append(el("tr", {}, el("td", { colspan: span }, "No rows")));
      if (keepFocus && active.isConnected) {
        active.focus();
        if (savedRange) {
          try { const s = document.getSelection(); s.removeAllRanges(); s.addRange(savedRange); } catch (e) { /* selection unavailable */ }
        } else if (selStart != null && typeof active.setSelectionRange === "function") {
          try { active.setSelectionRange(selStart, selEnd); } catch (e) { /* non-text field */ }
        }
      }
      // Restore scroll depth on the reused nodes that survived the swap (still connected).
      for (const [sc, top, left] of scrollSaved) {
        if (sc.isConnected) { sc.scrollTop = top; sc.scrollLeft = left; }
      }
    } catch (e) {
      tbody.replaceChildren(el("tr", {}, el("td", { colspan: span }, String(e.message || e))));
    }
  }
  document.addEventListener("pc:refresh", refresh);
  disposers.push(() => document.removeEventListener("pc:refresh", refresh));
  // Skip the automatic poll while the user is typing in the grid — an explicit pc:refresh
  // (e.g. after submitting an answer) still runs — so rows never shift under an in-progress
  // answer and the detail input keeps focus across ticks. The interval is registered as a
  // disposer so a page switch (hashchange → renderPage → teardown) stops it.
  if (p.refreshMs && p.refreshMs > 0) {
    const timer = setInterval(() => { if (!editingInGrid()) refresh(); }, p.refreshMs);
    disposers.push(() => clearInterval(timer));
  }
  refresh();
  return card;
}

// A navigation node — a horizontal menu bar (variant "bar", default) or a
// vertical side rail (variant "rail"). Each item links either to another page
// ({ label, page } -> an in-app #/<page> hash link, highlighted when it's the
// current page) or to an external URL ({ label, href } -> a hardened new-tab
// link; only http(s) is honoured). With items:"auto" (or omitted) the nav
// lists every page from the /app/pages index, using each page's title.
function navLink(item) {
  const isPage = safePageId(item.page);
  const isExt = !isPage && typeof item.href === "string" && /^https?:\/\//i.test(item.href);
  if (!isPage && !isExt) return null;
  const attrs = { class: "pc-nav-link" };
  if (isPage) {
    attrs.href = "#/" + encodeURIComponent(item.page);
    if (item.page === CURRENT) { attrs.class += " active"; attrs["aria-current"] = "page"; }
  } else {
    attrs.href = item.href; attrs.target = "_blank"; attrs.rel = "noopener noreferrer";
  }
  const kids = [];
  if (item.icon != null) kids.push(el("span", { class: "pc-nav-icon" }, String(item.icon)));
  kids.push(el("span", { class: "pc-nav-label" }, String(item.label != null ? item.label : (item.page || item.href))));
  return el("a", attrs, ...kids);
}
function fillNav(list, items) {
  list.replaceChildren();
  let n = 0;
  for (const item of items || []) {
    if (!item || typeof item !== "object") continue;
    const a = navLink(item);
    if (a) { list.append(a); n++; }
  }
  if (!n) list.append(el("span", { class: "pc-nav-empty" }, "No pages"));
}
function renderNav(node) {
  const p = node.props || {};
  const rail = p.variant === "rail";
  // A bar nav can opt into staying pinned to the top of the viewport while the
  // page scrolls (sticky) — useful on the long, multi-section operator pages so
  // the page switcher is always reachable. Rails are already full-height, so the
  // flag only applies to the bar variant.
  const barSticky = !rail && p.sticky === true;
  const nav = el("nav", {
    class: (rail ? "pc-nav pc-rail" : "pc-nav pc-bar") + (barSticky ? " pc-sticky" : ""),
  });
  if (p.title != null) nav.append(el("div", { class: "pc-nav-title" }, String(p.title)));
  const list = el("div", { class: "pc-nav-items" });
  nav.append(list);
  const items = p.items;
  if (Array.isArray(items)) {
    fillNav(list, items);
  } else {
    // "auto" (or unspecified): enumerate every page and link to each.
    getJSON("/app/pages")
      .then((res) => fillNav(list, (res.pages || []).map((pg) => ({ label: pg.title || pg.id, page: pg.id }))))
      .catch(() => list.append(el("span", { class: "pc-nav-empty" }, "No pages")));
  }
  return nav;
}

const RENDERERS = { text: renderText, actionForm: renderActionForm, dataGrid: renderDataGrid, nav: renderNav, button: renderButton };

// Durable per-node UI state. localStorage is keyed by the home page id + node
// id so two grids on the same page (or the same grid across pages) don't clash,
// and the collapsed state survives a full reload / new session — not just the
// refresh poll. Every access is guarded: private-mode or storage-disabled
// browsers throw on localStorage, and a UI preference must never break render.
function readCollapsed(key, dflt) {
  try {
    const v = localStorage.getItem(key);
    return v === null ? dflt : v === "1";
  } catch (e) {
    return dflt;
  }
}
function writeCollapsed(key, val) {
  try {
    localStorage.setItem(key, val ? "1" : "0");
  } catch (e) {
    // Preference is best-effort; ignore storage failures.
  }
}

// Wrap a rendered node so its card can be collapsed from a clickable header.
// Opt-in via the node's "collapsible" prop; "defaultCollapsed" seeds the state
// the first time (before the user has toggled it). Generic across node types —
// the body (everything the renderer produced, minus its own <h2> title, which
// becomes the header label) is hidden as one unit.
function makeCollapsible(node, card) {
  const props = node.props || {};
  if (!props.collapsible) return card;
  // Normalize to a card container. Card renderers already return
  // <section class="pc-card"> — we unwrap those in place (lift out the <h2>
  // title, reparent the rest into the body). A non-card renderer (e.g. text
  // returning <p>/<h1>) is nested whole inside a fresh section instead:
  // appending a <button>/<div> directly into a <p> is invalid markup the
  // browser silently re-parents, breaking layout and click handling.
  const isCard = card.tagName === "SECTION";
  const container = isCard ? card : el("section", { class: "pc-card" });
  const h2 = isCard && card.querySelector ? card.querySelector("h2") : null;
  // A dataGrid with "showCount" renders a live count badge inside its <h2>. Lift it
  // out before deriving the title (so the count doesn't leak into the label text),
  // then re-home it in the header alongside the title so it stays visible — and
  // refresh-updated by the grid's own refresh() — while the section is collapsed.
  const countBadge = h2 && h2.querySelector ? h2.querySelector(".pc-count-badge") : null;
  if (countBadge) countBadge.remove();
  // Trim the derived label: after the badge is lifted out, the leftover " " whitespace
  // node from h2.append(" ", countBadge) would otherwise make a title-less section's
  // header a lone space (and leak whitespace into the storage key). Fall back to "Section".
  const titleText = props.title || (h2 ? h2.textContent.trim() : "") || "Section";
  if (h2) h2.remove();
  const body = el("div", { class: "pc-card-body" });
  if (isCard) {
    while (card.firstChild) body.append(card.firstChild);
  } else {
    body.append(card);
  }
  const chevron = el("span", { class: "pc-chevron-inline" }, "▾");
  const header = el(
    "button",
    { class: "pc-collapse-header", type: "button" },
    chevron,
    el("span", { class: "pc-collapse-title" }, titleText),
  );
  if (countBadge) header.append(countBadge);
  const storageKey = "pc:collapsed:" + CURRENT + ":" + (node.id || titleText);
  let collapsed = readCollapsed(storageKey, !!props.defaultCollapsed);
  function apply() {
    body.hidden = collapsed;
    chevron.textContent = collapsed ? "▸" : "▾";
    header.setAttribute("aria-expanded", String(!collapsed));
  }
  header.addEventListener("click", () => {
    collapsed = !collapsed;
    writeCollapsed(storageKey, collapsed);
    apply();
  });
  apply();
  container.append(header, body);
  return container;
}

// Tier-2 escape hatch (#268): a page may declare a distinct 'mobile' layout
// variant — its own node list — for the rare case the derived card flip isn't
// enough (reorder/omit sections, swap a dense grid for a summary card). It is
// used ONLY on a narrow viewport; the default 'nodes' render everywhere else,
// and anything malformed falls back to them, so the variant is purely additive.
function pickNodes(doc) {
  if (isNarrow() && doc && doc.mobile && Array.isArray(doc.mobile.nodes)) return doc.mobile.nodes;
  return (doc && doc.nodes) || [];
}

// Render the page named by the current hash route. A rail nav is lifted into a
// left <aside> and the rest of the nodes flow into a content column; otherwise
// (bar nav or none) nodes render in document order. Re-runs on every hashchange,
// tearing down the previous page's grid polls first.
async function renderPage() {
  teardown();
  const mySeq = ++renderSeq;
  const route = parseRoute();
  CURRENT = route.page;
  PARAM = route.param;
  try {
    const doc = await getJSON("/app/pages/" + encodeURIComponent(CURRENT));
    if (mySeq !== renderSeq) return;
    document.title = (doc && doc.title) || "Urban App";
    const nodes = pickNodes(doc);
    const built = nodes.map((n) => ({ n, node: makeCollapsible(n, (RENDERERS[n.type] || (() => el("div")))(n)) }));
    const rail = built.find((b) => b.n.type === "nav" && b.n.props && b.n.props.variant === "rail");
    if (rail) {
      const col = el("div", { class: "pc-main-col" });
      for (const b of built) if (b !== rail) col.append(b.node);
      root.replaceChildren(el("div", { class: "pc-layout" }, el("aside", { class: "pc-rail-wrap" }, rail.node), col));
    } else {
      root.replaceChildren(...built.map((b) => b.node));
    }
  } catch (e) {
    if (mySeq !== renderSeq) return;
    root.replaceChildren(el("p", { class: "pc-msg err" }, "Failed to load page: " + String((e && e.message) || e)));
  }
}
window.addEventListener("hashchange", renderPage);
// Re-render when the viewport crosses the mobile breakpoint so a Tier-2 'mobile'
// variant swaps in/out on rotation or a window resize (the grid card flip, nav
// collapse and button stacking are pure CSS and need no re-render). teardown()
// inside renderPage stops the outgoing page's grid polls first. Prefer the modern
// addEventListener but fall back to the deprecated addListener so older Safari/iOS
// (< 14), where MediaQueryList.addEventListener is unimplemented, still swaps the
// Tier-2 variant on rotation/resize instead of silently failing to register.
if (typeof MOBILE_MQ.addEventListener === "function") MOBILE_MQ.addEventListener("change", renderPage);
else if (typeof MOBILE_MQ.addListener === "function") MOBILE_MQ.addListener(renderPage);
renderPage();
`;

/** A tiny, dependency-free FNV-1a hash → 8 hex chars. Used to fingerprint the renderer
 *  module's URL so a content change busts the browser cache. Environment-agnostic (no
 *  `crypto` import) so the runtime stays loadable under Node, Deno, and the embedded host. */
function fnv1aHex(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

// The renderer module is served at a *content-fingerprinted* URL. The shell references this exact
// path, so whenever `RENDERER_JS` changes (e.g. an Urban upgrade in a marketplace/Studio update)
// the URL changes with it and the browser fetches the new module instead of silently replaying a
// heuristically-cached copy of the old one — the failure that made a "Cancel" button (and every
// other page action) do nothing after an upgrade until a hard refresh. Because the URL is unique
// per content, the response itself is served `immutable` with a one-year max-age.
const RUNTIME_JS_HASH = fnv1aHex(RENDERER_JS);
const RUNTIME_JS_PATH = `/app/runtime.${RUNTIME_JS_HASH}.js`;
const IMMUTABLE_CACHE = "public, max-age=31536000, immutable";
