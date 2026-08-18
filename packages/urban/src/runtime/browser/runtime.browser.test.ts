// Direct unit tests for the browser page runtime (#291). Because the runtime is
// now REAL importable source — not a `String.raw` blob — we can import its
// renderer functions and its RENDERERS registry and drive them with a minimal
// fake DOM, instead of string-scraping the served module. This replaces the #290
// regex drift guard (which had to regex the RENDERERS keys out of a string) with
// a real import, and adds the first true renderer-level unit coverage.
import { test } from "node:test";
import assert from "node:assert/strict";
import { PAGE_NODE_TYPES } from "@nanobpm/nano-app-schema";
import { RENDERERS, renderText } from "./runtime.browser.js";

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

function installFakeDom(): void {
  const doc = { createElement: (tag: string) => new FakeElement(tag) };
  // Reflect.set writes through the untyped host boundary (globalThis.document is
  // typed Document under the DOM lib; our fake only implements what the renderer
  // touches) without an `as` cast (banned repo-wide).
  Reflect.set(globalThis, "document", doc);
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

test("#291: renderText renders the heading/sub/body variant with the right tag + class", () => {
  installFakeDom();
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

test("#291: renderText degrades to empty text (never throws) on a missing text prop", () => {
  installFakeDom();
  const node = renderText({ type: "text", props: {} });
  assert.equal(node.tagName, "P");
  assert.equal(node.textContent, "");
});
