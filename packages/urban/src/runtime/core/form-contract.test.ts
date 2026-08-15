import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildFormSchema,
  parseFormSchema,
  pickFormLinkage,
  resolveFormIdentifier,
} from "./form-contract.ts";

test("resolveFormIdentifier prefers a present formKey over a formId", () => {
  assert.deepEqual(resolveFormIdentifier({ formKey: "42", formId: "myForm" }), {
    kind: "key",
    value: "42",
  });
});

test("resolveFormIdentifier falls back to formId when formKey is absent/blank/whitespace", () => {
  assert.deepEqual(resolveFormIdentifier({ formId: "myForm" }), { kind: "id", value: "myForm" });
  for (const formKey of ["", "   "]) {
    assert.deepEqual(
      resolveFormIdentifier({ formKey, formId: "myForm" }),
      { kind: "id", value: "myForm" },
      `formKey=${JSON.stringify(formKey)} must fall through to formId`,
    );
  }
});

test("resolveFormIdentifier trims the resolved value and returns null when neither is present", () => {
  assert.deepEqual(resolveFormIdentifier({ formKey: "  42  " }), { kind: "key", value: "42" });
  assert.equal(resolveFormIdentifier({}), null);
  assert.equal(resolveFormIdentifier({ formKey: "  ", formId: "" }), null);
});

test("parseFormSchema parses a JSON-object string, passes an object through, and rejects the rest", () => {
  assert.deepEqual(parseFormSchema('{"a":1}'), { a: 1 });
  const obj = { a: 1 };
  assert.equal(parseFormSchema(obj), obj);
  assert.equal(parseFormSchema("not json"), null);
  assert.equal(parseFormSchema("[1,2]"), null, "a JSON array is not a form schema object");
  assert.equal(parseFormSchema(42), null);
  assert.equal(parseFormSchema(null), null);
});

test("buildFormSchema applies presence guards and stringifies a numeric formKey", () => {
  const schema = { components: [] };
  assert.deepEqual(buildFormSchema({ schema, formKey: 42, formId: "myForm", version: 3 }), {
    schema,
    formKey: "42",
    formId: "myForm",
    version: 3,
  });
  // Blank/garbage parts are omitted rather than surfaced as empty values.
  assert.deepEqual(buildFormSchema({ schema, formKey: "", formId: "", version: "3" }), { schema });
  assert.deepEqual(buildFormSchema({ schema }), { schema });
});

test("buildFormSchema trims padded identifiers and drops whitespace-only ones (the #252 drift bug)", () => {
  const schema = { components: [] };
  // Whitespace-only key/id are absent, not surfaced as " ".
  assert.deepEqual(buildFormSchema({ schema, formKey: "   ", formId: "  " }), { schema });
  // A padded key/id is trimmed to its space-free value, not surfaced with the padding.
  assert.deepEqual(buildFormSchema({ schema, formKey: "  42  ", formId: "  myForm  " }), {
    schema,
    formKey: "42",
    formId: "myForm",
  });
});

test("pickFormLinkage prefers a direct formKey and carries an externalFormReference", () => {
  assert.deepEqual(
    pickFormLinkage({ formKey: 42, externalFormReference: "https://x/form" }),
    { formKey: "42", externalFormReference: "https://x/form" },
  );
  // Blank linkage fields are treated as absent.
  assert.deepEqual(pickFormLinkage({ formKey: "", externalFormReference: "" }), {});
});

test("pickFormLinkage trims padded linkage fields and drops whitespace-only ones", () => {
  // Whitespace-only key/id/ref are absent, not surfaced with whitespace.
  assert.deepEqual(
    pickFormLinkage({ formKey: "   ", externalFormReference: "  " }),
    {},
  );
  // A padded key/ref is trimmed; a padded authored id is trimmed before the resolver sees it.
  assert.deepEqual(
    pickFormLinkage({ formKey: "  7  ", externalFormReference: "  https://x/form  " }),
    { formKey: "7", externalFormReference: "https://x/form" },
  );
  assert.deepEqual(
    pickFormLinkage({ formId: "  myForm  " }, (id) => (id === "myForm" ? "form-7" : undefined)),
    { formKey: "form-7" },
    "the authored formId is trimmed before the key resolver is called",
  );
});

test("pickFormLinkage resolves an authored formId to a deploy key only via the callback", () => {
  const raw = { formId: "myForm" };
  // No resolver (the gateway path): an authored id is not turned into a key.
  assert.deepEqual(pickFormLinkage(raw), {});
  // With a resolver (the WASM/key-addressed path): the id maps to the latest deploy key.
  assert.deepEqual(
    pickFormLinkage(raw, (id) => (id === "myForm" ? "form-7" : undefined)),
    { formKey: "form-7" },
  );
});
