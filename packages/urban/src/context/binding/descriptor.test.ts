import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ContextBindingError,
  isContextBinding,
  parseContextBinding,
} from "./descriptor.ts";

test("parseContextBinding accepts a well-formed { repo, ref } and trims", () => {
  const binding = parseContextBinding({ repo: "  owner/name  ", ref: "  main  " });
  assert.deepEqual(binding, { repo: "owner/name", ref: "main" });
});

test("parseContextBinding ignores unknown extra fields (forward-compatible)", () => {
  const binding = parseContextBinding({ repo: "owner/name", ref: "v1", future: 42 });
  assert.deepEqual(binding, { repo: "owner/name", ref: "v1" });
});

test("parseContextBinding rejects non-objects with a clear message", () => {
  assert.throws(() => parseContextBinding(null), ContextBindingError);
  assert.throws(() => parseContextBinding("owner/name#main"), /must be an object/);
  assert.throws(() => parseContextBinding(undefined), ContextBindingError);
});

test("parseContextBinding rejects arrays as not-an-object (typeof [] === 'object')", () => {
  assert.throws(() => parseContextBinding([]), /must be an object/);
  assert.throws(() => parseContextBinding(["owner/name", "main"]), /must be an object/);
  assert.equal(isContextBinding([]), false);
});

test("parseContextBinding rejects a missing or empty repo", () => {
  assert.throws(() => parseContextBinding({ ref: "main" }), /"repo" is required/);
  assert.throws(() => parseContextBinding({ repo: "   ", ref: "main" }), /"repo" is required/);
  assert.throws(() => parseContextBinding({ repo: 5, ref: "main" }), /"repo" is required/);
});

test("parseContextBinding rejects a missing or empty ref", () => {
  assert.throws(() => parseContextBinding({ repo: "owner/name" }), /"ref" is required/);
  assert.throws(() => parseContextBinding({ repo: "owner/name", ref: "" }), /"ref" is required/);
});

test("isContextBinding is a total type guard", () => {
  assert.equal(isContextBinding({ repo: "owner/name", ref: "main" }), true);
  assert.equal(isContextBinding({ repo: "owner/name" }), false);
  assert.equal(isContextBinding(42), false);
});
