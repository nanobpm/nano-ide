// Unit tests for buildDetailForm (#333) — the single shared implementation of the
// `detail.form` answer/resume contract used by BOTH the top-level dataGrid detail
// panel and a child-grid per-row expansion. Because #333 lets a child-grid row
// host the same form, the contract must be exercised directly (render gating,
// prompt echo, and the interpolated route-driven submit) so the top-level ↔
// child-grid parity can't silently drift.
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildDetailForm, chevronToggle, setChevronOpen, evalDetailCondition, normalizeDetailOptions } from "./runtime.browser.js";

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

// ── #372: schema-derived multi-field / choice detail.form ───────────────────
// The single-textarea form (above) is now the degenerate case of a form whose
// fields are DERIVED from the element's `.form` contract: a form may declare an
// array of `select`/`textarea`/`text` fields, each bound to its own inputKey and
// optionally gated by a `conditional.hide` FEEL expression. These tests exercise
// the multi-field render, the choice widget, the single assembled {{form}} body,
// and the conditional gate — the surface nwf's five human-decision kinds need.

const MULTI_ACTION = {
  path: "/app/api/actions/complete-user-task",
  body: { taskId: "{{row.task_id}}", variables: "{{form}}" },
  successLabel: "Resolved ✓",
};
// A feature-escalation form: a required `resolution` choice plus a free-text
// `answer` that only applies when the operator chose "answer".
const ESCALATION_FORM = {
  showWhenField: "answerable",
  promptField: "question",
  submitLabel: "Resolve",
  action: MULTI_ACTION,
  fields: [
    {
      inputKey: "resolution",
      type: "select",
      label: "Resolution",
      options: [
        { value: "answer", label: "Answer the question" },
        { value: "abandon", label: "Abandon the feature" },
      ],
    },
    {
      inputKey: "answer",
      type: "textarea",
      label: "Your answer",
      conditional: { hide: '=resolution != "answer"' },
    },
  ],
};

function fakeFetch(t: { after: (fn: () => void) => void }, calls: Array<{ url: unknown; init: { method?: string; body?: string } }>) {
  const prior = globalThis.fetch;
  Reflect.set(globalThis, "fetch", async (url: unknown, init: { method?: string; body?: string }) => {
    calls.push({ url, init });
    return { ok: true, status: 200, json: async () => ({ ok: true }) };
  });
  t.after(() => Reflect.set(globalThis, "fetch", prior));
}

test("#372: a multi-field form renders a labelled <select> (with option labels) and a <textarea>", (t) => {
  const created: FakeElement[] = [];
  t.after(installFakeDom(created));
  const box = buildDetailForm(ESCALATION_FORM, { answerable: true, question: "Ship it?" }, () => {});
  assert.ok(box);
  const select = created.find((n) => n.tagName === "SELECT");
  const textarea = created.find((n) => n.tagName === "TEXTAREA");
  assert.ok(select, "the choice field renders a native <select>");
  assert.ok(textarea, "the free-text field renders a <textarea>");
  const options = created.filter((n) => n.tagName === "OPTION");
  assert.equal(options.length, 2, "one <option> per enumerated value");
  assert.equal(options[0].getAttribute("value"), "answer");
  assert.equal(options[0].textContent, "Answer the question", "the option's label (not the value) is shown");
  assert.equal(select?.getAttribute("aria-label"), "Resolution", "the choice field is screen-reader labelled");
  // A multi-field form gives each widget a visible <label> so the fields are
  // distinguishable (the legacy single-textarea form stays label-less).
  const labels = created.filter((n) => n.tagName === "LABEL");
  assert.ok(labels.some((l) => l.textContent === "Resolution"), "the select carries a visible label");
});

test("#372: submit assembles every visible field into ONE {{form}} body keyed by inputKey", async (t) => {
  const created: FakeElement[] = [];
  t.after(installFakeDom(created));
  const calls: Array<{ url: unknown; init: { method?: string; body?: string } }> = [];
  fakeFetch(t, calls);
  const box = buildDetailForm(ESCALATION_FORM, { answerable: true, question: "Ship it?", task_id: "T-5" }, () => {});
  assert.ok(box);
  const select = created.find((n) => n.tagName === "SELECT")!;
  const textarea = created.find((n) => n.tagName === "TEXTAREA")!;
  const button = created.find((n) => n.tagName === "BUTTON")!;
  select.value = "answer";
  await select.fire("change");
  textarea.value = "Yes — proceed";
  await button.fire("click");
  assert.equal(calls.length, 1, "exactly one route POST");
  const sent = JSON.parse(String(calls[0].init.body));
  assert.deepEqual(
    sent,
    { taskId: "T-5", variables: { resolution: "answer", answer: "Yes — proceed" } },
    "both fields splice into a single {{form}} keyed by their inputKeys",
  );
});

test("#372: a field hidden by conditional.hide is dropped from the submitted body", async (t) => {
  const created: FakeElement[] = [];
  t.after(installFakeDom(created));
  const calls: Array<{ url: unknown; init: { method?: string; body?: string } }> = [];
  fakeFetch(t, calls);
  const box = buildDetailForm(ESCALATION_FORM, { answerable: true, question: "Ship it?", task_id: "T-6" }, () => {});
  assert.ok(box);
  const select = created.find((n) => n.tagName === "SELECT")!;
  const textarea = created.find((n) => n.tagName === "TEXTAREA")!;
  const wrapOf = (input: FakeElement) => created.find((n) => n.tagName === "DIV" && n.className === "pc-field" && n.children.includes(input))!;
  const button = created.find((n) => n.tagName === "BUTTON")!;
  // Choosing "abandon" makes `resolution != "answer"` true, so the answer field
  // is hidden — and must not smuggle a stale value through.
  select.value = "abandon";
  await select.fire("change");
  assert.equal(wrapOf(textarea).hidden, true, "the answer field is hidden when the choice isn't 'answer'");
  textarea.value = "leftover text that should be ignored";
  await button.fire("click");
  const sent = JSON.parse(String(calls[0].init.body));
  assert.deepEqual(
    sent,
    { taskId: "T-6", variables: { resolution: "abandon" } },
    "the hidden field is omitted from {{form}}",
  );
});

test("#372: conditional.hide re-evaluates live — flipping the choice reveals the dependent field", async (t) => {
  const created: FakeElement[] = [];
  t.after(installFakeDom(created));
  const box = buildDetailForm(ESCALATION_FORM, { answerable: true, question: "Ship it?" }, () => {});
  assert.ok(box);
  const select = created.find((n) => n.tagName === "SELECT")!;
  const textarea = created.find((n) => n.tagName === "TEXTAREA")!;
  const wrapOf = (input: FakeElement) => created.find((n) => n.tagName === "DIV" && n.className === "pc-field" && n.children.includes(input))!;
  // Initial state: the select defaults to its first option ("answer" is empty in
  // the fake until set), so an unset select value ("") != "answer" → hidden.
  select.value = "abandon";
  await select.fire("change");
  assert.equal(wrapOf(textarea).hidden, true, "hidden while 'abandon' is chosen");
  select.value = "answer";
  await select.fire("change");
  assert.equal(wrapOf(textarea).hidden, false, "revealed once 'answer' is chosen");
});

test("#372: normalizeDetailOptions accepts {value,label} objects and bare scalars", () => {
  assert.deepEqual(normalizeDetailOptions([{ value: "a", label: "Alpha" }, { value: "b" }]), [
    { value: "a", label: "Alpha" },
    { value: "b", label: "b" },
  ]);
  assert.deepEqual(normalizeDetailOptions(["x", 2]), [
    { value: "x", label: "x" },
    { value: "2", label: "2" },
  ]);
  assert.deepEqual(normalizeDetailOptions(undefined), []);
});

test("#372: evalDetailCondition evaluates the FEEL subset used by .form conditional.hide", () => {
  // Equality / inequality against a string literal (the feature-escalation case).
  assert.equal(evalDetailCondition('=resolution != "answer"', { resolution: "abandon" }), true);
  assert.equal(evalDetailCondition('=resolution != "answer"', { resolution: "answer" }), false);
  assert.equal(evalDetailCondition('resolution = "answer"', { resolution: "answer" }), true);
  // A missing field is not equal to a concrete literal.
  assert.equal(evalDetailCondition('directive = "revise"', {}), false);
  assert.equal(evalDetailCondition('directive != "revise"', {}), true);
  // and / or combination and numeric comparison.
  assert.equal(evalDetailCondition('action = "proceed" or action = "merge"', { action: "merge" }), true);
  assert.equal(evalDetailCondition('count > 3 and flag = "on"', { count: "5", flag: "on" }), true);
  assert.equal(evalDetailCondition('count > 3 and flag = "on"', { count: "2", flag: "on" }), false);
  // Boolean flag (bare primary) and null literal.
  assert.equal(evalDetailCondition("=urgent", { urgent: true }), true);
  assert.equal(evalDetailCondition("=urgent", { urgent: false }), false);
});

test("#372: evalDetailCondition fails OPEN (false → field stays visible) on any unparseable input", () => {
  // A garbage / partial expression must never hide (and thus drop) a field.
  assert.equal(evalDetailCondition("=resolution !!! answer", { resolution: "x" }), false);
  assert.equal(evalDetailCondition("=(unbalanced", { a: 1 }), false);
  assert.equal(evalDetailCondition("", { a: 1 }), false);
  assert.equal(evalDetailCondition(null, { a: 1 }), false);
});
