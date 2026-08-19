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
import { RENDERER_JS } from "./runtime.gen.ts";

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

// A query flag (e.g. ?count=1) is "on" when present and not one of the falsy
// spellings. A bare `?count` (empty string) still counts as on, so a caller can
// opt in without inventing a value.
function isTruthyParam(v: string | null): boolean {
  if (v === null) return false;
  const s = v.trim().toLowerCase();
  return s !== "0" && s !== "false" && s !== "no";
}

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
      // ?count=1 → a lightweight COUNT(*) instead of the rows themselves. The same
      // whitelisted where clauses apply, so a caller (e.g. a nav item's live count
      // badge) gets exactly the number of matching rows without transferring or
      // materialising them. ORDER BY / LIMIT are irrelevant to a count and skipped.
      if (isTruthyParam(req.query.get("count"))) {
        try {
          const rows = await db.query(
            `SELECT COUNT(*) AS n FROM ${quoteIdent(table)}${whereSql}`,
            params,
          );
          const first = Array.isArray(rows) && rows.length > 0 ? rows[0] : undefined;
          const rawCount = isRecord(first) ? first.n : 0;
          const count = Number(rawCount);
          return json({ count: Number.isFinite(count) ? count : 0 });
        } catch (e) {
          return json({ error: errorMessage(e) }, 500);
        }
      }
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
   here (the .pc-pipe classes); the active-stage badge and locus links reuse the
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
/* Data-bound prose/markdown list (renderProse, #274). Long-form narrative
   records — plan-review findings, coordination notes, escalation bodies — read
   as a stacked, full-width document at a comfortable measure (~66ch) instead of
   being jammed into a grid column. Each item stacks a small header over a
   markdown-rendered body; the body max-width is set inline per node (props.measure)
   with this rule as the no-JS fallback. */
.pc-prose-list { display:flex; flex-direction:column; gap:1.1rem; }
.pc-prose-item { border-top:1px solid var(--nano-edge); padding-top:.9rem; }
.pc-prose-item:first-child { border-top:0; padding-top:0; }
.pc-prose-head { font-size:.8rem; font-weight:600; color:var(--nano-text-muted); text-transform:uppercase; letter-spacing:.03em; margin:0 0 .35rem; }
.pc-prose-empty { color:var(--nano-text-faint); }
.pc-prose-body { max-width:66ch; }
.pc-prose-body > :first-child { margin-top:0; }
.pc-prose-body > :last-child { margin-bottom:0; }
.pc-md-p { margin:.55rem 0; overflow-wrap:anywhere; }
.pc-md-h { font-size:1.05rem; font-weight:650; margin:.95rem 0 .4rem; }
.pc-md-list { margin:.45rem 0; padding-left:1.35rem; }
.pc-md-list li { margin:.15rem 0; }
.pc-md-quote { margin:.6rem 0; padding:.1rem .9rem; border-left:3px solid var(--nano-edge-strong); color:var(--nano-text-muted); }
.pc-md-pre { background:var(--nano-inset); border:1px solid var(--nano-edge); border-radius:.4rem; padding:.7rem .8rem; overflow:auto; margin:.6rem 0; }
.pc-md-pre code { font:.82rem/1.5 ui-monospace,SFMono-Regular,Menlo,monospace; color:var(--nano-text); white-space:pre; }
.pc-md-code { background:var(--nano-inset); border-radius:.3rem; padding:.05rem .3rem; font:.85em ui-monospace,SFMono-Regular,Menlo,monospace; }
.pc-md-hr { border:0; border-top:1px solid var(--nano-edge); margin:1rem 0; }
.pc-prose-body a { color:var(--nano-accent-strong); }
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
/* A nav item's live count pill (item.badge). Slightly more compact than the base
   .pc-badge so it sits neatly beside a nav label; [hidden] must win over the
   .pc-badge inline-flex display so hideWhenZero / a failed fetch truly hides it. */
.pc-nav-badge { min-width:1.1rem; height:1.1rem; font-size:.68rem; padding:0 .35rem; margin-left:.1rem; }
.pc-nav-badge[hidden] { display:none; }
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
// fetches the home page's page.json and renders text / actionForm / dataGrid / prose
// nodes, wiring actionForm → /app/actions/start and dataGrid/prose → /app/data (with a refresh).
//
// `RENDERER_JS` is a generated, checked-in artifact (runtime.gen.ts) derived from the
// real, type-checked/linted/unit-tested source at ../../browser/runtime.browser.js by
// scripts/gen-runtime.mjs (#291). Do not edit runtime.gen.ts by hand — edit the source
// and run `npm run gen:runtime`; CI enforces the two stay in sync (npm run check:runtime).

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
