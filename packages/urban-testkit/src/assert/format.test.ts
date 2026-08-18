import assert from "node:assert";
import { AssertionError } from "node:assert";
import { test } from "node:test";

import { deepEqual, deepSubset, failAssertion, formatValue, renderDiff } from "./format.ts";

test("formatValue renders objects with deterministically sorted keys", () => {
  const a = formatValue({ b: 1, a: 2, c: { z: 1, y: 2 } });
  const b = formatValue({ c: { y: 2, z: 1 }, a: 2, b: 1 });
  assert.equal(a, b);
  assert.equal(a, '{"a": 2, "b": 1, "c": {"y": 2, "z": 1}}');
});

test("formatValue handles primitives, arrays, null/undefined, and cycles", () => {
  assert.equal(formatValue("x"), '"x"');
  assert.equal(formatValue(3), "3");
  assert.equal(formatValue(null), "null");
  assert.equal(formatValue(undefined), "undefined");
  assert.equal(formatValue([1, "a", true]), '[1, "a", true]');
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  assert.equal(formatValue(cyclic), '{"self": [Circular]}');
});

test("renderDiff names expected then actual", () => {
  assert.equal(renderDiff(1, 2), "  expected: 2\n  actual:   1");
});

test("failAssertion throws an AssertionError with a formatted diff", () => {
  assert.throws(
    () => failAssertion({ message: "state mismatch", actual: "ACTIVE", expected: "COMPLETED" }),
    (err: unknown) => {
      assert.ok(err instanceof AssertionError);
      assert.match(err.message, /state mismatch/);
      assert.match(err.message, /expected: "COMPLETED"/);
      assert.match(err.message, /actual: {3}"ACTIVE"/);
      return true;
    },
  );
});

test("failAssertion with diff:false omits the actual/expected block", () => {
  assert.throws(
    () => failAssertion({ message: "no instance", operator: "resolveInstance", diff: false }),
    (err: unknown) => {
      assert.ok(err instanceof AssertionError);
      assert.equal(err.message, "no instance");
      return true;
    },
  );
});

test("deepEqual compares structurally, order-independent for object keys", () => {
  assert.ok(deepEqual({ a: 1, b: [1, 2] }, { b: [1, 2], a: 1 }));
  assert.ok(!deepEqual({ a: 1 }, { a: 1, b: 2 }));
  assert.ok(!deepEqual([1, 2], [2, 1]));
});

test("deepSubset matches a subset and ignores extra keys", () => {
  assert.ok(deepSubset({ a: 1, b: 2, c: 3 }, { a: 1, c: 3 }));
  assert.ok(deepSubset({ nested: { x: 1, y: 2 } }, { nested: { x: 1 } }));
  assert.ok(!deepSubset({ a: 1 }, { a: 2 }));
  assert.ok(!deepSubset({ a: 1 }, { b: 1 }));
});
