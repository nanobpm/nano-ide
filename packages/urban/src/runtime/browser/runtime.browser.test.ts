// Direct unit tests for the browser page runtime (#291). Because the runtime is
// now REAL importable source — not a `String.raw` blob — we can import its
// renderer functions and its RENDERERS registry and drive them with a minimal
// fake DOM, instead of string-scraping the served module. This replaces the #290
// regex drift guard (which had to regex the RENDERERS keys out of a string) with
// a real import, and adds the first true renderer-level unit coverage.
import { test } from "node:test";
import assert from "node:assert/strict";
import { PAGE_NODE_TYPES } from "../core/page-nodes.ts";
import { RENDERERS, renderText, renderAppView, navLink, sameOriginPath, wireNavBadge, applyNavBadge, teardown, fmtCellValue, gridCell } from "./runtime.browser.js";

// ── Minimal fake DOM ────────────────────────────────────────────────────────
// Just enough of the Element/Document surface that el()/renderText touch:
// createElement, className, setAttribute, addEventListener, append (of child
// nodes and text), and a readable textContent. Installed on globalThis so the
// module's global `document` resolves to it when a renderer is invoked. The
// module itself performs NO DOM access at import time (its boot() is gated), so
// installing this only needs to happen before we CALL a renderer.
class FakeElement {
  tagName: string;
  attributes: Record<string, string> = {};
  className = "";
  children: Array<FakeElement | { text: string }> = [];
  textContent = "";
  dataset: Record<string, string> = {};
  hidden = false;
  style = { setProperty() {} };

  constructor(tag: string) {
    this.tagName = String(tag).toUpperCase();
  }
  setAttribute(k: string, v: unknown): void {
    this.attributes[k] = String(v);
    if (k === "class") this.className = String(v);
  }
  getAttribute(k: string): string | null {
    return k in this.attributes ? this.attributes[k] : null;
  }
  addEventListener(): void {}
  append(...kids: Array<FakeElement | string>): void {
    for (const kid of kids) {
      if (typeof kid === "string") {
        this.children.push({ text: kid });
        this.textContent += kid;
      } else {
        this.children.push(kid);
        this.textContent += kid.textContent || "";
      }
    }
  }
  querySelector(): null {
    return null;
  }
}

// Installs the fake DOM on globalThis and returns a restore function that undoes
// the mutation, so a test can register `t.after(restore)` and never leak
// `globalThis.document` into later tests (which would be racy if node:test ran
// files/tests concurrently). Captures the prior descriptor so the original
// value — including `undefined` — is faithfully restored.
function installFakeDom(): () => void {
  const doc = {
    createElement: (tag: string) => new FakeElement(tag),
    getElementById: () => null,
  };
  const prior = Reflect.getOwnPropertyDescriptor(globalThis, "document");
  // Reflect.set writes through the untyped host boundary (globalThis.document is
  // typed Document under the DOM lib; our fake only implements what the renderer
  // touches) without an `as` cast (banned repo-wide).
  Reflect.set(globalThis, "document", doc);
  return () => {
    if (prior) {
      Reflect.defineProperty(globalThis, "document", prior);
    } else {
      Reflect.deleteProperty(globalThis, "document");
    }
  };
}

// A renderer statically returns HTMLElement but at runtime produces a FakeElement
// (the installed fake `document.createElement`). Narrow to FakeElement so a test can
// walk `.children` — without a banned `as` cast — by asserting the runtime shape.
function asFake(node: unknown): FakeElement {
  if (!(node instanceof FakeElement)) {
    throw new Error("expected a FakeElement (is the fake DOM installed?)");
  }
  return node;
}

test("#291: RENDERERS is a real importable registry keyed exactly by PAGE_NODE_TYPES", () => {
  // The drift lock is enforced at compile time by `RENDERERS satisfies
  // Record<PageNodeType, Renderer>` in the source; this asserts the same at
  // runtime via a real import (no string-scraping of the served module). If the
  // schema gains a page-node type without a renderer here (or vice-versa) this
  // fails loudly — the App would otherwise render an accepted node as a blank div.
  assert.deepEqual(
    Object.keys(RENDERERS).sort(),
    [...PAGE_NODE_TYPES].sort(),
    "RENDERERS keys must equal the shared PAGE_NODE_TYPES registry",
  );
  for (const [type, renderer] of Object.entries(RENDERERS)) {
    assert.equal(typeof renderer, "function", `renderer for "${type}" must be a function`);
  }
});

test("#291: renderText renders the heading/sub/body variant with the right tag + class", (t) => {
  t.after(installFakeDom());
  const heading = renderText({ type: "text", props: { variant: "heading", text: "Hello" } });
  assert.equal(heading.tagName, "H1");
  assert.equal(heading.className, "pc-heading");
  assert.equal(heading.textContent, "Hello");

  const sub = renderText({ type: "text", props: { variant: "sub", text: "Subtitle" } });
  assert.equal(sub.tagName, "P");
  assert.equal(sub.className, "pc-sub");

  const body = renderText({ type: "text", props: { text: "Body copy" } });
  assert.equal(body.tagName, "P");
  assert.equal(body.className, "pc-body");
  assert.equal(body.textContent, "Body copy");
});

test("#291: renderText degrades to empty text (never throws) on a missing text prop", (t) => {
  t.after(installFakeDom());
  const node = renderText({ type: "text", props: {} });
  assert.equal(node.tagName, "P");
  assert.equal(node.textContent, "");
});

test("#416: appView is a rendered node type (registry + bridged PAGE_NODE_TYPES)", () => {
  // The whole point of #416: an `appView` page node must have a real renderer, not
  // fall through to a blank <div>. It is in the RENDERERS registry and — since it
  // ships here ahead of the canonical schema — in the locally-bridged PAGE_NODE_TYPES.
  assert.ok(PAGE_NODE_TYPES.includes("appView"), "appView must be in the bridged PAGE_NODE_TYPES");
  assert.equal(typeof RENDERERS.appView, "function", "appView must have a renderer");
});

test("#416: renderAppView mounts a base-relative iframe honoring embed/title/fill", (t) => {
  t.after(installFakeDom());
  const section = asFake(
    renderAppView({
      type: "appView",
      props: { title: "Agent networks", embed: "./embed.html", fill: true },
    }),
  );
  assert.equal(section.tagName, "SECTION");
  // fill → the tall flex container variant so the embed gets viewport height.
  assert.equal(section.className, "pc-appview pc-appview-fill");

  const frame = section.children.find(
    (c): c is FakeElement => c instanceof FakeElement && c.tagName === "IFRAME",
  );
  assert.ok(frame, "an <iframe> must be mounted");
  // The iframe src is the node's embed, left document-relative so it resolves under
  // both the app root and the console App-View proxy prefix.
  assert.equal(frame.getAttribute("src"), "./embed.html");
  assert.equal(frame.getAttribute("title"), "Agent networks");
  assert.equal(frame.className, "pc-appview-frame");

  // The title also renders as a visible label above the frame.
  const label = section.children.find(
    (c): c is FakeElement => c instanceof FakeElement && c.className === "pc-appview-title",
  );
  assert.ok(label, "the title renders as a label");
  assert.equal(label.textContent, "Agent networks");
});

test("#416: renderAppView rebases a root-absolute embed onto the mount root", (t) => {
  t.after(installFakeDom());
  // A root-absolute "/embed.html" would escape the console proxy prefix and hit the
  // console origin; the renderer strips the single leading slash to rebase it.
  const section = asFake(renderAppView({ type: "appView", props: { embed: "/embed.html" } }));
  const frame = section.children.find(
    (c): c is FakeElement => c instanceof FakeElement && c.tagName === "IFRAME",
  );
  assert.ok(frame);
  assert.equal(frame.getAttribute("src"), "embed.html");
});

test("#416: renderAppView is non-fill by default and never throws on missing props", (t) => {
  t.after(installFakeDom());
  const section = asFake(renderAppView({ type: "appView", props: {} }));
  assert.equal(section.tagName, "SECTION");
  assert.equal(section.className, "pc-appview");
  const frame = section.children.find(
    (c): c is FakeElement => c instanceof FakeElement && c.tagName === "IFRAME",
  );
  assert.ok(frame, "an <iframe> is still mounted with no embed");
  // No usable embed → src is OMITTED (about:blank), not src="" (which resolves to
  // the current document URL in browsers and risks a recursive self-embed).
  assert.equal(frame.getAttribute("src"), null);
  // No title → no label element rendered.
  const label = section.children.find(
    (c): c is FakeElement => c instanceof FakeElement && c.className === "pc-appview-title",
  );
  assert.equal(label, undefined);
});

test("#416: renderAppView neutralizes a dangerous-scheme embed (no executable iframe src)", (t) => {
  t.after(installFakeDom());
  // A hostile/malformed page doc must not be able to smuggle an executable iframe
  // src via a javascript:/data:/vbscript: embed, nor bypass the check with embedded
  // whitespace/tabs (browsers strip those before parsing the URL).
  for (const embed of [
    "javascript:alert(1)",
    "data:text/html,<script>alert(1)</script>",
    "vbscript:msgbox(1)",
    "  javascript:alert(1)  ",
    "java\tscript:alert(1)",
    "JAVASCRIPT:alert(1)",
  ]) {
    const section = asFake(renderAppView({ type: "appView", props: { embed } }));
    const frame = section.children.find(
      (c): c is FakeElement => c instanceof FakeElement && c.tagName === "IFRAME",
    );
    assert.ok(frame, `an <iframe> is still mounted for ${JSON.stringify(embed)}`);
    assert.equal(
      frame.getAttribute("src"),
      null,
      `dangerous embed ${JSON.stringify(embed)} must not become an iframe src`,
    );
  }
});

test("#416: renderAppView keeps a legit http(s) embed and trims surrounding whitespace", (t) => {
  t.after(installFakeDom());
  const section = asFake(
    renderAppView({ type: "appView", props: { embed: "  https://example.test/embed.html  " } }),
  );
  const frame = section.children.find(
    (c): c is FakeElement => c instanceof FakeElement && c.tagName === "IFRAME",
  );
  assert.ok(frame);
  assert.equal(frame.getAttribute("src"), "https://example.test/embed.html");
});

test('#327: fmtCellValue "datetime" renders an ISO timestamp in the viewer\'s local time as "h:mmam Mon D"', () => {
  const iso = "2026-08-18T23:42:47.788Z";
  const out = fmtCellValue("datetime", iso);
  // Shape: h:mm + lowercase am/pm (no separating space), then short-month day.
  assert.match(out, /^\d{1,2}:\d{2}(am|pm) [A-Z][a-z]{2} \d{1,2}$/, `unexpected shape: ${out}`);
  // Local, not UTC: the hour/minute/am-pm/day track the runner's local zone, so
  // the assertion is timezone-independent (derives the expectation from the same
  // Date in local time) yet still proves the value isn't rendered as raw UTC.
  const d = new Date(iso);
  let h = d.getHours() % 12;
  if (h === 0) h = 12;
  const mm = String(d.getMinutes()).padStart(2, "0");
  const ampm = d.getHours() < 12 ? "am" : "pm";
  assert.ok(out.startsWith(`${h}:${mm}${ampm} `), `local time prefix wrong: ${out}`);
  assert.ok(out.endsWith(` ${d.getDate()}`), `local day suffix wrong: ${out}`);
});

test("#327: fmtCellValue passes through empty, unparseable, and unknown-format values verbatim (never blank/throw)", () => {
  assert.equal(fmtCellValue("datetime", ""), "");
  assert.equal(fmtCellValue("datetime", "not-a-date"), "not-a-date");
  // An unknown format is a no-op — a mis-set column shows its raw value, not blank.
  assert.equal(fmtCellValue("nope", "2026-08-18T23:42:47.788Z"), "2026-08-18T23:42:47.788Z");
});

test("#327: gridCell applies col.format to the cell text, leaving an unformatted column verbatim", (t) => {
  t.after(installFakeDom());
  const iso = "2026-08-18T23:42:47.788Z";
  const formatted = gridCell(
    { field: "updated_at", header: "Updated", format: "datetime" },
    { updated_at: iso },
    "secondary",
  );
  assert.match(
    formatted.textContent,
    /^\d{1,2}:\d{2}(am|pm) [A-Z][a-z]{2} \d{1,2}$/,
    `cell not local-formatted: ${formatted.textContent}`,
  );
  // No `format` → the field value renders exactly as stored (backward compatible).
  const plain = gridCell({ field: "updated_at", header: "Updated" }, { updated_at: iso }, "secondary");
  assert.equal(plain.textContent, iso);
});

// Find the first descendant span carrying `cls` in a FakeElement tree. Accepts
// `any` so it can walk either a FakeElement or a renderer's DOM-typed return.
function findByClass(node: any, cls: string): FakeElement | null {
  for (const kid of node.children) {
    if (kid instanceof FakeElement) {
      if (kid.className.split(/\s+/).includes(cls)) return kid;
      const deep = findByClass(kid, cls);
      if (deep) return deep;
    }
  }
  return null;
}

// Install a fake `fetch` on globalThis returning a fixed JSON body, so navLink's
// badge poll resolves deterministically without a real network call. Returns a
// restore fn (register with t.after) so it never leaks into other tests.
function installFakeFetch(body: unknown): () => void {
  const prior = Reflect.getOwnPropertyDescriptor(globalThis, "fetch");
  Reflect.set(globalThis, "fetch", () =>
    Promise.resolve({ ok: true, json: () => Promise.resolve(body) }),
  );
  return () => {
    if (prior) Reflect.defineProperty(globalThis, "fetch", prior);
    else Reflect.deleteProperty(globalThis, "fetch");
  };
}

test("#338: navLink without a badge is unchanged — no pill, no aria-label override", (t) => {
  t.after(installFakeDom());
  const link = navLink({ label: "Home", page: "home" });
  assert.ok(link, "expected a nav link");
  assert.equal(link.tagName, "A");
  assert.equal(findByClass(link, "pc-nav-badge"), null, "no badge pill without item.badge");
  assert.equal(link.getAttribute("aria-label"), null, "aria-label untouched without a badge");
});

test("#338: navLink with a badge appends a hidden tone-classed pill and polls a count", async (t) => {
  t.after(installFakeDom());
  t.after(installFakeFetch({ count: 3 }));
  const link = navLink({
    label: "Tasks",
    page: "tasks",
    badge: { source: "app", table: "user_tasks", filter: [], tone: "danger" },
  });
  assert.ok(link);
  const pill = findByClass(link, "pc-nav-badge");
  assert.ok(pill, "expected a badge pill for item.badge");
  assert.ok(pill.className.includes("pc-badge"), "reuses the .pc-badge pill");
  assert.ok(pill.className.includes("pc-badge-danger"), "carries the requested tone class");
  // The poll resolves asynchronously; flush microtasks then assert the live count.
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(pill.hidden, false, "pill shows once a positive count arrives");
  assert.equal(pill.textContent, "3");
  assert.equal(link.getAttribute("aria-label"), "Tasks (3 open)", "accessible name carries the count");
});

test("#338: navLink badge degrades to no pill (never a broken nav) when the fetch fails", async (t) => {
  t.after(installFakeDom());
  const prior = Reflect.getOwnPropertyDescriptor(globalThis, "fetch");
  Reflect.set(globalThis, "fetch", () => Promise.reject(new Error("boom")));
  t.after(() => {
    if (prior) Reflect.defineProperty(globalThis, "fetch", prior);
    else Reflect.deleteProperty(globalThis, "fetch");
  });
  const link = navLink({ label: "Tasks", page: "tasks", badge: { table: "user_tasks" } });
  const pill = findByClass(link, "pc-nav-badge");
  assert.ok(pill);
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(pill.hidden, true, "a failed fetch leaves the pill hidden");
  assert.equal(pill.textContent, "");
});

// ── #436: same-origin cross-surface nav (a { path } item) ───────────────────
// A pages-surface nav item can now point at another mounted surface by a relative
// same-origin path (e.g. "/tasks" → the taskInbox surface): an in-page, same-tab
// link, rebased onto the app mount root so it survives the console App-View proxy
// prefix. This is distinct from { page } (an in-app #/<page> hash) and { href }
// (an external new-tab http(s) link).

test("#436: navLink({ path }) renders a same-origin, same-tab link rebased onto the mount root", (t) => {
  t.after(installFakeDom());
  const link = navLink({ label: "Tasks", path: "/tasks" });
  assert.ok(link, "expected a nav link for a { path } item");
  assert.equal(link.tagName, "A");
  // Root-absolute "/tasks" is rebased to a document-relative "tasks" so it inherits
  // the mount root (and thus the console proxy prefix) rather than escaping to origin.
  assert.equal(link.getAttribute("href"), "tasks");
  // Same-tab, same-origin: NOT an external hand-off — no new-tab / noopener chrome.
  assert.equal(link.getAttribute("target"), null, "cross-surface nav stays in the same tab");
  assert.equal(link.getAttribute("rel"), null, "no rel=noopener on a same-origin link");
  const label = findByClass(link, "pc-nav-label");
  assert.ok(label && label.textContent === "Tasks");
});

test("#436: navLink({ path }) falls back to the path as its label when none is given", (t) => {
  t.after(installFakeDom());
  const link = navLink({ path: "/tasks" });
  assert.ok(link);
  const label = findByClass(link, "pc-nav-label");
  assert.ok(label && label.textContent === "/tasks", "label defaults to the raw path");
});

test("#436: a { page } item still wins over a { path } (in-app hash route has precedence)", (t) => {
  t.after(installFakeDom());
  const link = navLink({ label: "Home", page: "home", path: "/tasks" });
  assert.ok(link);
  assert.equal(link.getAttribute("href"), "#/home", "page hash route takes precedence over path");
  assert.equal(link.getAttribute("target"), null);
});

test("#436: a same-origin { path } wins over an external { href } (in-app link preferred)", (t) => {
  t.after(installFakeDom());
  const link = navLink({ label: "Tasks", path: "/tasks", href: "https://example.test/tasks" });
  assert.ok(link);
  assert.equal(link.getAttribute("href"), "tasks", "the same-origin path is used, not the external href");
  assert.equal(link.getAttribute("target"), null, "so it stays same-tab, not a new-tab external link");
});

test("#436: a scheme/protocol-relative { path } is rejected and falls through to the { href } handling", (t) => {
  t.after(installFakeDom());
  // A hostile/mistaken path carrying a scheme must NOT become a same-tab link — it
  // is rejected as not-same-origin and the item falls through to the hardened
  // new-tab external-href branch.
  const link = navLink({ label: "Evil", path: "javascript:alert(1)", href: "https://example.test/ok" });
  assert.ok(link);
  assert.equal(link.getAttribute("href"), "https://example.test/ok");
  assert.equal(link.getAttribute("target"), "_blank");
  assert.equal(link.getAttribute("rel"), "noopener noreferrer");
});

test("#436: with no label and a rejected { path }, the default label matches the { href } actually used", (t) => {
  t.after(installFakeDom());
  // No explicit label: the path is rejected (unsafe scheme) and we fall through to
  // the external href. The default label MUST reflect the href we navigate to, never
  // the discarded path — otherwise the visible text lies about the link target.
  const link = navLink({ path: "javascript:alert(1)", href: "https://example.test/ok" });
  assert.ok(link);
  assert.equal(link.getAttribute("href"), "https://example.test/ok");
  const label = findByClass(link, "pc-nav-label");
  assert.ok(label && label.textContent === "https://example.test/ok", "label defaults to the href actually used, not the rejected path");
});

test("#436: a { path } item with only an unsafe scheme and no href renders nothing", (t) => {
  t.after(installFakeDom());
  assert.equal(navLink({ label: "Evil", path: "javascript:alert(1)" }), null);
  assert.equal(navLink({ label: "Ext", path: "//evil.example/tasks" }), null);
});

test("#436: sameOriginPath rebases in-app paths and rejects non-same-origin targets", () => {
  // Root-absolute → rebased onto the mount root (survives the console proxy prefix).
  assert.equal(sameOriginPath("/tasks"), "tasks");
  assert.equal(sameOriginPath("/tasks/inbox"), "tasks/inbox");
  // Already document-relative → left as-is.
  assert.equal(sameOriginPath("tasks"), "tasks");
  assert.equal(sameOriginPath("./tasks"), "./tasks");
  // Embedded ASCII tab/newline is stripped before the scheme gate (browsers strip
  // it before parsing), so `java\tscript:` can't sneak past as a "relative" path.
  assert.equal(sameOriginPath("java\tscript:alert(1)"), "");
  // Any scheme / protocol-relative host is not a same-origin in-app path.
  assert.equal(sameOriginPath("https://example.test/tasks"), "");
  assert.equal(sameOriginPath("http://example.test/tasks"), "");
  assert.equal(sameOriginPath("javascript:alert(1)"), "");
  assert.equal(sameOriginPath("data:text/html,x"), "");
  assert.equal(sameOriginPath("//evil.example/tasks"), "");
  // Backslashes are folded to `/` before the gates (browsers normalize them), so a
  // `\\host` or `/\host` value can't smuggle a protocol-relative cross-origin target past.
  assert.equal(sameOriginPath("\\\\evil.example/tasks"), "");
  assert.equal(sameOriginPath("/\\evil.example/tasks"), "");
  assert.equal(sameOriginPath("\\/evil.example/tasks"), "");
  // Non-strings / blanks → "".
  assert.equal(sameOriginPath(""), "");
  assert.equal(sameOriginPath("   "), "");
  assert.equal(sameOriginPath(null), "");
  assert.equal(sameOriginPath(42), "");
});

test("#338: applyNavBadge honours hideWhenZero and mirrors the count into the accessible name", (t) => {
  const restore = installFakeDom();
  t.after(restore);
  const doc: { createElement: (tag: string) => FakeElement } = Reflect.get(globalThis, "document");
  // The renderer's applyNavBadge is DOM-typed (HTMLElement); the fake elements
  // satisfy the subset it touches, so the locals are `any` (no banned `as` cast).
  const mk = (): { link: any; pill: any } => ({ link: doc.createElement("a"), pill: doc.createElement("span") });

  // Positive count → visible pill + "(n open)" accessible name.
  const a = mk();
  applyNavBadge(a.link, a.pill, "Tasks", true, 5);
  assert.equal(a.pill.hidden, false);
  assert.equal(a.pill.textContent, "5");
  assert.equal(a.link.getAttribute("aria-label"), "Tasks (5 open)");

  // Zero with hideWhenZero → nothing (a quiet nav stays clean), label reset.
  const b = mk();
  applyNavBadge(b.link, b.pill, "Tasks", true, 0);
  assert.equal(b.pill.hidden, true);
  assert.equal(b.pill.textContent, "");
  assert.equal(b.link.getAttribute("aria-label"), "Tasks");

  // Zero WITHOUT hideWhenZero → the pill still shows "0".
  const c = mk();
  applyNavBadge(c.link, c.pill, "Tasks", false, 0);
  assert.equal(c.pill.hidden, false);
  assert.equal(c.pill.textContent, "0");

  // A non-finite/malformed count degrades to hidden, never "NaN".
  const d = mk();
  applyNavBadge(d.link, d.pill, "Tasks", false, Number.NaN);
  assert.equal(d.pill.hidden, true);
  assert.equal(d.pill.textContent, "");
});

test("#338: wireNavBadge registers its poll interval with the per-page teardown so page switches stop it", (t) => {
  // Defect-class guard: any refreshMs poller MUST clear its interval on teardown,
  // or navigating between pages leaks a setInterval that fetches forever and pins
  // the old link/pill alive via closure. This drives wireNavBadge with stubbed
  // timers + fetch and asserts teardown() actually clears the interval it started.
  const restore = installFakeDom();
  t.after(restore);
  const doc: { createElement: (tag: string) => FakeElement } = Reflect.get(globalThis, "document");

  const cleared: number[] = [];
  let nextId = 1;
  const started: number[] = [];
  const priorSet = Reflect.getOwnPropertyDescriptor(globalThis, "setInterval");
  const priorClear = Reflect.getOwnPropertyDescriptor(globalThis, "clearInterval");
  const priorFetch = Reflect.getOwnPropertyDescriptor(globalThis, "fetch");
  Reflect.set(globalThis, "setInterval", (): number => {
    const id = nextId++;
    started.push(id);
    return id;
  });
  Reflect.set(globalThis, "clearInterval", (id: number): void => {
    cleared.push(id);
  });
  // getJSON awaits fetch(); a rejection is swallowed by wireNavBadge's .catch, so
  // the immediate poll degrades quietly without an unhandled rejection.
  Reflect.set(globalThis, "fetch", () => Promise.reject(new Error("offline")));
  t.after(() => {
    if (priorSet) Reflect.defineProperty(globalThis, "setInterval", priorSet);
    if (priorClear) Reflect.defineProperty(globalThis, "clearInterval", priorClear);
    if (priorFetch) Reflect.defineProperty(globalThis, "fetch", priorFetch);
    else Reflect.deleteProperty(globalThis, "fetch");
  });

  const link: any = doc.createElement("a");
  wireNavBadge(link, "Tasks", { source: "app", table: "tasks", refreshMs: 5000 });
  assert.equal(started.length, 1, "wireNavBadge should start exactly one poll interval");
  assert.equal(cleared.length, 0, "interval must not be cleared before teardown");

  teardown();
  assert.deepEqual(cleared, started, "teardown() must clear the interval wireNavBadge started");
});

test("#338: a param-scoped nav badge with no route param degrades to 0 without querying field=\"\"", (t) => {
  // Defect-class guard mirroring the dataGrid/list pollers: a badge whose filter is
  // param-scoped ({ eqParam: true }) but with an empty route PARAM must NOT build a
  // where=field: query (which the server reads as field equals empty string and can
  // surface a wrong count). It must short-circuit to a 0/hidden badge with no fetch.
  const restore = installFakeDom();
  t.after(restore);
  const doc: { createElement: (tag: string) => FakeElement } = Reflect.get(globalThis, "document");

  let fetchCalls = 0;
  const priorFetch = Reflect.getOwnPropertyDescriptor(globalThis, "fetch");
  Reflect.set(globalThis, "fetch", () => {
    fetchCalls++;
    return Promise.reject(new Error("should not fetch"));
  });
  t.after(() => {
    if (priorFetch) Reflect.defineProperty(globalThis, "fetch", priorFetch);
    else Reflect.deleteProperty(globalThis, "fetch");
  });

  // PARAM defaults to "" (no renderPage has run), so a param-scoped badge is the
  // empty-selection case the guard must short-circuit.
  const link: any = doc.createElement("a");
  wireNavBadge(link, "Tasks", { source: "app", table: "tasks", filter: [{ field: "owner", eqParam: true }] });

  assert.equal(fetchCalls, 0, "param-scoped badge with empty PARAM must not issue a count query");
  const pill: any = link.children[link.children.length - 1];
  assert.equal(pill.textContent, "0", "badge degrades to 0 rather than an empty-string-filtered count");
  assert.equal(pill.hidden, false, "0 is shown (hideWhenZero is off) rather than a stale count");
});
