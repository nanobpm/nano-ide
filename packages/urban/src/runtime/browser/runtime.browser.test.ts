// Direct unit tests for the browser page runtime (#291). Because the runtime is
// now REAL importable source — not a `String.raw` blob — we can import its
// renderer functions and its RENDERERS registry and drive them with a minimal
// fake DOM, instead of string-scraping the served module. This replaces the #290
// regex drift guard (which had to regex the RENDERERS keys out of a string) with
// a real import, and adds the first true renderer-level unit coverage.
import { test } from "node:test";
import assert from "node:assert/strict";
import { PAGE_NODE_TYPES } from "@nanobpm/nano-app-schema";
import { RENDERERS, renderText, fmtCellValue, gridCell } from "./runtime.browser.js";

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
