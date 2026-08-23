// Unit tests for the shared form-js renderer (formjs.browser.js, ADR 0026/#457):
// the ONE client implementation of "render a deployed .form's form-js schema and
// collect its field values", shared by BOTH the taskInbox surface and the pages
// dataGrid engine-form detail. Importing the module also registers it as the
// `globalThis.NanoFormJs` global that the pages runtime consumes.

import { test } from "node:test";
import assert from "node:assert/strict";
import { buildField, renderForm } from "./formjs.browser.js";
import { type FakeElement, installFakeDom } from "./fake-dom.test-utils.ts";

test("NanoFormJs is registered as a browser global on import", () => {
  const g = Reflect.get(globalThis, "NanoFormJs");
  assert.ok(g, "importing the module exposes globalThis.NanoFormJs");
});

test("buildField skips keyless layout components and renders static text", (t) => {
  const created: FakeElement[] = [];
  t.after(installFakeDom(created));
  assert.equal(buildField({ type: "spacer" }), null, "a keyless, non-text component is skipped");
  const textOnly = buildField({ type: "text", text: "Read me" });
  assert.ok(textOnly && !textOnly.read, "a static text component has no reader");
  assert.equal(textOnly!.field.textContent, "Read me");
});

test("buildField reads a textfield's entered value, and omits a blank one", (t) => {
  const created: FakeElement[] = [];
  t.after(installFakeDom(created));
  const built = buildField({ type: "textfield", key: "note", label: "Note" });
  assert.ok(built?.read);
  const input = created.find((n) => n.tagName === "INPUT");
  assert.ok(input);
  input!.value = "hello";
  assert.deepEqual(built!.read!(), { key: "note", value: "hello" });
  input!.value = "";
  assert.equal(built!.read!(), null, "a blank field is omitted from the submitted variables");
});

test("buildField coerces a number field and drops a non-finite value", (t) => {
  const created: FakeElement[] = [];
  t.after(installFakeDom(created));
  const built = buildField({ type: "number", key: "qty" });
  const input = created.find((n) => n.tagName === "INPUT");
  input!.value = "42";
  assert.deepEqual(built!.read!(), { key: "qty", value: 42 });
  input!.value = "not-a-number";
  assert.equal(built!.read!(), null, "a tampered non-numeric number field is treated as absent, never NaN→null");
});

test("buildField maps a checkbox to a boolean value", (t) => {
  const created: FakeElement[] = [];
  t.after(installFakeDom(created));
  const built = buildField({ type: "checkbox", key: "agree", label: "Agree" });
  const input = created.find((n) => n.tagName === "INPUT");
  input!.checked = true;
  assert.deepEqual(built!.read!(), { key: "agree", value: true });
});

test("buildField reads the checked radio option (and omits an unselected group)", (t) => {
  const created: FakeElement[] = [];
  t.after(installFakeDom(created));
  const built = buildField({
    type: "radio",
    key: "size",
    label: "Size",
    values: [
      { value: "s", label: "Small" },
      { value: "l", label: "Large" },
    ],
  });
  assert.ok(built?.read);
  assert.equal(built!.read!(), null, "an unselected radio group is omitted from the submitted variables");
  const radios = created.filter((n) => n.tagName === "INPUT" && n.type === "radio");
  assert.equal(radios.length, 2);
  radios[1].checked = true;
  assert.deepEqual(built!.read!(), { key: "size", value: "l" }, "read() finds the checked option via querySelector('input:checked')");
});

test("renderForm submits a null-prototype variables bag (prototype-pollution safe)", async (t) => {
  const created: FakeElement[] = [];
  t.after(installFakeDom(created));
  const schema = {
    components: [
      { type: "textfield", key: "note" },
      { type: "textfield", key: "__proto__" },
    ],
  };
  let submitted: Record<string, unknown> | undefined;
  const form = renderForm(schema, {
    heading: "Task A",
    onSubmit: (variables) => {
      submitted = variables;
    },
  });
  const inputs = created.filter((n) => n.tagName === "INPUT");
  inputs[0].value = "hi";
  inputs[1].value = "evil";
  await form.fire("submit");
  assert.ok(submitted);
  assert.equal(Object.getPrototypeOf(submitted!), null, "the variables bag has a null prototype");
  assert.equal(submitted!.note, "hi");
  assert.equal(Object.prototype.hasOwnProperty.call(submitted!, "__proto__"), true, "an untrusted key lands as an own property");
  assert.equal(Object.getPrototypeOf({}), Object.prototype, "no prototype was mutated");
});

test("renderForm re-enables the submit button when onSubmit rejects (retryable)", async (t) => {
  const created: FakeElement[] = [];
  t.after(installFakeDom(created));
  const form = renderForm(
    { components: [{ type: "textfield", key: "x" }] },
    {
      onSubmit: () => Promise.reject(new Error("boom")),
    },
  );
  const submit = created.find((n) => n.tagName === "BUTTON" && n.type === "submit");
  assert.ok(submit);
  await form.fire("submit");
  // The rejected onSubmit settles a microtask later; flush it.
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(submit!.disabled, false, "a failed submit re-enables the button so the operator can retry");
});

test("renderForm wires a cancel button only when onCancel is supplied", async (t) => {
  const created: FakeElement[] = [];
  t.after(installFakeDom(created));
  renderForm({ components: [] }, { onSubmit: () => {} });
  assert.equal(created.filter((n) => n.tagName === "BUTTON").length, 1, "no cancel button without onCancel");
  created.length = 0;
  let cancelled = false;
  renderForm({ components: [] }, { onSubmit: () => {}, onCancel: () => (cancelled = true) });
  const buttons = created.filter((n) => n.tagName === "BUTTON");
  assert.equal(buttons.length, 2, "a cancel button is added when onCancel is supplied");
  await buttons[1].fire("click");
  assert.equal(cancelled, true, "clicking cancel invokes onCancel");
});
