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

// ── #603: variables context — text templating, image component, prefill ──────

test("buildField templates {{name}} placeholders in a text component from the context", (t) => {
  const created: FakeElement[] = [];
  t.after(installFakeDom(created));
  const built = buildField(
    { type: "text", text: "Review {{title}} by {{author}} ({{count}} comments)" },
    { title: "Draft v2", author: "ada", count: 3 },
  );
  assert.equal(built!.field.textContent, "Review Draft v2 by ada (3 comments)");
});

test("buildField templating: unknown names become empty, objects stringify as JSON", (t) => {
  const created: FakeElement[] = [];
  t.after(installFakeDom(created));
  const built = buildField(
    { type: "text", text: "[{{missing}}] {{payload}}" },
    { payload: { a: 1 } },
  );
  assert.equal(built!.field.textContent, "[] {\"a\":1}");
});

test("buildField templating is textContent-only — a variable holding markup renders as literal text", (t) => {
  const created: FakeElement[] = [];
  t.after(installFakeDom(created));
  const evil = "<img src=x onerror=alert(1)>";
  const built = buildField({ type: "text", text: "Draft: {{body}}" }, { body: evil });
  // The value went through textContent, so it is literal text — the fake DOM has no
  // innerHTML path at all, so asserting the textContent round-trips the markup
  // character-for-character pins the no-markup-injection rule for templated text.
  assert.equal(built!.field.textContent, "Draft: " + evil);
  assert.equal(built!.field.children.length, 0, "no child elements were created from the markup");
});

test("buildField renders an image component with a literal URL source", (t) => {
  const created: FakeElement[] = [];
  t.after(installFakeDom(created));
  const built = buildField({ type: "image", source: "https://cdn.example.com/t1.png", alt: "Thumb 1" }, {});
  assert.ok(built && !built.read, "an image component is keyless (no reader)");
  const img = created.find((n) => n.tagName === "IMG");
  assert.ok(img);
  assert.equal(img!.getAttribute("src"), "https://cdn.example.com/t1.png");
  assert.equal(img!.getAttribute("alt"), "Thumb 1");
  assert.equal(img!.getAttribute("class"), "njf-image");
});

test("buildField resolves an image =varName source from the context (plain variable reference)", (t) => {
  const created: FakeElement[] = [];
  t.after(installFakeDom(created));
  const built = buildField(
    { type: "image", source: "=img1", alt: "Choice 1" },
    { img1: "data:image/png;base64,iVBORw0KGgo=" },
  );
  const img = created.find((n) => n.tagName === "IMG");
  assert.ok(img);
  assert.equal(img!.getAttribute("src"), "data:image/png;base64,iVBORw0KGgo=");
});

test("buildField rejects unsafe image sources — javascript:, other schemes, protocol-relative, non-identifier =expr", (t) => {
  const created: FakeElement[] = [];
  t.after(installFakeDom(created));
  assert.equal(buildField({ type: "image", source: "javascript:alert(1)" }, {}), null, "javascript: rejected");
  assert.equal(buildField({ type: "image", source: "=evil" }, { evil: "javascript:alert(1)" }), null, "a variable holding javascript: is rejected");
  assert.equal(buildField({ type: "image", source: "data:text/html;base64,PGI+" }, {}), null, "non-image data: rejected");
  assert.equal(buildField({ type: "image", source: "//evil.example.com/x.png" }, {}), null, "protocol-relative rejected");
  assert.equal(buildField({ type: "image", source: "=foo.bar" }, { foo: { bar: "/x.png" } }), null, "a FEEL path (not a plain variable) is rejected");
  assert.equal(buildField({ type: "image", source: "=missing" }, {}), null, "an unknown variable resolves to nothing");
  assert.equal(buildField({ type: "image" }, {}), null, "no source at all renders nothing");
  assert.equal(created.filter((n) => n.tagName === "IMG").length, 0, "no <img> was created for a rejected source");
});

test("buildField allows app-relative image sources", (t) => {
  const created: FakeElement[] = [];
  t.after(installFakeDom(created));
  const built = buildField({ type: "image", source: "/assets/thumb.png" }, {});
  assert.ok(built);
  assert.equal(created.find((n) => n.tagName === "IMG")!.getAttribute("src"), "/assets/thumb.png");
});

test("buildField prefills a textfield and textarea from the context", (t) => {
  const created: FakeElement[] = [];
  t.after(installFakeDom(created));
  buildField({ type: "textfield", key: "title" }, { title: "Draft v2" });
  buildField({ type: "textarea", key: "body" }, { body: "once upon a time" });
  const input = created.find((n) => n.tagName === "INPUT");
  const area = created.find((n) => n.tagName === "TEXTAREA");
  assert.equal(input!.value, "Draft v2");
  assert.equal(area!.value, "once upon a time");
});

test("buildField prefills a radio group and a select from the context", (t) => {
  const created: FakeElement[] = [];
  t.after(installFakeDom(created));
  const radio = buildField(
    {
      type: "radio",
      key: "choice",
      values: [
        { value: "t1", label: "One" },
        { value: "t2", label: "Two" },
      ],
    },
    { choice: "t2" },
  );
  const radios = created.filter((n) => n.tagName === "INPUT" && n.type === "radio");
  assert.equal(radios[0].checked, false);
  assert.equal(radios[1].checked, true, "the context-matching option is checked");
  assert.deepEqual(radio!.read!(), { key: "choice", value: "t2" }, "the prefill is submitted unchanged when untouched");

  const select = buildField(
    {
      type: "select",
      key: "color",
      values: [
        { value: "r", label: "Red" },
        { value: "g", label: "Green" },
      ],
    },
    { color: "g" },
  );
  const sel = created.find((n) => n.tagName === "SELECT");
  assert.equal(sel!.value, "g");
  assert.deepEqual(select!.read!(), { key: "color", value: "g" });
});

test("buildField prefills a checkbox from a boolean context value", (t) => {
  const created: FakeElement[] = [];
  t.after(installFakeDom(created));
  const built = buildField({ type: "checkbox", key: "agree" }, { agree: true });
  const input = created.find((n) => n.tagName === "INPUT");
  assert.equal(input!.checked, true);
  assert.deepEqual(built!.read!(), { key: "agree", value: true });
});

test("buildField prefill: an absent key leaves the input untouched (backwards compatible)", (t) => {
  const created: FakeElement[] = [];
  t.after(installFakeDom(created));
  const built = buildField({ type: "textfield", key: "note" }, { other: "x" });
  const input = created.find((n) => n.tagName === "INPUT");
  assert.equal(input!.value, "", "no context key → no prefill");
  assert.equal(built!.read!(), null, "an untouched blank field is still omitted");
});

test("renderForm passes opts.context through to every component", (t) => {
  const created: FakeElement[] = [];
  t.after(installFakeDom(created));
  const schema = {
    components: [
      { type: "text", text: "Reviewing {{title}}" },
      { type: "image", source: "=img1", alt: "thumb" },
      { type: "textfield", key: "title" },
    ],
  };
  renderForm(schema, {
    context: { title: "Draft v2", img1: "https://cdn.example.com/t.png" },
    onSubmit: () => {},
  });
  const p = created.find((n) => n.tagName === "P");
  assert.equal(p!.textContent, "Reviewing Draft v2");
  const img = created.find((n) => n.tagName === "IMG");
  assert.equal(img!.getAttribute("src"), "https://cdn.example.com/t.png");
  const input = created.find((n) => n.tagName === "INPUT");
  assert.equal(input!.value, "Draft v2", "keyed input prefilled from the same context");
});

test("renderForm without a context renders exactly as before (backwards compatible)", (t) => {
  const created: FakeElement[] = [];
  t.after(installFakeDom(created));
  renderForm(
    { components: [{ type: "text", text: "Static {{notReplaced}}" }, { type: "textfield", key: "n" }] },
    { onSubmit: () => {} },
  );
  const p = created.find((n) => n.tagName === "P");
  assert.equal(p!.textContent, "Static ", "unknown names template to empty even with no context");
  const input = created.find((n) => n.tagName === "INPUT");
  assert.equal(input!.value, "");
});

// ── PR #604 review: defect classes hardened ──────────────────────────────────

test("buildField rejects disguised unsafe image URLs — whitespace, control chars, backslashes", (t) => {
  const created: FakeElement[] = [];
  t.after(installFakeDom(created));
  const disguised = [
    "java\tscript:alert(1)",
    "java\nscript:alert(1)",
    " javascript:alert(1)",
    " data:image/svg+xml,<svg onload=alert(1)>",
    "\u0000javascript:alert(1)",
    "/\\evil.example.com/x.png",
    "\\\\evil.example.com/x.png",
    "https://ok.example.com/a b.png",
    "/x.png\u007f",
  ];
  for (const source of disguised) {
    assert.equal(buildField({ type: "image", source }, {}), null, `literal ${JSON.stringify(source)} rejected`);
    assert.equal(buildField({ type: "image", source: "=u" }, { u: source }), null, `variable ${JSON.stringify(source)} rejected`);
  }
  assert.equal(created.filter((n) => n.tagName === "IMG").length, 0);
});

test("buildField ignores inherited prototype members of the context (own properties only)", (t) => {
  const created: FakeElement[] = [];
  t.after(installFakeDom(created));
  for (const key of ["__proto__", "constructor", "toString", "hasOwnProperty"]) {
    const built = buildField({ type: "textfield", key }, {});
    const input = created.filter((n) => n.tagName === "INPUT").at(-1);
    assert.equal(input!.value, "", `${key}: an absent prototype member does not prefill`);
    assert.equal(built!.read!(), null, `${key}: untouched field is omitted`);
  }
  const text = buildField({ type: "text", text: "[{{constructor}}][{{toString}}]" }, {});
  assert.equal(text!.field.textContent, "[][]", "unknown prototype-member placeholders render empty");
  assert.equal(buildField({ type: "image", source: "=constructor" }, {}), null);
});

test("buildField honours explicitly supplied own values named like prototype members", (t) => {
  const created: FakeElement[] = [];
  t.after(installFakeDom(created));
  const ctx = JSON.parse('{"__proto__":"P","constructor":"C"}');
  buildField({ type: "textfield", key: "__proto__" }, ctx);
  buildField({ type: "textfield", key: "constructor" }, ctx);
  const inputs = created.filter((n) => n.tagName === "INPUT");
  assert.equal(inputs[0]!.value, "P");
  assert.equal(inputs[1]!.value, "C");
  const text = buildField({ type: "text", text: "{{__proto__}}/{{constructor}}" }, ctx);
  assert.equal(text!.field.textContent, "P/C");
});

// ── PR #604 round 3: comma data URLs, mount-rebased image sources, cleared prefill ──

test("buildField allows a comma-delimited image data URL (no parameters, no ;base64)", (t) => {
  const created: FakeElement[] = [];
  t.after(installFakeDom(created));
  // RFC 2397: the mediatype may be followed directly by `,` — parameters and
  // `;base64` are both optional. A percent-encoded PNG payload is a valid source.
  const literal = "data:image/png,%89PNG%0D%0A%1A%0A";
  const built = buildField({ type: "image", source: literal }, {});
  assert.ok(built, "a comma-delimited data:image/png URL is accepted");
  assert.equal(created.find((n) => n.tagName === "IMG")!.getAttribute("src"), literal);
  // The same URL arriving via a `=varName` reference is accepted too.
  created.length = 0;
  const viaVar = buildField({ type: "image", source: "=img" }, { img: literal });
  assert.ok(viaVar, "a comma-delimited data URL from a variable is accepted");
  assert.equal(created.find((n) => n.tagName === "IMG")!.getAttribute("src"), literal);
});

test("buildField image source: opts.resolveUrl rebases a root-relative source onto the app mount", (t) => {
  const created: FakeElement[] = [];
  t.after(installFakeDom(created));
  // Behind the console proxy the app is mounted at /console/app-view/demo/: a
  // literal (or variable) source of /app/thumb.png must request the APP's
  // /app/thumb.png, not the console's. Both surfaces pass their mount-aware URL
  // resolver as opts.resolveUrl; the resolver is applied AFTER the scheme
  // allowlist, so it can never launder a rejected URL.
  const rebase = (u: string) =>
    u.startsWith("/") && !u.startsWith("//") ? "/console/app-view/demo" + u : u;
  const literal = buildField({ type: "image", source: "/app/thumb.png" }, {}, { resolveUrl: rebase });
  assert.equal(
    created.filter((n) => n.tagName === "IMG").at(-1)!.getAttribute("src"),
    "/console/app-view/demo/app/thumb.png",
    "a literal root-relative source is rebased onto the app mount",
  );
  assert.ok(literal);
  const viaVar = buildField({ type: "image", source: "=img" }, { img: "/app/thumb.png" }, { resolveUrl: rebase });
  assert.equal(
    created.filter((n) => n.tagName === "IMG").at(-1)!.getAttribute("src"),
    "/console/app-view/demo/app/thumb.png",
    "a variable holding a root-relative source is rebased too",
  );
  assert.ok(viaVar);
  // Absolute http(s) and data: URLs pass through the resolver untouched (the
  // resolver only rewrites single-leading-slash paths, exactly like apiUrl).
  buildField({ type: "image", source: "https://cdn.example.com/t.png" }, {}, { resolveUrl: rebase });
  assert.equal(
    created.filter((n) => n.tagName === "IMG").at(-1)!.getAttribute("src"),
    "https://cdn.example.com/t.png",
    "an absolute URL is not rewritten",
  );
  // Without a resolver the historical behaviour stands (backwards compatible).
  buildField({ type: "image", source: "/app/thumb.png" }, {});
  assert.equal(
    created.filter((n) => n.tagName === "IMG").at(-1)!.getAttribute("src"),
    "/app/thumb.png",
    "no resolver → the source is used verbatim",
  );
  // The allowlist still runs first: a rejected source never reaches the resolver.
  assert.equal(buildField({ type: "image", source: "javascript:alert(1)" }, {}, { resolveUrl: rebase }), null);
});

test("renderForm threads opts.resolveUrl through to every image component", (t) => {
  const created: FakeElement[] = [];
  t.after(installFakeDom(created));
  const rebase = (u: string) => (u.startsWith("/") && !u.startsWith("//") ? "/mounted" + u : u);
  renderForm(
    { components: [{ type: "image", source: "/app/a.png" }, { type: "image", source: "=img" }] },
    { context: { img: "/app/b.png" }, resolveUrl: rebase, onSubmit: () => {} },
  );
  const srcs = created.filter((n) => n.tagName === "IMG").map((n) => n.getAttribute("src"));
  assert.deepEqual(srcs, ["/mounted/app/a.png", "/mounted/app/b.png"]);
});

test("buildField submits an empty string when a prefilled textfield/textarea is cleared", (t) => {
  const created: FakeElement[] = [];
  t.after(installFakeDom(created));
  const tf = buildField({ type: "textfield", key: "title" }, { title: "Draft v2" });
  const ta = buildField({ type: "textarea", key: "body" }, { body: "once upon a time" });
  const input = created.find((n) => n.tagName === "INPUT")!;
  const area = created.find((n) => n.tagName === "TEXTAREA")!;
  assert.equal(input.value, "Draft v2");
  assert.equal(area.value, "once upon a time");
  input.value = "";
  area.value = "";
  assert.deepEqual(tf!.read!(), { key: "title", value: "" }, "a cleared prefilled textfield submits an empty string");
  assert.deepEqual(ta!.read!(), { key: "body", value: "" }, "a cleared prefilled textarea submits an empty string");
});

test("buildField submits an empty string when a prefilled select is set back to the blank option", (t) => {
  const created: FakeElement[] = [];
  t.after(installFakeDom(created));
  const built = buildField(
    {
      type: "select",
      key: "color",
      values: [
        { value: "r", label: "Red" },
        { value: "g", label: "Green" },
      ],
    },
    { color: "g" },
  );
  const sel = created.find((n) => n.tagName === "SELECT")!;
  assert.equal(sel.value, "g", "prefilled from the context");
  sel.value = ""; // the operator chooses the blank "—" option
  assert.deepEqual(built!.read!(), { key: "color", value: "" }, "a cleared prefilled select submits an empty string");
});

test("buildField cleared-prefill regressions hold for number fields and no-context omission is preserved", (t) => {
  const created: FakeElement[] = [];
  t.after(installFakeDom(created));
  // A cleared prefilled NUMBER field submits an empty string (explicitly cleared),
  // never null/NaN.
  const num = buildField({ type: "number", key: "qty" }, { qty: 3 });
  const numInput = created.filter((n) => n.tagName === "INPUT").at(-1)!;
  assert.equal(numInput.value, "3");
  numInput.value = "";
  assert.deepEqual(num!.read!(), { key: "qty", value: "" }, "a cleared prefilled number field submits an empty string");
  // No-context fields keep the historical omission behaviour: a blank field that
  // was never prefilled is left out of the submitted variables entirely.
  const plain = buildField({ type: "textfield", key: "note" }, { other: "x" });
  const plainInput = created.filter((n) => n.tagName === "INPUT").at(-1)!;
  assert.equal(plainInput.value, "");
  assert.equal(plain!.read!(), null, "an untouched blank field with no prefill is still omitted");
  const plainSelect = buildField(
    { type: "select", key: "s", values: [{ value: "a", label: "A" }] },
    {},
  );
  const sel = created.filter((n) => n.tagName === "SELECT").at(-1)!;
  assert.equal(sel.value, "");
  assert.equal(plainSelect!.read!(), null, "an untouched blank select with no prefill is still omitted");
});

// ── PR #604 round 4: a REJECTED prefill is not a prefill — never overwrite with "" ──

test("buildField select: a context value absent from values[] is a rejected prefill — untouched submit omits the key", (t) => {
  const created: FakeElement[] = [];
  t.after(installFakeDom(created));
  // The context value "b" matches NO option: a real browser select rejects the
  // assignment and snaps back to the blank option. Model that native sanitization
  // by leaving the fake control's value at "" (what the DOM would report).
  const built = buildField(
    {
      type: "select",
      key: "color",
      values: [
        { value: "r", label: "Red" },
        { value: "g", label: "Green" },
      ],
    },
    { color: "b" },
  );
  const sel = created.find((n) => n.tagName === "SELECT")!;
  assert.ok(sel, "the select control was built");
  // A real select snaps an out-of-range assignment back to the blank option; model
  // that native behaviour (the fake DOM stores values verbatim). The renderer's
  // guard is structural — the rejected value never counted as a prefill.
  sel.value = "";
  assert.equal(
    built!.read!(),
    null,
    "an untouched form must NOT overwrite the original variable with an empty string",
  );
});

test("buildField datetime-local: a timezone-bearing prefill the control rejects is omitted, not submitted as empty", (t) => {
  const created: FakeElement[] = [];
  t.after(installFakeDom(created));
  // A datetime-local control accepts only "YYYY-MM-DDTHH:mm" (no zone designator);
  // the fake DOM models the browser blanking a timezone-bearing value at
  // assignment time (see fake-dom.test-utils.ts), so the renderer's read-back
  // sees exactly what the DOM would report.
  const built = buildField({ type: "datetime", key: "due" }, { due: "2026-11-04T10:30:00Z" });
  const input = created.find((n) => n.tagName === "INPUT")!;
  assert.equal(input.value, "", "the control rejected the zoned value at assignment");
  assert.equal(
    built!.read!(),
    null,
    "a rejected datetime prefill leaves the original variable untouched on submit",
  );
  // …while a plain local datetime the control CAN hold is still a successful prefill.
  const ok = buildField({ type: "datetime", key: "start" }, { start: "2026-11-04T10:30" });
  const okInput = created.filter((n) => n.tagName === "INPUT").at(-1)!;
  assert.equal(okInput.value, "2026-11-04T10:30");
  assert.deepEqual(ok!.read!(), { key: "start", value: "2026-11-04T10:30" });
});

test("buildField rejected-prefill guard still allows an explicit clear after a SUCCESSFUL prefill", (t) => {
  const created: FakeElement[] = [];
  t.after(installFakeDom(created));
  // Select: a value present in values[] IS accepted, so clearing it afterwards is
  // an explicit clear and submits "".
  const sel = buildField(
    {
      type: "select",
      key: "color",
      values: [
        { value: "r", label: "Red" },
        { value: "g", label: "Green" },
      ],
    },
    { color: "g" },
  );
  const selEl = created.find((n) => n.tagName === "SELECT")!;
  assert.equal(selEl.value, "g", "accepted prefill");
  selEl.value = "";
  assert.deepEqual(sel!.read!(), { key: "color", value: "" }, "clearing an accepted select prefill submits an empty string");
  // Typed input: a valid local datetime IS accepted; clearing it submits "".
  const dt = buildField({ type: "datetime", key: "start" }, { start: "2026-11-04T10:30" });
  const dtInput = created.filter((n) => n.tagName === "INPUT").at(-1)!;
  assert.equal(dtInput.value, "2026-11-04T10:30", "accepted prefill");
  dtInput.value = "";
  assert.deepEqual(dt!.read!(), { key: "start", value: "" }, "clearing an accepted datetime prefill submits an empty string");
});
