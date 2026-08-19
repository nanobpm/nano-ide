// Unit tests for buildDetailForm (#333) — the single shared implementation of the
// `detail.form` answer/resume contract used by BOTH the top-level dataGrid detail
// panel and a child-grid per-row expansion. Because #333 lets a child-grid row
// host the same form, the contract must be exercised directly (render gating,
// prompt echo, and the interpolated route-driven submit) so the top-level ↔
// child-grid parity can't silently drift.
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildDetailForm, chevronToggle, setChevronOpen } from "./runtime.browser.js";

// ── Fake DOM with fire-able listeners ───────────────────────────────────────
// Richer than the render-only fake in runtime.browser.test.ts: it records event
// listeners (so a test can fire the submit click), exposes a settable textarea
// `value`, a `firstChild`, and `replaceChildren` — the surface buildDetailForm's
// interactive path touches. Every created node is collected on `created` so a
// test can grab the textarea/button without a real querySelector.
class FakeElement {
  tagName: string;
  attributes: Record<string, string> = {};
  className = "";
  children: Array<FakeElement | { text: string }> = [];
  textContent = "";
  dataset: Record<string, string> = {};
  hidden = false;
  disabled = false;
  value = "";
  style = { setProperty() {} };
  listeners: Record<string, Array<(ev: unknown) => unknown>> = {};

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
  addEventListener(type: string, fn: (ev: unknown) => unknown): void {
    (this.listeners[type] ||= []).push(fn);
  }
  async fire(type: string): Promise<void> {
    for (const fn of this.listeners[type] || []) await fn({ stopPropagation() {} });
  }
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
  replaceChildren(...kids: Array<FakeElement | string>): void {
    this.children = [];
    this.textContent = "";
    this.append(...kids);
  }
  get firstChild(): FakeElement | { text: string } | null {
    return this.children[0] ?? null;
  }
  querySelector(): null {
    return null;
  }
}

function installFakeDom(created: FakeElement[]): () => void {
  const doc = {
    createElement: (tag: string) => {
      const n = new FakeElement(tag);
      created.push(n);
      return n;
    },
    getElementById: () => null,
    dispatchEvent: () => true,
  };
  const prior = Reflect.getOwnPropertyDescriptor(globalThis, "document");
  Reflect.set(globalThis, "document", doc);
  return () => {
    if (prior) Reflect.defineProperty(globalThis, "document", prior);
    else Reflect.deleteProperty(globalThis, "document");
  };
}

const ACTION = {
  path: "/app/api/actions/complete-user-task",
  body: { taskId: "{{row.task_id}}", variables: "{{form}}" },
  successLabel: "Answered ✓",
};
const FORM = {
  showWhenField: "answerable",
  promptField: "question",
  inputKey: "comment",
  inputLabel: "Your answer",
  submitLabel: "Answer & resume",
  action: ACTION,
};

test("#333: buildDetailForm renders nothing when the row's showWhenField is falsy or missing", (t) => {
  const created: FakeElement[] = [];
  t.after(installFakeDom(created));
  assert.equal(buildDetailForm(FORM, { answerable: false, question: "Why?" }, () => {}), null);
  assert.equal(buildDetailForm(FORM, { question: "Why?" }, () => {}), null);
  assert.equal(buildDetailForm(null, { answerable: true }, () => {}), null);
});

test("#333: buildDetailForm echoes the prompt and labels the field/submit from the form config", (t) => {
  const created: FakeElement[] = [];
  t.after(installFakeDom(created));
  const box = buildDetailForm(FORM, { answerable: true, question: "Ship it?" }, () => {});
  assert.ok(box, "an answerable row must render a form");
  assert.match(box!.textContent, /Ship it\?/, "the promptField value is echoed");
  const textarea = created.find((n) => n.tagName === "TEXTAREA");
  const button = created.find((n) => n.tagName === "BUTTON");
  assert.equal(textarea?.getAttribute("placeholder"), "Your answer");
  assert.equal(button?.textContent, "Answer & resume");
});

test("#333: the answer form is screen-reader accessible — textarea has an aria-label and the status is a live region", (t) => {
  const created: FakeElement[] = [];
  t.after(installFakeDom(created));
  const box = buildDetailForm(FORM, { answerable: true, question: "Ship it?" }, () => {});
  assert.ok(box);
  const textarea = created.find((n) => n.tagName === "TEXTAREA");
  // The placeholder alone is not an accessible name; an explicit aria-label makes
  // the field usable without a visible <label>.
  assert.equal(textarea?.getAttribute("aria-label"), "Your answer");
  const msg = created.find((n) => n.tagName === "P" && n.className.includes("pc-msg"));
  assert.equal(msg?.getAttribute("role"), "status", "status message is a live region role");
  assert.equal(msg?.getAttribute("aria-live"), "polite", "status transitions are announced politely");
  // Explicit type="button" so the submit control can never trigger an unintended
  // submit/navigation if the form is ever nested inside a real <form>.
  const button = created.find((n) => n.tagName === "BUTTON");
  assert.equal(button?.getAttribute("type"), "button", "submit control is an explicit type=button");
});

test("#333: the answer form's aria-label falls back to inputKey when inputLabel is absent", (t) => {
  const created: FakeElement[] = [];
  t.after(installFakeDom(created));
  const noLabel = { ...FORM, inputLabel: undefined };
  buildDetailForm(noLabel, { answerable: true }, () => {});
  const textarea = created.find((n) => n.tagName === "TEXTAREA");
  assert.equal(textarea?.getAttribute("aria-label"), "comment", "aria-label mirrors the placeholder fallback (inputKey)");
});

test("#333: chevronToggle is an accessible disclosure button and setChevronOpen keeps the glyph and aria-expanded in lock-step", (t) => {
  const created: FakeElement[] = [];
  t.after(installFakeDom(created));
  const btn = chevronToggle("Toggle answer form");
  assert.equal(btn.getAttribute("type"), "button", "explicit type so it never submits an enclosing form");
  assert.equal(btn.getAttribute("aria-label"), "Toggle answer form", "has an accessible name");
  assert.equal(btn.getAttribute("aria-expanded"), "false", "starts collapsed");
  assert.equal(btn.textContent, "▸");

  setChevronOpen(btn, true);
  assert.equal(btn.textContent, "▾", "glyph flips to open");
  assert.equal(btn.getAttribute("aria-expanded"), "true", "aria-expanded tracks the glyph");

  setChevronOpen(btn, false);
  assert.equal(btn.textContent, "▸");
  assert.equal(btn.getAttribute("aria-expanded"), "false");
});

test("#333: chevronToggle falls back to a generic accessible name when none is given", (t) => {
  const created: FakeElement[] = [];
  t.after(installFakeDom(created));
  const btn = chevronToggle();
  assert.equal(btn.getAttribute("aria-label"), "Toggle details");
});

test("#333: submitting POSTs the interpolated {{row.*}}/{{form.*}} body, shows successLabel, and fires onSuccess", async (t) => {
  const created: FakeElement[] = [];
  t.after(installFakeDom(created));
  /** @type {Array<{ url: unknown; init: any }>} */
  const calls: Array<{ url: unknown; init: { method?: string; body?: string } }> = [];
  const priorFetch = globalThis.fetch;
  Reflect.set(globalThis, "fetch", async (url: unknown, init: { method?: string; body?: string }) => {
    calls.push({ url, init });
    return { ok: true, status: 200, json: async () => ({ ok: true }) };
  });
  t.after(() => Reflect.set(globalThis, "fetch", priorFetch));

  let refreshed = 0;
  const box = buildDetailForm(FORM, { answerable: true, question: "Ship it?", task_id: "T-42" }, () => {
    refreshed++;
  });
  assert.ok(box);
  const textarea = created.find((n) => n.tagName === "TEXTAREA");
  const button = created.find((n) => n.tagName === "BUTTON");
  assert.ok(textarea && button);
  textarea!.value = "Looks good, proceed";
  await button!.fire("click");

  assert.equal(calls.length, 1, "exactly one route POST");
  assert.equal(calls[0].init.method, "POST");
  const sent = JSON.parse(String(calls[0].init.body));
  assert.deepEqual(
    sent,
    { taskId: "T-42", variables: { comment: "Looks good, proceed" } },
    "row token → task_id, whole-form splice → { comment }",
  );
  assert.equal(refreshed, 1, "onSuccess (child-grid reload / page re-poll) fires once");
  const msg = created.find((n) => n.tagName === "P" && n.className.includes("ok"));
  assert.equal(msg?.textContent, "Answered ✓", "the action successLabel is shown");
});

test("#333: a failed submit surfaces the error, re-enables submit, and does NOT fire onSuccess", async (t) => {
  const created: FakeElement[] = [];
  t.after(installFakeDom(created));
  const priorFetch = globalThis.fetch;
  Reflect.set(globalThis, "fetch", async () => ({ ok: false, status: 500, json: async () => ({ error: "boom" }) }));
  t.after(() => Reflect.set(globalThis, "fetch", priorFetch));

  let refreshed = 0;
  const box = buildDetailForm(FORM, { answerable: true, question: "Ship it?", task_id: "T-9" }, () => {
    refreshed++;
  });
  assert.ok(box);
  const button = created.find((n) => n.tagName === "BUTTON");
  await button!.fire("click");

  assert.equal(refreshed, 0, "onSuccess must not fire on failure — the row stays");
  assert.equal(button?.disabled, false, "submit is re-enabled so the operator can retry");
  const msg = created.find((n) => n.tagName === "P" && n.className.includes("err"));
  assert.equal(msg?.textContent, "boom", "the server error is surfaced");
});

test("#333: a failed onSuccess refresh is surfaced and re-enables submit — no silent failure / stuck button", async (t) => {
  const created: FakeElement[] = [];
  t.after(installFakeDom(created));
  const priorFetch = globalThis.fetch;
  Reflect.set(globalThis, "fetch", async () => ({ ok: true, status: 200, json: async () => ({ ok: true }) }));
  t.after(() => Reflect.set(globalThis, "fetch", priorFetch));

  // The submit itself succeeds, but the follow-up refresh (a child grid's
  // re-fetch) rejects. buildDetailForm awaits onSuccess, so the reload failure
  // must NOT be swallowed: the error is shown and the button re-enabled, instead
  // of the operator being stuck on a permanently-disabled button under a false
  // "Sent". Guards both suppressed advisories on runtime.browser.js:1581/1807.
  const box = buildDetailForm(FORM, { answerable: true, question: "Ship it?", task_id: "T-7" }, async () => {
    throw new Error("reload failed");
  });
  assert.ok(box);
  const button = created.find((n) => n.tagName === "BUTTON");
  await button!.fire("click");

  assert.equal(button?.disabled, false, "submit re-enabled when the refresh fails so the operator isn't stuck");
  const err = created.find((n) => n.tagName === "P" && n.className.includes("err"));
  assert.equal(err?.textContent, "reload failed", "the refresh failure is surfaced, not swallowed");
});

test("#333: on a fully successful submit the button stays disabled — the refresh detaches/rebuilds the form", async (t) => {
  const created: FakeElement[] = [];
  t.after(installFakeDom(created));
  const priorFetch = globalThis.fetch;
  Reflect.set(globalThis, "fetch", async () => ({ ok: true, status: 200, json: async () => ({ ok: true }) }));
  t.after(() => Reflect.set(globalThis, "fetch", priorFetch));

  const box = buildDetailForm(FORM, { answerable: true, question: "Ship it?", task_id: "T-1" }, () => {});
  assert.ok(box);
  const button = created.find((n) => n.tagName === "BUTTON");
  await button!.fire("click");

  assert.equal(button?.disabled, true, "left disabled on success — the refresh replaces the form, so re-enabling is moot");
});
