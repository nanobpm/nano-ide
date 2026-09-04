// Unit tests for buildEngineForm (#457) — the dataGrid detail's ENGINE-declared
// form path. Where buildDetailForm renders a page-authored `detail.form`, this
// resolves the row's engine `formKey` via the shared `/app/actions/form` gate and
// renders the AUTHORITATIVE deployed form-js schema with the shared renderer
// (globalThis.NanoFormJs), completing the row's user task via
// `/app/actions/complete`. A row with no formKey degrades to a bare completion,
// matching the taskInbox no-form fallback.

import { test } from "node:test";
import assert from "node:assert/strict";
import { buildEngineForm } from "./runtime.browser.js";
// Importing the shared renderer registers globalThis.NanoFormJs, which
// buildEngineForm reads lazily when it renders a resolved schema.
import "./formjs.browser.js";
import { type FakeElement, installFakeDom } from "./fake-dom.test-utils.ts";

interface FetchCall {
  url: string;
  method: string;
  // Parsed request JSON body (or undefined), typed loosely so a test can assert on
  // arbitrary shapes without ceremony — mirrors the runtime's JSDoc `any` payloads.
  body?: any;
}

/** Install a fake `fetch` that resolves each request from a route→response map. */
function installFakeFetch(
  handler: (url: string, opts: { method?: string; body?: string }) => { status?: number; json?: unknown },
  calls: FetchCall[],
): () => void {
  const prior = Reflect.getOwnPropertyDescriptor(globalThis, "fetch");
  const fake = (input: string | URL, opts: { method?: string; body?: string } = {}) => {
    const url = String(input);
    calls.push({ url, method: opts.method ?? "GET", body: opts.body ? JSON.parse(opts.body) : undefined });
    const res = handler(url, opts);
    const status = res.status ?? 200;
    return Promise.resolve({
      ok: status >= 200 && status < 300,
      status,
      json: () =>
        res.json === undefined ? Promise.reject(new Error("no body")) : Promise.resolve(res.json),
      text: () => Promise.resolve(res.json === undefined ? "" : JSON.stringify(res.json)),
    });
  };
  Reflect.set(globalThis, "fetch", fake);
  return () => {
    if (prior) Reflect.defineProperty(globalThis, "fetch", prior);
    else Reflect.deleteProperty(globalThis, "fetch");
  };
}

const CFG = { formKeyField: "form_key", userTaskKeyField: "user_task_key" };

test("buildEngineForm renders nothing when the row has no user-task key", (t) => {
  const created: FakeElement[] = [];
  t.after(installFakeDom(created));
  assert.equal(buildEngineForm(CFG, { form_key: "f1" }, () => {}), null);
  assert.equal(buildEngineForm(null, { user_task_key: "u1" }, () => {}), null);
});

test("buildEngineForm resolves the row's formKey and completes with the entered variables", async (t) => {
  const created: FakeElement[] = [];
  const calls: FetchCall[] = [];
  t.after(installFakeDom(created));
  t.after(
    installFakeFetch((url) => {
      if (url.includes("/app/actions/form")) {
        return { status: 200, json: { schema: { components: [{ type: "textfield", key: "note" }] } } };
      }
      return { status: 200, json: { ok: true } };
    }, calls),
  );
  let refreshed = false;
  const box = buildEngineForm(CFG, { form_key: "form-9", user_task_key: "ut-9" }, () => {
    refreshed = true;
  });
  assert.ok(box);
  // Let the form fetch + render settle.
  await new Promise((r) => setTimeout(r, 0));
  const formReq = calls.find((c) => c.url.includes("/app/actions/form"));
  assert.ok(formReq, "the row's formKey is resolved via the shared gate");
  assert.match(formReq!.url, /formKey=form-9/);
  // The shared renderer built the field; fill it and submit.
  const input = created.find((n) => n.tagName === "INPUT");
  assert.ok(input, "the deployed form-js schema was rendered by the shared renderer");
  input!.value = "done";
  const form = created.find((n) => n.tagName === "FORM");
  await form!.fire("submit");
  await new Promise((r) => setTimeout(r, 0));
  const completeReq = calls.find((c) => c.url.includes("/app/actions/complete"));
  assert.ok(completeReq, "submitting completes the user task");
  assert.equal(completeReq!.method, "POST");
  assert.deepEqual(completeReq!.body, { userTaskKey: "ut-9", variables: { note: "done" } });
  assert.equal(refreshed, true, "a successful completion invokes onSuccess (grid re-poll)");
});

test("buildEngineForm surfaces a completion failure in the rendered-form path", async (t) => {
  const created: FakeElement[] = [];
  const calls: FetchCall[] = [];
  t.after(installFakeDom(created));
  t.after(
    installFakeFetch((url) => {
      if (url.includes("/app/actions/form")) {
        return { status: 200, json: { schema: { components: [{ type: "textfield", key: "note" }] } } };
      }
      return { status: 500 }; // completion fails
    }, calls),
  );
  const box = buildEngineForm(CFG, { form_key: "form-e", user_task_key: "ut-e" }, () => {});
  assert.ok(box);
  await new Promise((r) => setTimeout(r, 0));
  const form = created.find((n) => n.tagName === "FORM");
  assert.ok(form, "the deployed schema was rendered");
  await form!.fire("submit");
  await new Promise((r) => setTimeout(r, 0));
  const msg = created.find((n) => n.className.includes("njf-msg") && n.className.includes("err"));
  assert.ok(msg, "a failed completion is surfaced to the operator (not silent)");
  assert.notEqual(msg!.textContent, "", "the error message element has text");
  const submit = created.find((n) => n.tagName === "BUTTON" && n.type === "submit");
  assert.equal(submit!.disabled, false, "the submit button is re-enabled so the operator can retry");
});

test("buildEngineForm degrades to bare completion when the row has no formKey", async (t) => {
  const created: FakeElement[] = [];
  const calls: FetchCall[] = [];
  t.after(installFakeDom(created));
  t.after(installFakeFetch(() => ({ status: 200, json: { ok: true } }), calls));
  const box = buildEngineForm(CFG, { user_task_key: "ut-2" }, () => {});
  assert.ok(box);
  // No form fetch — a bare "Complete" button is shown directly.
  assert.equal(calls.length, 0, "no formKey ⇒ no form resolution request");
  const button = created.find((n) => n.tagName === "BUTTON");
  assert.ok(button);
  assert.equal(button!.textContent, "Complete");
  await button!.fire("click");
  await new Promise((r) => setTimeout(r, 0));
  const completeReq = calls.find((c) => c.url.includes("/app/actions/complete"));
  assert.ok(completeReq, "the bare button completes the task");
  assert.equal(completeReq!.body.userTaskKey, "ut-2");
  assert.deepEqual(completeReq!.body.variables, {}, "bare completion sends empty variables");
});

test("buildEngineForm degrades to bare completion when the formKey resolves to no form (204)", async (t) => {
  const created: FakeElement[] = [];
  const calls: FetchCall[] = [];
  t.after(installFakeDom(created));
  t.after(
    installFakeFetch((url) => {
      if (url.includes("/app/actions/form")) return { status: 204 }; // no body
      return { status: 200, json: { ok: true } };
    }, calls),
  );
  const box = buildEngineForm(CFG, { form_key: "missing", user_task_key: "ut-3" }, () => {});
  assert.ok(box);
  await new Promise((r) => setTimeout(r, 0));
  assert.ok(calls.some((c) => c.url.includes("/app/actions/form")), "an unresolved formKey still hits the gate");
  const button = created.find((n) => n.tagName === "BUTTON" && n.textContent === "Complete");
  assert.ok(button, "a 204 (no form) falls back to the bare completion button");
});

test("buildEngineForm routes the rendered-form completion through a configured completePath", async (t) => {
  const created: FakeElement[] = [];
  const calls: FetchCall[] = [];
  t.after(installFakeDom(created));
  t.after(
    installFakeFetch((url) => {
      if (url.includes("/app/actions/form")) {
        return { status: 200, json: { schema: { components: [{ type: "textfield", key: "note" }] } } };
      }
      return { status: 200, json: { ok: true } };
    }, calls),
  );
  const box = buildEngineForm(
    { ...CFG, completePath: "/app/api/actions/complete-user-task" },
    { form_key: "form-c", user_task_key: "ut-c" },
    () => {},
  );
  assert.ok(box);
  await new Promise((r) => setTimeout(r, 0));
  const input = created.find((n) => n.tagName === "INPUT");
  input!.value = "done";
  const form = created.find((n) => n.tagName === "FORM");
  await form!.fire("submit");
  await new Promise((r) => setTimeout(r, 0));
  const completeReq = calls.find((c) => c.url.includes("/app/api/actions/complete-user-task"));
  assert.ok(completeReq, "completion POSTs to the configured completePath, not the generic seam");
  assert.equal(completeReq!.method, "POST");
  assert.deepEqual(completeReq!.body, { userTaskKey: "ut-c", variables: { note: "done" } });
  assert.equal(
    calls.some((c) => c.url.includes("/app/actions/complete")),
    false,
    "the generic seam is not called when completePath is set",
  );
});

test("buildEngineForm routes the bare completion through a configured completePath", async (t) => {
  const created: FakeElement[] = [];
  const calls: FetchCall[] = [];
  t.after(installFakeDom(created));
  t.after(installFakeFetch(() => ({ status: 200, json: { ok: true } }), calls));
  const box = buildEngineForm(
    { ...CFG, completePath: "/app/custom-complete" },
    { user_task_key: "ut-b" },
    () => {},
  );
  assert.ok(box);
  const button = created.find((n) => n.tagName === "BUTTON");
  await button!.fire("click");
  await new Promise((r) => setTimeout(r, 0));
  const completeReq = calls.find((c) => c.url.includes("/app/custom-complete"));
  assert.ok(completeReq, "the bare button completes via the configured completePath");
  assert.equal(completeReq!.body.userTaskKey, "ut-b");
  assert.deepEqual(completeReq!.body.variables, {}, "bare completion sends empty variables");
  assert.equal(
    calls.some((c) => c.url.includes("/app/actions/complete")),
    false,
    "the generic seam is not called when completePath is set",
  );
});

test("buildEngineForm falls back to the generic seam when completePath is empty/absent", async (t) => {
  const created: FakeElement[] = [];
  const calls: FetchCall[] = [];
  t.after(installFakeDom(created));
  t.after(installFakeFetch(() => ({ status: 200, json: { ok: true } }), calls));
  // An empty-string completePath is treated as absent (default seam preserved).
  const box = buildEngineForm({ ...CFG, completePath: "" }, { user_task_key: "ut-d" }, () => {});
  assert.ok(box);
  const button = created.find((n) => n.tagName === "BUTTON");
  await button!.fire("click");
  await new Promise((r) => setTimeout(r, 0));
  const completeReq = calls.find((c) => c.url.includes("/app/actions/complete"));
  assert.ok(completeReq, "an empty completePath still targets the default /app/actions/complete seam");
  assert.equal(completeReq!.body.userTaskKey, "ut-d");
});

test("buildEngineForm treats a whitespace-only completePath as absent", async (t) => {
  const created: FakeElement[] = [];
  const calls: FetchCall[] = [];
  t.after(installFakeDom(created));
  t.after(installFakeFetch(() => ({ status: 200, json: { ok: true } }), calls));
  // A whitespace-only completePath is normalized away so it never becomes an
  // unintended relative fetch target — the default seam is preserved.
  const box = buildEngineForm({ ...CFG, completePath: "   " }, { user_task_key: "ut-e" }, () => {});
  assert.ok(box);
  const button = created.find((n) => n.tagName === "BUTTON");
  await button!.fire("click");
  await new Promise((r) => setTimeout(r, 0));
  const completeReq = calls.find((c) => c.url.includes("/app/actions/complete"));
  assert.ok(completeReq, "a whitespace-only completePath still targets the default /app/actions/complete seam");
  assert.equal(completeReq!.body.userTaskKey, "ut-e");
});
