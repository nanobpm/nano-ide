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

import type { AppApi, RuntimeContext } from "../context.ts";
import { errorMessage, isRecord } from "../guards.ts";
import type { EngineClient } from "../host.ts";
import { html, json, type Route } from "../router.ts";
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
}

export interface PagesDeps {
  db: PagesDataSource;
  engine: EngineClient;
  /** Read a page file; injectable for tests. */
  readPage(path: string): Promise<string>;
}

/** A JavaScript-body response (the renderer module served at /app/runtime.js). */
function javascript(body: string, status = 200): { status: number; headers: Record<string, string>; body: string } {
  return { status, headers: { "content-type": "text/javascript; charset=utf-8" }, body };
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
  const { db, engine, readPage } = deps;

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
  const shell = html(rendererShell(homePage));

  // ── the renderer shell + module ─────────────────────────────────────────
  routes.push({ method: "GET", path: "/", source: "surface:pages", handler: () => shell });
  routes.push({ method: "GET", path: "/index.html", source: "surface:pages", handler: () => shell });
  routes.push({
    method: "GET",
    path: "/app/runtime.js",
    source: "surface:pages",
    handler: () => javascript(RENDERER_JS),
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
  };
  const sourceName = opts.sourceName ?? "app";
  const routes = createPagesRoutes(opts, {
    db: app.data.open(sourceName),
    engine: app.engine,
    readPage: (p) => ctx.host.readTextFile(p),
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

function rendererShell(homePage: string): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Urban App</title>
  <style>${RENDERER_CSS}</style>
</head>
<body>
  <main id="page" data-home="${escapeAttr(homePage)}"><p class="pc-empty">Loading…</p></main>
  <script type="module" src="./app/runtime.js"></script>
</body>
</html>`;
}

// The app's stylesheet resolves every colour through the Nano console's
// semantic `--nano-*` token contract (see nanobpmn console/src/theme/tokens.css
// — MIRROR: keep the palettes below in sync). When the app is embedded in the
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
:root[data-appearance="light"], .pc-light-palette {
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
.pc-heading { font-size:1.6rem; font-weight:650; margin:0 0 .25rem; }
.pc-sub { color:var(--nano-text-muted); margin:.25rem 0 1rem; }
.pc-body { margin:.5rem 0; }
.pc-card { border:1px solid var(--nano-edge); border-radius:.6rem; padding:1rem 1.15rem; margin:1rem 0; background:var(--nano-panel); }
.pc-card h2 { font-size:1rem; margin:0 0 .75rem; }
.pc-field { display:flex; flex-direction:column; gap:.25rem; margin-bottom:.6rem; }
.pc-field label { font-size:.8rem; color:var(--nano-text-muted); }
.pc-field input { padding:.5rem .6rem; border:1px solid var(--nano-edge); border-radius:.4rem; font:inherit; background:var(--nano-inset); color:var(--nano-text); }
.pc-btn { padding:.5rem .9rem; border:0; border-radius:.4rem; background:var(--nano-accent); color:var(--nano-on-accent); font:inherit; cursor:pointer; }
.pc-btn:disabled { opacity:.5; cursor:default; }
.pc-msg { font-size:.85rem; margin-top:.5rem; min-height:1.2em; }
.pc-msg.err { color:var(--nano-danger); }
.pc-msg.ok { color:var(--nano-ok); }
table.pc-grid { width:100%; border-collapse:collapse; font-size:.9rem; }
table.pc-grid th, table.pc-grid td { text-align:left; padding:.4rem .6rem; border-bottom:1px solid var(--nano-edge); }
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
`;

// The schema-driven browser renderer (ADR 0042 §3). Plain ES module string served at
// /app/runtime.js — it does NOT ship Craft.js (authoring is console-side only). It
// fetches the home page's page.json and renders text / actionForm / dataGrid nodes,
// wiring actionForm → /app/actions/start and dataGrid → /app/data (with a refresh).
const RENDERER_JS = String.raw`
const root = document.getElementById("page");
const HOME = root.dataset.home || "home";

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
if (window.parent && window.parent !== window) {
  window.addEventListener("message", (ev) => {
    // Same-origin proxy (posture A): only trust the framing parent.
    if (ev.source === window.parent) applyTheme(ev.data);
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

// A grid td cell. When the column declares linkField, the cell text (the
// column's own value) becomes a link to the URL held in that other field,
// opened in a new tab. Only http(s) hrefs are linked — anything else (e.g. a
// javascript: URL smuggled through row data) falls back to plain text — and
// external links get rel=noopener noreferrer so the opened page can't reach
// window.opener. Shared by the top-level grid and child grids.
function gridCell(col, row) {
  const text = row[col.field] == null ? "" : String(row[col.field]);
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
    const kind = f.type === "number" ? "number" : "text";
    fieldTypes.set(f.key, kind);
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
      if (fieldTypes.get(k) === "number") {
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
      const res = await getJSON("/app/actions/start/" + encodeURIComponent(p.action.process),
        { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ variables }) });
      msg.className = "pc-msg ok";
      msg.textContent = "Started (instance " + (res.processInstanceKey ?? "?") + ")";
      for (const input of inputs.values()) input.value = "";
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
    if (action.kind === "cancelProcess") {
      return getJSON("/app/actions/cancel", { method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ processInstanceKey: row[action.keyField] }) });
    }
    if (action.kind === "publishMessage") {
      return getJSON("/app/actions/message", { method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: action.message, correlationKey: row[action.correlationKeyField],
          variables: { ...(action.variables || {}) } }) });
    }
    if (action.kind === "startProcess") {
      return getJSON("/app/actions/start/" + encodeURIComponent(action.process), { method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ variables: { ...(action.variables || {}) } }) });
    }
    throw new Error("unknown action");
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
        await getJSON("/app/actions/message", { method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ name: f.action.message, correlationKey: row[f.action.correlationKeyField],
            variables: { [f.inputKey]: input.value, ...(f.action.variables || {}) } }) });
        msg.className = "pc-msg ok"; msg.textContent = "Sent";
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
    } catch (e) {
      tbody.replaceChildren(el("tr", {}, el("td", { colspan: span }, String(e.message || e))));
    }
  }
  document.addEventListener("pc:refresh", refresh);
  // Skip the automatic poll while the user is typing in the grid — an explicit pc:refresh
  // (e.g. after submitting an answer) still runs — so rows never shift under an in-progress
  // answer and the detail input keeps focus across ticks.
  if (p.refreshMs && p.refreshMs > 0) setInterval(() => { if (!editingInGrid()) refresh(); }, p.refreshMs);
  refresh();
  return card;
}

const RENDERERS = { text: renderText, actionForm: renderActionForm, dataGrid: renderDataGrid };

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
  const storageKey = "pc:collapsed:" + HOME + ":" + (node.id || titleText);
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

async function main() {
  try {
    const doc = await getJSON("/app/pages/" + encodeURIComponent(HOME));
    if (doc.title) document.title = doc.title;
    root.replaceChildren(
      ...(doc.nodes || []).map((n) => makeCollapsible(n, (RENDERERS[n.type] || (() => el("div")))(n))),
    );
  } catch (e) {
    root.replaceChildren(el("p", { class: "pc-msg err" }, "Failed to load page: " + String(e.message || e)));
  }
}
main();
`;
