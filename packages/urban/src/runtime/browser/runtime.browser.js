// @ts-check
// ── Urban browser page runtime (authored source) ──────────────────────────
// This is the real, type-checked / linted / unit-tested source for the browser
// page renderer served at /app/runtime.js. It is NOT served from disk directly:
// the checked-in string artifact `../core/modules/runtime.gen.ts` is *generated*
// from this file by `scripts/gen-runtime.mjs` — the same "generated derived
// artifact + `git diff --exit-code` in CI" pattern AGENTS.md uses elsewhere, so
// a forgotten regeneration fails CI instead of shipping drift. The lone
// `__MOBILE_MAX_WIDTH__` placeholder is substituted from the shared MOBILE
// breakpoint (the single source of truth) at generation time, so the JS
// mode-switch and the shell CSS @media can never drift. Regenerate with
// `npm run gen:runtime`.
//
// The module is import-safe under Node/Deno: it performs NO DOM access at load —
// every bootstrap side-effect lives in boot(), gated on a real <main id="page">.
// That lets the renderer functions and the RENDERERS registry be imported and
// unit-tested with a fake DOM, and lets the string-generation build load it.

/** @typedef {import("@nanobpm/nano-app-schema").PageNodeType} PageNodeType */
/**
 * A page node from a `*.page.json` document. `props` is an open, author-supplied
 * bag whose shape is owned/validated by `@nanobpm/nano-app-schema`, so it is
 * intentionally loose at this (already-validated) rendering boundary.
 * @typedef {{ type: string, id?: string, props?: Record<string, any> }} PageNode
 */
/** A renderer turns one page node into a DOM element. @typedef {(node: PageNode) => HTMLElement} Renderer */
/** Action-resolution context: the current form fields and (for grid rows) the row. @typedef {{ form?: Record<string, any>, row?: Record<string, any> }} ActionCtx */

/** The page mount root (`<main id="page">`). Assigned in boot(). @type {HTMLElement} */
let root;
/** The home page id (from the mount root's `data-home`). @type {string} */
let HOME = "home";
/** The single mobile-breakpoint media query. Assigned in boot(). @type {MediaQueryList} */
let MOBILE_MQ;
/** True when this app runs inside the Nano console's same-origin iframe. Assigned in boot(). @type {boolean} */
let NANO_EMBEDDED = false;

// Single mobile breakpoint, interpolated from the same MOBILE_MAX_WIDTH constant
// as the shell CSS @media so the JS mode-switch and the pure-CSS card flip can
// never drift on where "narrow" begins (#268). Only Tier-2 (an optional
// page-level 'mobile' layout variant) needs this JS switch — the dataGrid card
// flip, nav collapse and button/form stacking are all pure CSS + data-label.
function isNarrow() { return MOBILE_MQ.matches; }

// ── Multi-page routing (hash-based, reverse-proxy safe) ──────────────────
// Pages are selected by the URL fragment (#/<page>) so navigation never hits
// the server and works identically at the origin root and under the Nano
// console's /console/app-view/<name>/ path-prefixed proxy (the hash is never
// sent upstream). An empty/invalid hash falls back to the home page. Only a
// safe id charset is accepted so the fragment can't smuggle a path/URL.
const PAGE_ID = /^[A-Za-z0-9_-]+$/;
/** @param {any} value */
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
let CURRENT = "home";
// The current route param (the "/<param>" tail, or "" when absent). Exposed to a
// page's datasource filters (a filter with { eqParam: true } binds its value to
// this) and to {{param}} text interpolation, so one page template can scope
// every section to a selected entity (e.g. an epic's plan_key).
let PARAM = "";
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
/** @type {any[]} */
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
/** @param {any} msg */
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
function computeEmbedded() {
  if (!window.parent || window.parent === window) return false;
  try {
    return window.parent.location.origin === window.location.origin;
  } catch {
    return false;
  }
}

// Ask the framing console to navigate in-host. Returns true when a message was
// posted (embedded) so the caller can suppress the native anchor; false
// standalone so it falls through to the new-window <a>. The payload is
// structured (target + params), never a raw href — the console constructs its
// own route, so app/row data can't smuggle a path or scheme across the boundary.
/** @param {string} target
 * @param {Record<string, any>} params
 */
function hostNavigate(target, params) {
  if (!NANO_EMBEDDED) return false;
  window.parent.postMessage({ type: "nano-navigate", target: target, params: params }, window.location.origin);
  return true;
}

function installThemeBridge() {
  if (!NANO_EMBEDDED) return;
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
/** @param {string} u */
function apiUrl(u) {
  // Rebase root-absolute app paths ("/app/…") onto the mount root. Leave a
  // protocol-relative ("//host/…") or otherwise non-root-relative string alone —
  // only a single leading slash denotes an app path we own.
  return typeof u === "string" && u.startsWith("/") && !u.startsWith("//")
    ? new URL(u.slice(1), APP_BASE).toString()
    : u;
}

/** @param {string} url
 * @param {RequestInit=} opts
 * @returns {Promise<any>}
 */
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
/** @param {string} path
 * @param {ActionCtx} ctx
 * @returns {any}
 */
function lookupToken(path, ctx) {
  const segs = String(path).split(".");
  const head = segs[0];
  let base = head === "form" ? (ctx.form || {}) : head === "row" ? (ctx.row || {}) : undefined;
  for (let i = 1; i < segs.length; i++) base = base == null ? undefined : base[segs[i]];
  return base;
}
/** @param {any} node
 * @param {ActionCtx} ctx
 * @returns {any}
 */
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
/** @param {any} action
 * @param {ActionCtx} ctx
 * @returns {Promise<any>}
 */
async function runRoute(action, ctx) {
  if (!action || typeof action.path !== "string" || action.path === "") {
    throw new Error("This action has no route configured (action.path is missing or blank)");
  }
  const path = /** @type {any} */ (action.path).replace(/\{\{\s*([\w.]+)\s*\}\}/g, /** @param {string} _ @param {string} k */ (_, k) => {
    const v = lookupToken(k, ctx);
    return v == null ? "" : encodeURIComponent(String(v));
  });
  const method = String(action.method || "POST").toUpperCase();
  let body;
  if (action.body !== undefined) body = resolveTemplate(action.body, ctx);
  else if (ctx.form) body = { variables: ctx.form };
  else body = {};
  /** @type {RequestInit} */
  const opts = { method, headers: { "content-type": "application/json" } };
  if (method !== "GET" && method !== "HEAD") opts.body = JSON.stringify(body);
  return getJSON(path, opts);
}

/** @param {string} tag
 * @param {Record<string, any>} [attrs]
 * @param {...any} kids
 * @returns {any}
 */
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
/** @param {any} s
 * @returns {any}
 */
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
/** @param {any} tpl
 * @param {Record<string, any>} row
 * @returns {any}
 */
function interpTemplate(tpl, row) {
  return typeof tpl === "string"
    ? tpl.replace(/\{\{([^{}]+)\}\}/g, (_m, name) => {
        const key = name.trim();
        const v = Object.prototype.hasOwnProperty.call(row, key) ? row[key] : null;
        return v == null ? "" : String(v);
      })
    : tpl;
}

// Format a single-field cell value per a column's opt-in `col.format` (issue
// #327). This runs in the browser, so it is the ONLY place that can render a
// stored UTC ISO timestamp in the VIEWER'S local timezone — the server never
// knows the viewer's zone, so a server-formatted string would always be wrong
// for someone. Currently the sole format is "datetime": a parseable ISO/date
// value → "11:42am Aug 19" (h:mm + lowercase am/pm, then short-month day), both
// parts in local time. Defensive by construction: an empty value, an unparseable
// date, or any unknown format returns the raw text verbatim — a mis-set format
// never blanks a cell or throws, matching how an unrecognised link.kind degrades
// to plain text. Display-only: the untransformed rawText still drives the badge
// gate/tooltip and any sort/groupBy (those key off the real field).
/** @param {any} format
 * @param {string} raw
 * @returns {string} */
function fmtCellValue(format, raw) {
  if (format !== "datetime" || raw === "") return raw;
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) return raw;
  // Present in a stable en-US format ("11:42am Aug 19") regardless of the
  // viewer's locale ordering (e.g. en-GB would emit "19 Aug"), while the ABSENCE
  // of a `timeZone` option keeps both parts in the viewer's LOCAL zone. hour12
  // forces am/pm; the replace lowercases "AM"/"a.m."/… to "am"/"pm" and drops the
  // separating space so the output is exactly "11:42am".
  const time = d
    .toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hour12: true })
    .replace(/\s*([AaPp])\.?\s*[Mm]\.?$/, (_m, p) => p.toLowerCase() + "m");
  const date = d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  return time + " " + date;
}
/** @param {any} node */
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
/** @param {string} text
 * @returns {Promise<boolean>}
 */
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
/** @param {any} text */
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
/** @param {any} m
 * @returns {(() => void)|null}
 */
function openModal(m) {
  // Only one modal at a time — drop a second (e.g. double-click) open so we
  // never stack overlays or register duplicate document-level keydown handlers.
  // Return null (not a close fn) so a guarded caller (confirmModal) can tell the
  // open was dropped and resolve rather than hang.
  if (modalOpen) return null;
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
  // A dismissal (✕/Close button, backdrop, Escape, page switch) resolves with
  // m.dismissValue; an action button overrides it before closing. onResult fires
  // exactly once, from close(), so every exit path (button OR dismiss) reports a
  // result — this is what lets confirmModal() gate on a real user choice inside a
  // sandboxed iframe where native confirm() would silently return false (#276).
  const onResult = typeof m.onResult === "function" ? m.onResult : null;
  let resultValue = m.dismissValue;
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
    // A consumer-provided result callback must never abort teardown: if it throws,
    // swallow it so focus restoration below (and Escape/backdrop close) still runs.
    if (onResult) { try { onResult(resultValue); } catch (_e) {} }
    if (prevFocus instanceof HTMLElement && typeof prevFocus.focus === "function") prevFocus.focus();
  }
  // Focusable descendants of the dialog, in DOM order, for the Tab focus trap.
  /** @returns {any[]} */
  function focusables() {
    return Array.prototype.slice.call(dialog.querySelectorAll(
      'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
    )).filter((n) => !n.disabled);
  }
  /** @param {KeyboardEvent} ev */
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
  // Custom action buttons (m.actions) turn this into a decision dialog — each
  // sets the result then closes; the plain Close button is the default when none
  // are given. This is the in-DOM replacement for native confirm()/alert(): one
  // overlay + focus-trap + teardown machinery, no drift (AGENTS.md).
  let focusBtn = closeBtn;
  if (Array.isArray(m.actions) && m.actions.length) {
    let firstActionBtn = null;
    let defaultBtn = null;
    for (const a of m.actions) {
      const cls = "pc-btn pc-btn-sm" + (a.variant === "ghost" ? " pc-btn-ghost" : "");
      const ab = el("button", { class: cls, type: "button" }, a.label);
      ab.addEventListener("click", () => { resultValue = a.value; close(); });
      actions.append(ab);
      if (!firstActionBtn) firstActionBtn = ab;
      if (a.default) defaultBtn = ab;
    }
    // Default focus lands on the FIRST action (typically Cancel), never the last:
    // for confirmModal that keeps a stray Enter from accidentally triggering the
    // destructive Confirm. An action can opt into autofocus with default:true.
    focusBtn = defaultBtn || firstActionBtn;
  } else {
    actions.append(closeBtn);
  }
  dialog.append(actions);
  overlay.append(dialog);
  // A click on the backdrop (never the dialog itself) dismisses.
  overlay.addEventListener("click", /** @param {MouseEvent} ev */ (ev) => { if (ev.target === overlay) close(); });
  document.addEventListener("keydown", onKey);
  document.body.append(overlay);
  // A page switch runs teardown() before the next render — dispose the modal
  // there too so navigating away never leaves a stale overlay + keydown listener.
  disposers.push(close);
  focusBtn.focus();
  return close;
}

// In-DOM confirm — an accessible replacement for native confirm() that works in
// a sandboxed iframe (without allow-modals native confirm() silently returns
// false, dead-ending every confirm-guarded action; #276). Renders the message
// with Cancel/Confirm and resolves the user's choice; a dismissal (Escape /
// backdrop / ✕) resolves false. If a modal is already open the guarded open is
// dropped — resolve false so the caller doesn't hang.
/** @param {any} message
 * @returns {Promise<boolean>}
 */
function confirmModal(message) {
  return new Promise((resolve) => {
    const opened = openModal({
      title: "Confirm",
      description: String(message),
      dismissValue: false,
      actions: [
        { label: "Cancel", value: false, variant: "ghost" },
        { label: "Confirm", value: true },
      ],
      /** @param {any} v */
      onResult: (v) => resolve(!!v),
    });
    if (!opened) resolve(false);
  });
}

// In-DOM error surface — replaces native alert(), which a sandboxed iframe also
// suppresses, so action failures reported through it were invisible (#276).
/** @param {any} message */
function alertModal(message) {
  openModal({ title: "Error", description: String(message) });
}

// A standalone button node. Clicking it opens props.modal — used e.g. to surface
// a copy-pasteable "point your agent here" prompt. props.variant === "ghost"
// renders the muted outline style. A button without a modal is inert.
/** @param {any} node */
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
/** @param {any} page
 * @param {any} key
 * @returns {string}
 */
function pageHashHref(page, key) {
  const keyStr = key == null ? "" : String(key).trim();
  if (!safePageId(page) || keyStr === "") return "";
  return "#/" + encodeURIComponent(page) + "/" + encodeURIComponent(keyStr);
}

// Coerce a not-in-path value (issue #265) into a Set of stage keys. Accepts an
// array of keys or a comma/whitespace-separated string; null/undefined → empty
// set. Used to mark the stages a given row skips (dashed/omitted).
/** @param {any} v
 * @returns {Set<string>}
 */
function toStageSet(v) {
  // Trim + drop-empties on BOTH inputs so array entries with stray whitespace
  // (e.g. from CSV/JSON munging) match stages[].key just like the string path.
  if (Array.isArray(v)) return new Set(v.map((s) => String(s).trim()).filter((s) => s !== ""));
  if (v == null) return new Set();
  return new Set(String(v).split(/[\s,]+/).filter((s) => s !== ""));
}

/** @param {any} col
 * @param {Record<string, any>} row
 * @param {string} role
 * @returns {HTMLTableCellElement}
 */
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
  // Per-column display format (issue #327): an opt-in `col.format` transforms the
  // single-field value for display only (e.g. "datetime" → the viewer's local
  // time). rawText above stays untransformed so the badge gate/tooltip and any
  // sort/groupBy still key off the real field. A col.template composes its own
  // {{field}} tokens and therefore wins over the formatted field text below.
  const fieldText = col.format ? fmtCellValue(col.format, rawText) : rawText;
  // Visible text: a col.template (interpolated from the row) wins over the
  // formatted/raw field value, else the field value is shown verbatim.
  const text = typeof col.template === "string" ? interpTemplate(col.template, row) : fieldText;
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
        /** @param {MouseEvent} ev */
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
/** @param {any} primary
 * @param {string} primaryText
 * @param {string} subText
 * @param {boolean} truncate
 * @param {Record<string, any>} tdAttrs
 * @returns {HTMLTableCellElement}
 */
function cellTd(primary, primaryText, subText, truncate, tdAttrs) {
  const td = tdAttrs || {};
  if (subText === "" && !truncate) return el("td", td, primary);
  /** @type {Record<string, any>} */
  const mainAttrs = { class: "pc-cell-main" + (truncate ? " pc-truncate" : "") };
  if (truncate && primaryText !== "") {
    mainAttrs.title = primaryText; mainAttrs["aria-label"] = primaryText;
    if (primary && typeof primary.setAttribute === "function") {
      primary.setAttribute("title", primaryText); primary.setAttribute("aria-label", primaryText);
    }
  }
  const main = el("div", mainAttrs, primary);
  if (subText === "") return el("td", td, main);
  /** @type {Record<string, any>} */
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
/** @param {any[]} cols
 * @returns {string[]}
 */
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
/** @param {HTMLTableRowElement} tr */
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
//     badgeField:"attention",     // optional row field → badge text shown on the active stage
//     notInPathField:"skipped",   // optional row field → stages this row skips
//     notInPath:["converging"],   // static fallback used only when no field given
//     locus:{ field:"pr_key", stage?:"<key>",
//             link:{ kind:"page", page:"home" } } }  // optional out-link
// Rendering: stages BEFORE the active one are filled/completed, the active stage
// is lit (its treatment driven by stateField — success ✓ vs failure ✕ vs blocked
// ⊘ are made unmistakably distinct), in-path stages AFTER it are ghosted, and any
// stage in the row's not-in-path set is dashed. Reuses the .pc-badge and .pc-link
// classes and the shared pageHashHref route builder — no parallel implementations. Unknown or
// missing config (no stages array) degrades gracefully to plain cell text.
/** @param {{ stages?: any[], [key: string]: any }} col
 *  @param {Record<string, any>} row
 *  @param {string} text
 *  @param {string} subText
 *  @param {boolean} truncate
 *  @param {Record<string, any>} tdAttrs
 *  @returns {HTMLTableCellElement}
 */
function pipelineCell(col, row, text, subText, truncate, tdAttrs) {
  // Drop null/undefined entries defensively: a schema with a hole must still
  // render (never throws on s.key) — same graceful-degradation goal as below.
  /** @type {any[]} */
  const stages = Array.isArray(col.stages) ? col.stages.filter((s) => s != null) : [];
  // Graceful fallback: an unrecognised/empty pipeline config renders plain text,
  // exactly like an unknown link.kind — never throws.
  if (stages.length === 0) return cellTd(text, text, subText, truncate, tdAttrs);
  // The current stage's key, matched against stages[].key to find the active index.
  // The row value is trimmed for consistency with the other row-derived keys
  // (pageHashHref, toStageSet), so a whitespace-padded value still matches its stage
  // instead of leaving the whole track rendered as upcoming.
  // Stage keys identify a single stage, so stop at the first match: the result is
  // deterministic even if a config accidentally repeats a key, and we avoid scanning
  // the remaining stages on every row.
  const activeKey = col.activeField != null && row[col.activeField] != null ? String(row[col.activeField]).trim() : "";
  let activeIdx = -1;
  for (let i = 0; i < stages.length; i++) {
    if (String(stages[i].key) === activeKey) {
      activeIdx = i;
      break;
    }
  }
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
  // Optional active-stage badge (escalation/attention → warn, blocked/failure →
  // danger), reusing .pc-badge tone classes — no new badge styles. The badge text
  // is a single row-level value (row[badgeField]) shown only on the active stage.
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
    // Active wins over skip: if the active stage's key is also in the not-in-path
    // set, it must still render as the current step (active styling + aria-current),
    // never as skipped. Excluding activeIdx here keeps that precedence consistent
    // across the stage class, the aria-current mark, and the connector fill below.
    const skipped = i !== activeIdx && skip.has(String(s.key));
    // Connector between adjacent stages; filled up to and including the active
    // stage, but never across a not-in-path stage — a skipped predecessor breaks
    // the fill so we don't visually imply it was on the path.
    if (i > 0) {
      const filled =
        activeIdx >= 0 && i <= activeIdx && !skipped && !skip.has(String(stages[i - 1].key)) ? " filled" : "";
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
    /** @type {Record<string, any>} */
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
/** @param {any} stage */
function labelOf(stage) {
  return stage.label == null ? String(stage.key) : String(stage.label);
}

// Parse a "<number>%" width into its numeric percentage, or null if the string
// is not a bare percentage (e.g. "22rem", "120px") — used to decide whether the
// remainder left for weighted columns can be computed.
/** @param {string} width
 * @returns {number|null}
 */
function colWidthPct(width) {
  const m = /^\s*([0-9]*\.?[0-9]+)%\s*$/.exec(width);
  return m ? parseFloat(m[1]) : null;
}

// A column carries an explicit width only when it is a non-empty string. Single
// source of truth so colWidthStyle/buildColgroup can't drift on what "explicit"
// means (which columns win verbatim, consume the remainder, or use their weight).
/** @param {any} col */
function hasExplicitWidth(col) {
  return typeof col.width === "string" && col.width !== "";
}

// A column's <col> width for the grid's <colgroup>: an explicit col.width string
// ("40%", "22rem") wins verbatim; else a positive numeric col.weight is
// normalised across the weighted columns into a percentage share of the width
// left over by explicit columns (remainderPct); else null (no width — the column
// shares the remainder equally under table-layout:fixed).
/** @param {any} col
 * @param {number} weightTotal
 * @param {number} remainderPct
 * @returns {string|null}
 */
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
/** @param {any[]} cols
 * @param {number} extraCount
 * @returns {HTMLTableColElement|null}
 */
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

/** @param {any} node */
function renderActionForm(node) {
  /** @type {any} */
  const p = node.props;
  const card = el("section", { class: "pc-card" });
  if (p.title) card.append(el("h2", {}, p.title));
  // Map/null-proto stores so a schema field keyed __proto__/constructor can't
  // pollute Object.prototype or shadow inherited props (prototype-pollution class).
  /** @type {Map<string, HTMLInputElement>} */
  const inputs = new Map();
  /** @type {Map<string, string>} */
  const fieldTypes = new Map();
  // Client-side required-field validation state: the set of required keys, each
  // field's custom message, and its inline error node (populated on a blocked
  // submit, cleared as soon as the user edits the field).
  /** @type {Set<string>} */
  const required = new Set();
  /** @type {Map<string, string>} */
  const reqMsg = new Map();
  /** @type {Map<string, HTMLElement>} */
  const errs = new Map();
  // A required field's label carries a danger-toned "*" so the requirement is
  // visible BEFORE submit; spread into el(...) — an empty array adds no child.
  /** @param {any} f
   * @returns {HTMLElement[]}
   */
  const reqMark = (f) => (f.required === true ? [el("span", { class: "pc-req", title: "Required" }, " *")] : []);
  // Register a field's inline error node and, when required, mark the input
  // (aria-required) and wire a clear-on-edit handler so a hint disappears the
  // moment the user starts fixing it. Editing a required field also clears the
  // blocked-submit summary ("Please fill in the required fields.") so it never
  // lingers as a stale/misleading banner while the user is correcting input.
  /** @param {any} f
   * @param {HTMLInputElement} input
   * @param {HTMLElement} ferr
   * @param {string} evt
   */
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
    /** @type {Record<string, any>} */
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
/** @param {number} n */
function rowCountLabel(n) { return n + (n === 1 ? " row" : " rows"); }

// Build the /app/data/<source>/<table> URL a data-bound list renderer fetches,
// threading the whitelisted where/order query params. Shared by dataGrid and the
// prose renderer so the two can't drift on how a filter/orderBy is encoded. A
// filter is { field, in:[…] } (IN set), { field, eqParam:true } (bound to the
// current route PARAM — "show the selected entity's rows"), or { field, eq } (a
// literal equals); orderBy is { field, dir }. The source/table/field names are
// server-side whitelisted (the /app/data route rejects unknown columns).
/** @param {string} source
 * @param {string} tbl
 * @param {any[]} filters
 * @param {any} order
 */
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

// ── Minimal, safe Markdown → DOM (no innerHTML) — used by the prose renderer ──
// A dependency-free CommonMark subset. It NEVER sets innerHTML: every block and
// inline token is materialised as a known element via el(), with text set through
// textContent / createTextNode — so a record's body field may carry markdown
// WITHOUT ever becoming an HTML/script injection vector (the same text-only
// guarantee interpTemplate gives a grid cell). Supported: ATX headings
// (#..######), fenced + inline code, bold (**/__), italic (*/_), links
// [text](url) (http/https/mailto only — every other scheme degrades to its plain
// label), unordered (-,*,+) and ordered (1. / 1)) lists, blockquotes (>),
// thematic breaks (---), and blank-line-separated paragraphs. MD_BACKTICK is the
// backtick that delimits code spans/fences.
const MD_BACKTICK = "`";
/** @param {any} c */
function mdIsWordChar(c) { return typeof c === "string" && /[0-9A-Za-z]/.test(c); }
// Only http(s)/mailto hrefs become anchors; anything else (javascript:, data:,
// vbscript:, a bare relative path, …) returns "" so the caller renders the label
// as plain text rather than a clickable, potentially-hostile link.
/** @param {any} href */
function mdSafeHref(href) {
  const h = String(href == null ? "" : href).trim();
  return /^(?:https?:|mailto:)/i.test(h) ? h : "";
}
// Find the closing run of 'marker' at or after 'from'. For underscore emphasis the
// close must not be intra-word (a following alphanumeric means snake_case, not a
// delimiter), so keep scanning past such runs; -1 when there is no valid close.
/** @param {string} s
 * @param {string} marker
 * @param {number} from
 * @param {boolean} underscore
 */
function mdFindClose(s, marker, from, underscore) {
  let j = from;
  while (true) {
    const k = s.indexOf(marker, j);
    if (k < 0) return -1;
    if (!underscore || !mdIsWordChar(s[k + marker.length])) return k;
    j = k + marker.length;
  }
}
/** @param {any} text
 * @returns {Array<Node|string>}
 */
function mdInline(text) {
  const s = String(text == null ? "" : text);
  /** @type {Array<Node|string>} */
  const nodes = [];
  let buf = "";
  const flush = () => { if (buf) { nodes.push(document.createTextNode(buf)); buf = ""; } };
  let i = 0;
  while (i < s.length) {
    const ch = s[i];
    // Backslash escape: the next char is emitted literally, never as a delimiter.
    if (ch === "\\" && i + 1 < s.length) { buf += s[i + 1]; i += 2; continue; }
    // Inline code span — verbatim, no nested inline parsing.
    if (ch === MD_BACKTICK) {
      const end = s.indexOf(MD_BACKTICK, i + 1);
      if (end > i) { flush(); nodes.push(el("code", { class: "pc-md-code" }, s.slice(i + 1, end))); i = end + 1; continue; }
    }
    // Strong (** or __). Underscore only when it opens on a word boundary so an
    // identifier like a__b doesn't get mangled into emphasis.
    if ((ch === "*" || ch === "_") && s[i + 1] === ch) {
      const underscore = ch === "_";
      if (!underscore || !mdIsWordChar(s[i - 1])) {
        const marker = ch + ch;
        const end = mdFindClose(s, marker, i + 2, underscore);
        if (end > i + 1) { flush(); nodes.push(el("strong", {}, ...mdInline(s.slice(i + 2, end)))); i = end + 2; continue; }
      }
    }
    // Emphasis (* or _), same word-boundary guard for underscore.
    if (ch === "*" || ch === "_") {
      const underscore = ch === "_";
      if (!underscore || !mdIsWordChar(s[i - 1])) {
        const end = mdFindClose(s, ch, i + 1, underscore);
        if (end > i + 1) { flush(); nodes.push(el("em", {}, ...mdInline(s.slice(i + 1, end)))); i = end + 1; continue; }
      }
    }
    // Link [label](href): href sanitised; an unsafe scheme drops to the label text.
    if (ch === "[") {
      const close = s.indexOf("]", i + 1);
      if (close > i && s[close + 1] === "(") {
        const paren = s.indexOf(")", close + 2);
        if (paren > close) {
          const href = mdSafeHref(s.slice(close + 2, paren));
          const label = mdInline(s.slice(i + 1, close));
          flush();
          if (href) nodes.push(el("a", { href: href, target: "_blank", rel: "noopener noreferrer" }, ...label));
          else for (const l of label) nodes.push(l);
          i = paren + 1; continue;
        }
      }
    }
    buf += ch; i++;
  }
  flush();
  return nodes;
}
// Regexes that classify a block-opening line; shared by the block loop and the
// paragraph terminator so the two can't disagree on where a paragraph ends.
const MD_HEADING = /^(#{1,6})\s+(.*)$/;
const MD_QUOTE = /^>\s?/;
const MD_UL = /^[-*+]\s+/;
const MD_OL = /^\d+[.)]\s+/;
const MD_HR = /^([-*_])(?:\s*\1){2,}\s*$/;
/** @param {string} t */
function mdBlockStart(t) {
  return t.slice(0, 3) === MD_BACKTICK + MD_BACKTICK + MD_BACKTICK
    || MD_HEADING.test(t) || MD_QUOTE.test(t) || MD_UL.test(t) || MD_OL.test(t) || MD_HR.test(t);
}
// Parse a markdown string into an array of block-level DOM nodes.
/** @param {any} src
 * @returns {HTMLElement[]}
 */
function mdToNodes(src) {
  /** @type {HTMLElement[]} */
  const out = [];
  const fence = MD_BACKTICK + MD_BACKTICK + MD_BACKTICK;
  const lines = String(src == null ? "" : src).replace(/\r\n?/g, "\n").split("\n");
  let i = 0;
  while (i < lines.length) {
    const t = lines[i].trim();
    if (t === "") { i++; continue; }
    // Fenced code block — content is verbatim (no inline parsing).
    if (t.slice(0, 3) === fence) {
      const body = [];
      i++;
      while (i < lines.length && lines[i].trim().slice(0, 3) !== fence) { body.push(lines[i]); i++; }
      if (i < lines.length) i++; // consume the closing fence
      out.push(el("pre", { class: "pc-md-pre" }, el("code", {}, body.join("\n"))));
      continue;
    }
    // Thematic break (checked before lists so "***"/"---" isn't read as a bullet).
    if (MD_HR.test(t)) { out.push(el("hr", { class: "pc-md-hr" })); i++; continue; }
    // ATX heading.
    const h = MD_HEADING.exec(t);
    if (h) { out.push(el("h" + h[1].length, { class: "pc-md-h" }, ...mdInline(h[2].trim()))); i++; continue; }
    // Blockquote — strip one '>' per line and re-parse the inner block(s).
    if (MD_QUOTE.test(t)) {
      const inner = [];
      while (i < lines.length && MD_QUOTE.test(lines[i].trim())) { inner.push(lines[i].trim().replace(MD_QUOTE, "")); i++; }
      const bq = el("blockquote", { class: "pc-md-quote" });
      for (const b of mdToNodes(inner.join("\n"))) bq.append(b);
      out.push(bq); continue;
    }
    // Unordered list.
    if (MD_UL.test(t)) {
      const ul = el("ul", { class: "pc-md-list" });
      while (i < lines.length && MD_UL.test(lines[i].trim())) {
        ul.append(el("li", {}, ...mdInline(lines[i].trim().replace(MD_UL, ""))));
        i++;
      }
      out.push(ul); continue;
    }
    // Ordered list.
    if (MD_OL.test(t)) {
      const ol = el("ol", { class: "pc-md-list" });
      while (i < lines.length && MD_OL.test(lines[i].trim())) {
        ol.append(el("li", {}, ...mdInline(lines[i].trim().replace(MD_OL, ""))));
        i++;
      }
      out.push(ol); continue;
    }
    // Paragraph — soft-wrapped lines joined with a space until a blank line or the
    // next block opener.
    const para = [];
    while (i < lines.length) {
      const lt = lines[i].trim();
      if (lt === "" || mdBlockStart(lt)) break;
      para.push(lt); i++;
    }
    out.push(el("p", { class: "pc-md-p" }, ...mdInline(para.join(" "))));
  }
  return out;
}

// A data-bound prose/markdown list (#274). Binds a datasource like dataGrid
// (props.data = { source, table, orderBy, filter }) but renders each row as a
// stacked prose block — a small header template (props.header, e.g.
// "Round {{round}} · {{approved}}") over one body field (props.body) rendered as
// sanitised markdown at a comfortable measure (props.measure ch, ~66 default).
// This is the primitive for narrative records (plan-review findings, coordination
// notes, escalation bodies) that read as a document, not a squeezed table cell.
// It inherits collapsible/defaultCollapsed for free via makeCollapsible (which
// unwraps the <h2> title), and refreshMs polling + pc:refresh like dataGrid.
/** @param {any} node */
function renderProse(node) {
  const p = node.props || {};
  const data = p.data || {};
  const card = el("section", { class: "pc-card" });
  if (p.title) card.append(el("h2", {}, p.title));
  const listEl = el("div", { class: "pc-prose-list" });
  card.append(listEl);
  const headerTpl = typeof p.header === "string" ? p.header : null;
  const bodyField = p.body;
  // Clamp the reading measure to a sane range so a malformed schema can't set a
  // 5000ch (full-bleed) or 2ch (one-word-per-line) body. ~66ch is the default.
  let measure = Number(p.measure);
  if (!Number.isFinite(measure)) measure = 66;
  measure = Math.max(40, Math.min(100, Math.round(measure)));
  /** @type {any[]} */
  const activeFilter = Array.isArray(data.filter) ? data.filter : [];

  /** @param {Record<string, any>} row */
  function itemFor(row) {
    const item = el("article", { class: "pc-prose-item" });
    if (headerTpl) item.append(el("div", { class: "pc-prose-head" }, interpTemplate(headerTpl, row)));
    const bodyEl = el("div", { class: "pc-prose-body", style: "max-width:" + measure + "ch" });
    // Own-property gate (matching interpTemplate) so a body field name that
    // collides with a prototype key can't pick up prototype cruft.
    const raw = bodyField != null && Object.prototype.hasOwnProperty.call(row, bodyField) && row[bodyField] != null
      ? String(row[bodyField])
      : "";
    for (const b of mdToNodes(raw)) bodyEl.append(b);
    item.append(bodyEl);
    return item;
  }

  async function refresh() {
    try {
      // A param-scoped list ("show the selected entity's records") with no route
      // param present renders nothing rather than a field=empty-string query.
      const paramScoped = (activeFilter || []).some((f) => f && f.eqParam);
      /** @type {{ rows: Array<Record<string, any>> }} */
      /** @type {{ rows: Array<Record<string, any>> }} */
      const { rows } = paramScoped && PARAM === ""
        ? { rows: [] }
        : await getJSON(dataUrl(data.source, data.table, activeFilter, data.orderBy));
      listEl.replaceChildren();
      if (!rows.length) { listEl.append(el("p", { class: "pc-prose-empty" }, p.empty || "No records")); return; }
      for (const row of rows) listEl.append(itemFor(row));
    } catch (e) {
      listEl.replaceChildren(el("p", { class: "pc-msg err" }, String((e && e.message) || e)));
    }
  }
  document.addEventListener("pc:refresh", refresh);
  disposers.push(() => document.removeEventListener("pc:refresh", refresh));
  if (p.refreshMs && p.refreshMs > 0) {
    const timer = setInterval(refresh, p.refreshMs);
    disposers.push(() => clearInterval(timer));
  }
  refresh();
  return card;
}

// Build a detail/escalation answer form for a single grid row. This is the ONE
// implementation of the `detail.form` contract — shared verbatim by the
// top-level grid's detail panel AND a dataGrid child-grid row (#333) so the two
// can never drift. The form has a single free-text field (f.inputKey), an
// optional prompt echoed from the row (f.promptField), and a route-driven submit
// (f.action) whose path/body interpolate {{form.*}} / {{row.*}} tokens. It
// renders only when the row's f.showWhenField is truthy (an answerable
// escalation), returning null otherwise. On a successful submit it invokes
// onSuccess — the top-level grid re-polls the whole page (pc:refresh) so the
// answered row drops out on the next tick; a child grid re-fetches just its own
// rows, matching the Tasks page where the row disappears once its user-task
// completes.
// A disclosure chevron for expanding an inline detail row. This is the ONE place
// a "▸/▾" toggle button is built, so the glyph and its `aria-expanded` state can
// never drift apart (they used to be set independently, leaving assistive tech
// unaware a row had opened). Every chevron gets an explicit type="button" (so it
// never submits an enclosing form) and an accessible name.
/** @param {string} [label] @returns {HTMLElement} */
function chevronToggle(label) {
  return el("button", {
    class: "pc-btn pc-btn-sm pc-chevron",
    type: "button",
    "aria-label": label || "Toggle details",
    "aria-expanded": "false",
  }, "▸");
}
// Set a chevron's open/closed state, keeping the glyph and aria-expanded in lock-step.
/** @param {HTMLElement} btn @param {boolean} open */
function setChevronOpen(btn, open) {
  btn.textContent = open ? "▾" : "▸";
  btn.setAttribute("aria-expanded", String(open));
}

/** @param {any} f
 *  @param {Record<string, any>} row
 *  @param {() => void | Promise<void>} onSuccess
 *  @returns {HTMLElement|null}
 */
function buildDetailForm(f, row, onSuccess) {
  if (!f || !row[f.showWhenField]) return null;
  const box = el("div", { class: "pc-subform" });
  if (f.title) box.append(el("div", { class: "pc-subform-title" }, f.title));
  if (f.promptField && row[f.promptField] != null) {
    box.append(el("div", { class: "pc-prompt" }, String(row[f.promptField])));
  }
  const input = el("textarea", { class: "pc-textarea", placeholder: f.inputLabel || f.inputKey, "aria-label": f.inputLabel || f.inputKey });
  // role=status + aria-live so the "Sending…"/success/error transitions are
  // announced to screen readers instead of silently changing text.
  const msg = el("p", { class: "pc-msg", role: "status", "aria-live": "polite" });
  const btn = el("button", { class: "pc-btn pc-btn-sm", type: "button" }, f.submitLabel || "Submit");
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
      // Await onSuccess so a refresh that rejects (e.g. a child grid's re-fetch
      // failing) is surfaced here and re-enables the button below, instead of the
      // operator being stuck on a permanently-disabled button with a silent
      // failure. On success the refresh detaches/rebuilds this form, so leaving
      // the button disabled is moot; we only re-enable on the error path.
      await onSuccess();
    } catch (e) {
      btn.disabled = false; msg.className = "pc-msg err"; msg.textContent = String(e.message || e);
    }
  });
  box.append(el("div", { class: "pc-field" }, input), btn, msg);
  return box;
}

/** @param {any} node */
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
  /** @type {any[]} */
  const cols = p.columns || [];
  // Mobile card roles per column (derived by convention, refined by
  // col.mobile.priority) so the grid can flip to a stacked card list on a phone
  // (#268). 'hasHidden' gates the per-row "More" toggle that reveals the columns
  // a mobile:{priority:"hidden"} hint drops off the card.
  const roles = classifyColumns(cols);
  const hasHidden = roles.indexOf("hidden") >= 0;
  /** @type {any[]} */
  const tabs = p.tabs || [];
  /** @type {any[]} */
  const rowActions = p.rowActions || [];
  const detail = p.detail || null;
  const hasExtra = rowActions.length > 0 || detail != null;
  /** @type {any[]} */
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
  /** @param {Record<string, any>} row
   * @returns {string|null}
   */
  const rowKeyOf = (row) => {
    if (!p.rowKey) return null;
    const v = row[p.rowKey];
    return v == null ? null : String(v);
  };

  /** @param {any} action
   * @param {Record<string, any>} row
   */
  async function fireAction(action, row) {
    // Route-driven row action: POST the action's body template (default {})
    // to its route path, with {{row.KEY}} tokens resolved from this row.
    return runRoute(action, { row });
  }

  /** @param {Record<string, any>} row
   * @param {any} ra
   * @returns {HTMLButtonElement|null}
   */
  function rowActionButton(row, ra) {
    if (ra.showWhenField && !row[ra.showWhenField]) return null;
    const b = el("button", { class: "pc-btn pc-btn-sm" }, ra.label);
    b.addEventListener("click", /** @param {MouseEvent} ev */ async (ev) => {
      ev.stopPropagation();
      // In-DOM confirm/error (openModal) instead of native confirm()/alert():
      // a sandboxed iframe without allow-modals makes native confirm() return
      // false and alert() a no-op, so every confirm-guarded action silently
      // dead-ended and its errors vanished (#276).
      if (ra.confirm && !(await confirmModal(ra.confirm))) return;
      b.disabled = true;
      try {
        await fireAction(ra.action, row);
        document.dispatchEvent(new CustomEvent("pc:refresh"));
      } catch (e) {
        b.disabled = false;
        alertModal(String(e.message || e));
      }
    });
    return b;
  }

  /** @param {any} cg
   * @param {Record<string, any>} row
   */
  async function childGrid(cg, row) {
    const wrap = el("div", { class: "pc-child" });
    if (cg.title) wrap.append(el("div", { class: "pc-child-title" }, cg.title));
    /** @type {any[]} */
    const ccols = cg.columns || [];
    const croles = classifyColumns(ccols);
    const chasHidden = croles.indexOf("hidden") >= 0;
    // Per-row expansion for child grids: a `detail` (alias `expandable`) block
    // gives each child row a chevron that reveals the same detailPanel() content
    // the top-level grid uses (link + fields + nested child grids + form). Rows are
    // collapsed by default; `detail.defaultCollapsed`/`detail.collapsed` (default
    // true) seeds the initial state, and — when the child grid declares a `rowKey`
    // — the per-row collapse is persisted in localStorage keyed by page + node +
    // parent rowKey + child rowKey, so it survives the top-level grid's refresh
    // poll (which rebuilds this whole subtree) and a full reload, mirroring how
    // groupBy group-collapse is persisted. Absent a `detail` block the child grid
    // is byte-for-byte unchanged (backward compatible). A `detail.form` (#333) is
    // rendered inside that panel by the shared detailPanel/buildDetailForm, and its
    // submit re-fetches only this child grid (see load() below) rather than the
    // whole page — so answering a nested escalation drops the answered row without
    // disturbing the parent grid.
    const cdetail = cg.detail || cg.expandable || null;
    const chasExpand = cdetail != null;
    const cextra = (cg.lazyField ? 1 : 0) + (chasExpand ? 1 : 0);
    const cdefaultCollapsed = chasExpand
      ? (cdetail.defaultCollapsed != null
        ? !!cdetail.defaultCollapsed
        : cdetail.collapsed != null
          ? !!cdetail.collapsed
          : true)
      : true;
    const cnodeId = node.id || p.title || "grid";
    const cchildId = cg.node || cg.table || cg.title || "child";
    // The parent-row discriminator is the value this child grid is queried by
    // (row[cg.parentField]) — NOT the top-level grid's rowKey. That keeps per-row
    // collapse state unique per parent row even when the parent grid declares no
    // rowKey (rowKeyOf(row) would then be null and every parent row would collide
    // under the literal "_"). When no parent discriminator is available there is no
    // safe key, so persistence is disabled (ckeyBase null) instead of colliding.
    const cparentKey = cg.parentField != null && row[cg.parentField] != null
      ? String(row[cg.parentField]) : null;
    const ckeyBase = cparentKey == null ? null
      : "pc:collapsed:" + CURRENT + ":" + cnodeId + ":" + cchildId + ":" + cparentKey + ":r:";
    /** @param {Record<string, any>} cr @returns {string|null} */
    const crowKeyOf = (cr) => {
      if (!cg.rowKey) return null;
      const v = cr[cg.rowKey];
      return v == null ? null : String(v);
    };
    const cbody = el("tbody", {});
    const ccolgroup = buildColgroup(ccols, cextra);
    const cthead = el("thead", {}, el("tr", {}, ...ccols.map((c) => el("th", {}, c.header || c.field)),
      ...(cg.lazyField ? [el("th", {}, "")] : []),
      ...(chasExpand ? [el("th", {}, "")] : [])));
    const ctable = ccolgroup
      ? el("table", { class: "pc-grid" }, ccolgroup, cthead, cbody)
      : el("table", { class: "pc-grid" }, cthead, cbody);
    wrap.append(ctable);
    // Compute the colspan eagerly (before the fetch) so BOTH the success path and
    // the catch's error row have a valid, table-spanning colspan — if getJSON()
    // throws, a lazily-assigned cspan would still be undefined here.
    const cspan = String((ccols.length || 1) + cextra);
    // Re-fetch and repaint just this child grid's rows. Wired to the child detail
    // panel's form onSuccess so answering a nested escalation drops the row once
    // its user-task completes — the child-scoped mirror of the top-level grid's
    // pc:refresh re-poll, without disturbing the parent grid or its other detail
    // rows (which a global pc:refresh would leave untouched anyway, since open
    // detail rows are reused across the poll).
    async function load() {
      /** @type {{ rows: Array<Record<string, any>> }} */
      const { rows } = await getJSON(dataUrl(cg.source || "app", cg.table,
        [{ field: cg.childField, eq: row[cg.parentField] }], cg.orderBy));
      cbody.replaceChildren();
      if (!rows.length) {
        cbody.append(el("tr", {}, el("td", { colspan: cspan }, "None")));
        return;
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
        // Per-row expander cell (trailing, after any lazyField cell): a chevron
        // that reveals this row's detailPanel in a following full-width row. The
        // panel is built lazily on first open (and eagerly when the row starts
        // expanded), matching the top-level grid. The panel's escalation form (if
        // any) is wired to load() so answering it re-fetches only this child grid.
        // The chevron uses the shared chevronToggle()/setChevronOpen() so its glyph
        // and aria-expanded stay in lock-step for assistive tech.
        /** @type {any} */
        let cdtr = null;
        if (chasExpand) {
          const crk = crowKeyOf(cr);
          const cskey = ckeyBase && crk != null ? ckeyBase + crk : null;
          const collapsed = cskey ? readCollapsed(cskey, cdefaultCollapsed) : cdefaultCollapsed;
          const ctoggle = chevronToggle("Toggle row details");
          setChevronOpen(ctoggle, !collapsed);
          cells.push(el("td", { class: "pc-row-actions" }, ctoggle));
          cdtr = el("tr", { hidden: collapsed ? "" : null }, el("td", { colspan: cspan }));
          let built = false;
          const build = () => {
            // Return the reload promise (don't swallow it) so buildDetailForm can
            // surface a failed re-fetch and re-enable its submit button instead of
            // leaving the operator stuck on a false "Sent".
            if (!built) { built = true; cdtr.firstChild.append(detailPanel(cr, cdetail, () => load())); }
          };
          if (!collapsed) build();
          ctoggle.addEventListener("click", /** @param {MouseEvent} ev */ (ev) => {
            ev.stopPropagation();
            const open = cdtr.hidden;
            cdtr.hidden = !open;
            setChevronOpen(ctoggle, open);
            if (open) build();
            if (cskey) writeCollapsed(cskey, !open);
          });
        }
        // Child grids classify columns into the same mobile roles (including
        // "hidden") as the top-level grid, so they need the same per-row "More"
        // toggle — without it a mobile:{priority:"hidden"} child column would be
        // permanently unreachable on a narrow viewport (#268).
        const ctr = el("tr", {}, ...cells);
        if (chasHidden) ctr.append(mobileMoreCell(ctr));
        cbody.append(ctr);
        if (cdtr) cbody.append(cdtr);
      }
    }
    try {
      await load();
    } catch (e) {
      cbody.replaceChildren(el("tr", {}, el("td", { colspan: cspan }, String(e.message || e))));
    }
    return wrap;
  }

  /** Build an expandable-row detail panel. Used by the top-level grid (with the
   * closure `detail` config) and by child grids (which pass their own `cg.detail`
   * as `cfg`) so both share one look/behaviour — link, fields, nested child grids
   * and an optional escalation form.
   * @param {Record<string, any>} row
   * @param {any} [cfg] detail config; defaults to the top-level grid's `detail`
   * @param {(() => void)} [onSuccess] invoked after the panel's escalation form
   *   submits successfully. Defaults to a whole-page `pc:refresh` re-poll (the
   *   top-level grid's behaviour); a child grid passes a child-scoped reload so
   *   answering a nested escalation refreshes only that child grid, not the page.
   */
  function detailPanel(row, cfg, onSuccess) {
    const d = cfg || detail;
    const box = el("div", { class: "pc-detail" });
    if (d.linkField && row[d.linkField]) {
      const href = String(row[d.linkField]);
      // Render as a link only for http(s); anything else (e.g. a javascript: URL
      // smuggled through row data) is shown as inert text. External links get
      // rel="noopener noreferrer" so the opened page can't reach window.opener.
      if (/^https?:\/\//i.test(href)) {
        box.append(el("a", { class: "pc-link", href, target: "_blank", rel: "noopener noreferrer" }, href));
      } else {
        box.append(el("span", { class: "pc-link" }, href));
      }
    }
    for (const df of d.fields || []) {
      box.append(el("div", { class: "pc-detail-field" },
        el("span", { class: "pc-detail-label" }, df.label || df.field),
        el("span", {}, row[df.field] == null ? "" : String(row[df.field]))));
    }
    for (const cg of d.children || []) {
      const holder = el("div", {});
      box.append(holder);
      childGrid(cg, row).then((w) => holder.replaceChildren(w));
    }
    const form = buildDetailForm(d.form, row, onSuccess || (() => { document.dispatchEvent(new CustomEvent("pc:refresh")); }));
    if (form) box.append(form);
    return box;
  }

  /** @param {Record<string, any>} row
   * @param {Array<{ tr: HTMLTableRowElement, isDetail: boolean, key: string|null }>|null} sink
   */
  function renderRow(row, sink) {
    const cells = cols.map((c, i) => gridCell(c, row, roles[i]));
    const key = rowKeyOf(row);
    let toggle = null;
    if (hasExtra) {
      const actionCell = el("td", { class: "pc-row-actions" });
      if (detail) {
        toggle = chevronToggle("Toggle row details");
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
      setChevronOpen(toggle, !dtr.hidden);
      toggle.addEventListener("click", /** @param {MouseEvent} ev */ (ev) => {
        ev.stopPropagation();
        const open = dtr.hidden;
        dtr.hidden = !open;
        setChevronOpen(toggle, open);
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
  /** @param {Array<Record<string, any>>} rows */
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
      /** @type {Array<{ tr: HTMLTableRowElement, isDetail: boolean, key: string|null }>} */
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
    const a = /** @type {any} */ (document.activeElement);
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
        /** @type {Set<string>} */
        const live = new Set();
        for (const r of rows) { const k = rowKeyOf(r); if (k != null) live.add(k); }
        for (const k of [...detailNodes.keys()]) if (!live.has(k)) detailNodes.delete(k);
        for (const k of [...expanded]) if (!live.has(k)) expanded.delete(k);
      }
      // Capture focus + caret before the DOM swap. replaceChildren() detaches (and so blurs)
      // the reused detail node; re-appending it restores its value but not its focus. If the
      // very same node is re-attached (an open, still-present row), put the caret back.
      const active = /** @type {any} */ (document.activeElement);
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
      /** @type {Array<[any, number, number]>} */
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
          try { const s = /** @type {Selection} */ (document.getSelection()); s.removeAllRanges(); s.addRange(savedRange); } catch (e) { /* selection unavailable */ }
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
// lists every page from the /app/pages index, using each page's title. An item
// may also carry a `badge` ({ source, table, filter, tone, refreshMs,
// hideWhenZero }) that renders a live count pill from the /app/data gateway.
/** @param {any} item
 * @returns {HTMLAnchorElement|null}
 */
function navLink(item) {
  const isPage = safePageId(item.page);
  const isExt = !isPage && typeof item.href === "string" && /^https?:\/\//i.test(item.href);
  if (!isPage && !isExt) return null;
  /** @type {Record<string, any>} */
  const attrs = { class: "pc-nav-link" };
  if (isPage) {
    attrs.href = "#/" + encodeURIComponent(item.page);
    if (item.page === CURRENT) { attrs.class += " active"; attrs["aria-current"] = "page"; }
  } else {
    attrs.href = item.href; attrs.target = "_blank"; attrs.rel = "noopener noreferrer";
  }
  /** @type {Array<Node|string>} */
  const kids = [];
  if (item.icon != null) kids.push(el("span", { class: "pc-nav-icon" }, String(item.icon)));
  const labelText = String(item.label != null ? item.label : (item.page || item.href));
  kids.push(el("span", { class: "pc-nav-label" }, labelText));
  const link = el("a", attrs, ...kids);
  // A nav item may carry a live count badge sourced from a datasource (e.g. the
  // Tasks tab showing how many escalations await a human). It reuses the same
  // /app/data gateway + .pc-badge tone pills as dataGrid, and polls on refreshMs.
  // Absent/invalid badge → the link is exactly as before (backward compatible).
  wireNavBadge(link, labelText, item.badge);
  return link;
}

// Attach + drive a nav item's live count badge. Best-effort throughout: a bad
// config or a failed fetch degrades to no badge, never a broken nav link. The
// pill is appended hidden and only appears once a fetch yields a count (and, when
// hideWhenZero, only when that count is > 0). The accessible name of the whole
// link is kept in sync ("Tasks (3 open)") so assistive tech announces the count,
// which the small "3" glyph alone would not convey; the pill itself is aria-hidden
// to avoid a double announcement.
/** @param {HTMLElement} link
 * @param {string} baseLabel
 * @param {any} badge
 */
function wireNavBadge(link, baseLabel, badge) {
  if (!badge || typeof badge !== "object") return;
  if (typeof badge.table !== "string" || badge.table === "") return;
  const source = typeof badge.source === "string" && badge.source !== "" ? badge.source : "app";
  const t = badge.tone;
  const tone = t === "warn" || t === "ok" || t === "info" || t === "danger" ? t : "danger";
  const hideWhenZero = badge.hideWhenZero === true;
  const pill = el("span", { class: "pc-badge pc-nav-badge pc-badge-" + tone, "aria-hidden": "true" });
  pill.hidden = true;
  link.append(pill);
  const filter = Array.isArray(badge.filter) ? badge.filter : [];
  const paramScoped = filter.some(/** @param {any} f */(f) => f && f.eqParam);
  const refresh = () => {
    // A param-scoped badge ("count for the selected entity") with no route param
    // present would otherwise build the URL with dataUrl baking in an empty PARAM
    // and query field="", surfacing a wrong count. Match the dataGrid/list pollers:
    // degrade to 0 (hidden when hideWhenZero) without a request instead.
    if (paramScoped && PARAM === "") {
      applyNavBadge(link, pill, baseLabel, hideWhenZero, 0);
      return;
    }
    const url = dataUrl(source, badge.table, filter, null);
    const countUrl = url + (url.indexOf("?") >= 0 ? "&" : "?") + "count=1";
    getJSON(countUrl)
      .then(/** @param {any} res */(res) => applyNavBadge(link, pill, baseLabel, hideWhenZero, res && res.count))
      .catch(() => applyNavBadge(link, pill, baseLabel, hideWhenZero, NaN));
  };
  refresh();
  const ms = Number(badge.refreshMs);
  if (Number.isFinite(ms) && ms > 0) {
    const timer = setInterval(refresh, ms);
    disposers.push(() => clearInterval(timer));
  }
}

// Reflect a fetched count into the pill + the link's accessible name. A
// non-finite/negative count (a failed or malformed fetch) hides the pill and
// restores the plain label — the nav degrades quietly rather than showing a
// broken/"NaN" badge. hideWhenZero also hides the pill at exactly 0.
/** @param {HTMLElement} link
 * @param {any} pill
 * @param {string} baseLabel
 * @param {boolean} hideWhenZero
 * @param {any} count
 */
function applyNavBadge(link, pill, baseLabel, hideWhenZero, count) {
  const n = Number(count);
  if (!Number.isFinite(n) || n < 0 || (n === 0 && hideWhenZero)) {
    pill.hidden = true;
    pill.textContent = "";
    link.setAttribute("aria-label", baseLabel);
    return;
  }
  const shown = String(Math.floor(n));
  pill.hidden = false;
  pill.textContent = shown;
  const aria = baseLabel + " (" + shown + " open)";
  pill.setAttribute("title", aria);
  link.setAttribute("aria-label", aria);
}
/** @param {HTMLElement} list
 * @param {any[]} items
 */
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
/** @param {any} node */
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
      .then((res) => fillNav(list, (res.pages || []).map(/** @param {any} pg */ (pg) => ({ label: pg.title || pg.id, page: pg.id }))))
      .catch(() => list.append(el("span", { class: "pc-nav-empty" }, "No pages")));
  }
  return nav;
}

// The browser renderer's dispatch table: the runtime source of truth for which
// page-node types can be drawn. `@satisfies Record<PageNodeType, Renderer>` locks
// it, at compile time, to `@nanobpm/nano-app-schema`'s PAGE_NODE_TYPES — the same
// registry the Console's Page Composer is bound to. Adding a schema node type
// without a renderer here (or vice-versa) is now a type error, so the table can
// no longer silently drift from the schema (this replaces the #290 regex guard,
// which had to string-scrape these keys precisely because this used to be a
// string). The drift is also covered by a real-import unit test.
/** @satisfies {Record<PageNodeType, Renderer>} */
const RENDERERS = { text: renderText, actionForm: renderActionForm, dataGrid: renderDataGrid, prose: renderProse, nav: renderNav, button: renderButton };

// Durable per-node UI state. localStorage is keyed by the home page id + node
// id so two grids on the same page (or the same grid across pages) don't clash,
// and the collapsed state survives a full reload / new session — not just the
// refresh poll. Every access is guarded: private-mode or storage-disabled
// browsers throw on localStorage, and a UI preference must never break render.
/** @param {string} key
 * @param {boolean} dflt
 */
function readCollapsed(key, dflt) {
  try {
    const v = localStorage.getItem(key);
    return v === null ? dflt : v === "1";
  } catch (e) {
    return dflt;
  }
}
/** @param {string} key
 * @param {boolean} val
 */
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
/** @param {any} node
 * @param {HTMLElement} card
 * @returns {HTMLElement}
 */
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
/** @param {any} doc
 * @returns {any[]}
 */
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
    const built = nodes.map((n) => ({ n, node: makeCollapsible(n, (/** @type {Record<string, Renderer>} */ (RENDERERS)[n.type] || (() => el("div")))(n)) }));
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
// ── Bootstrap ─────────────────────────────────────────────────────────────
// Every DOM/window side-effect is gathered here (not at module top level) so
// importing this module — for a unit test or the string-generation build — is
// inert. boot() runs only in a real browser document (see the guard below).
function boot() {
  root = /** @type {HTMLElement} */ (document.getElementById("page"));
  HOME = root.dataset.home || "home";
  MOBILE_MQ = window.matchMedia("(max-width:__MOBILE_MAX_WIDTH__)");
  CURRENT = currentPage();
  PARAM = parseRoute().param;
  NANO_EMBEDDED = computeEmbedded();
  installThemeBridge();
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
}

// Only boot in a real browser document (a served <main id="page"> exists). Under
// Node/Deno import — for the unit tests or the string-generation build — this
// guard is false, so the module loads with zero DOM side-effects and its
// renderer functions / RENDERERS registry can be imported directly.
if (typeof document !== "undefined" && document.getElementById("page")) boot();

export { RENDERERS, renderText, renderButton, renderProse, renderNav, navLink, wireNavBadge, applyNavBadge, teardown, fmtCellValue, gridCell, buildDetailForm, chevronToggle, setChevronOpen };
