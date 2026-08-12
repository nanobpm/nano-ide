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
table.pc-grid { width:100%; border-collapse:collapse; font-size:.9rem; }
/* Wrap long, space-less cell values (e.g. a JSON blob or a 40-char SHA) so one
   cell can't force its column wide and blow the whole table past the page.
   overflow-wrap:anywhere reduces the cell's min-content width so the auto table
   layout can shrink it to fit; max-width caps a single column when there is
   ample room. vertical-align:top keeps a multi-line cell aligned with its
   single-line neighbours. */
table.pc-grid th, table.pc-grid td { text-align:left; padding:.4rem .6rem; border-bottom:1px solid var(--nano-edge); overflow-wrap:anywhere; word-wrap:break-word; max-width:32rem; vertical-align:top; }
table.pc-grid th { font-weight:600; color:var(--nano-text-muted); }
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
.pc-badge { display:inline-flex; align-items:center; justify-content:center; min-width:1.35rem; height:1.35rem; padding:0 .4rem; border-radius:999px; font-size:.72rem; font-weight:700; line-height:1; color:#fff; background:var(--nano-danger); }
.pc-badge-danger { background:var(--nano-danger); }
.pc-badge-warn { background:var(--nano-warn); color:#3a2a00; }
.pc-badge-ok { background:var(--nano-ok); }
.pc-badge-info { background:var(--nano-info); }
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
`;

// The schema-driven browser renderer (ADR 0042 §3). Plain ES module string served at
// /app/runtime.js — it does NOT ship Craft.js (authoring is console-side only). It
// fetches the home page's page.json and renders text / actionForm / dataGrid nodes,
// wiring actionForm → /app/actions/start and dataGrid → /app/data (with a refresh).
const RENDERER_JS = String.raw`
const root = document.getElementById("page");
const HOME = root.dataset.home || "home";

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
function currentPage() {
  try {
    const raw = decodeURIComponent((location.hash || "").replace(/^#\/?/, ""));
    return safePageId(raw) ? raw : HOME;
  } catch (e) {
    return HOME;
  }
}
let CURRENT = currentPage();

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

function renderText(node) {
  const v = node.props.variant;
  const cls = v === "heading" ? "pc-heading" : v === "sub" ? "pc-sub" : "pc-body";
  return el(v === "heading" ? "h1" : "p", { class: cls }, node.props.text || "");
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

// A grid td cell. Two column-declared linking modes, checked in order:
//   1. linkField — the cell text becomes a link to the URL held in that other
//      field. Only http(s) hrefs are linked (a javascript:/other-scheme URL
//      smuggled through row data falls back to plain text).
//   2. link: { kind: "processExplorer", keyField } — a structured, engine-aware
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
function gridCell(col, row) {
  const text = row[col.field] == null ? "" : String(row[col.field]);
  // 3. badge — a compact status indicator. When the row's field value is
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
    if (text.trim() === "") return el("td", {});
    const t = col.badge.tone;
    const tone = t === "warn" || t === "ok" || t === "info" ? t : "danger";
    const label = col.badge.label == null ? "1" : String(col.badge.label);
    return el(
      "td",
      {},
      el("span", { class: "pc-badge pc-badge-" + tone, title: text, "aria-label": text }, label),
    );
  }
  if (col.linkField) {
    const href = row[col.linkField] == null ? "" : String(row[col.linkField]);
    if (text !== "" && /^https?:\/\//i.test(href)) {
      return el(
        "td",
        {},
        el("a", { class: "pc-link", href, target: "_blank", rel: "noopener noreferrer" }, text),
      );
    }
  }
  if (col.link && col.link.kind === "processExplorer" && col.link.keyField) {
    const key = row[col.link.keyField];
    const keyStr = key == null ? "" : String(key).trim();
    if (text !== "" && keyStr !== "") {
      const href = "/console/explorer?instance=" + encodeURIComponent(keyStr);
      return el(
        "td",
        {},
        el("a", {
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
        }, text),
      );
    }
  }
  return el("td", {}, text);
}

function renderActionForm(node) {
  const p = node.props;
  const card = el("section", { class: "pc-card" });
  if (p.title) card.append(el("h2", {}, p.title));
  // Map/null-proto stores so a schema field keyed __proto__/constructor can't
  // pollute Object.prototype or shadow inherited props (prototype-pollution class).
  const inputs = new Map();
  const fieldTypes = new Map();
  for (const f of p.fields || []) {
    const kind = f.type === "checkbox" ? "checkbox" : (f.type === "number" ? "number" : "text");
    fieldTypes.set(f.key, kind);
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
      // Input-first, wrapped in the label so the whole row is a click target.
      card.append(
        el("div", { class: "pc-field pc-field-check" }, el("label", {}, input, " " + (f.label || f.key))),
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
    card.append(el("div", { class: "pc-field" }, el("label", {}, f.label || f.key), input));
  }
  const msg = el("p", { class: "pc-msg" });
  const btn = el("button", { class: "pc-btn" }, p.submitLabel || "Submit");
  btn.addEventListener("click", async () => {
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

function renderDataGrid(node) {
  const p = node.props;
  const card = el("section", { class: "pc-card" });
  if (p.title) card.append(el("h2", {}, p.title));
  const cols = p.columns || [];
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
  const table = el("table", { class: "pc-grid" }, thead, tbody);
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
    const cbody = el("tbody", {});
    const ctable = el("table", { class: "pc-grid" },
      el("thead", {}, el("tr", {}, ...ccols.map((c) => el("th", {}, c.header || c.field)),
        ...(cg.lazyField ? [el("th", {}, "")] : []))), cbody);
    wrap.append(ctable);
    try {
      const { rows } = await getJSON(dataUrl(cg.source || "app", cg.table,
        [{ field: cg.childField, eq: row[cg.parentField] }], cg.orderBy));
      const cspan = String((ccols.length || 1) + (cg.lazyField ? 1 : 0));
      if (!rows.length) {
        cbody.append(el("tr", {}, el("td", { colspan: cspan }, "None")));
      }
      for (const cr of rows) {
        const cells = ccols.map((c) => gridCell(c, cr));
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
        cbody.append(el("tr", {}, ...cells));
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

  function renderRow(row) {
    const cells = cols.map((c) => gridCell(c, row));
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
    const tr = el("tr", {}, ...cells);
    tbody.append(tr);
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
      const { rows } = await getJSON(dataUrl(p.data.source, p.data.table, activeFilter, p.data.orderBy));
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
      for (const row of rows) renderRow(row);
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
  const nav = el("nav", { class: rail ? "pc-nav pc-rail" : "pc-nav pc-bar" });
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
  const titleText = props.title || (h2 ? h2.textContent : "") || "Section";
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

// Render the page named by the current hash route. A rail nav is lifted into a
// left <aside> and the rest of the nodes flow into a content column; otherwise
// (bar nav or none) nodes render in document order. Re-runs on every hashchange,
// tearing down the previous page's grid polls first.
async function renderPage() {
  teardown();
  CURRENT = currentPage();
  try {
    const doc = await getJSON("/app/pages/" + encodeURIComponent(CURRENT));
    document.title = (doc && doc.title) || "Urban App";
    const nodes = (doc && doc.nodes) || [];
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
    root.replaceChildren(el("p", { class: "pc-msg err" }, "Failed to load page: " + String((e && e.message) || e)));
  }
}
window.addEventListener("hashchange", renderPage);
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
