import assert from "node:assert/strict";
import { test } from "node:test";
import { addSafeInt, isNonNegInt, isPosInt } from "./validate.ts";

// Defect-class guard: relay integers are accumulated/decremented and round-trip
// through JSON, so a value beyond Number.MAX_SAFE_INTEGER would silently lose
// precision. The canonical guards must reject unsafe integers, not merely
// non-integers — this is the single rule every validation site derives from.
const UNSAFE = Number.MAX_SAFE_INTEGER + 1;

test("isNonNegInt accepts non-negative safe integers", () => {
  for (const v of [0, 1, 2, 100, Number.MAX_SAFE_INTEGER]) {
    assert.equal(isNonNegInt(v), true, `${v} should be a non-negative safe integer`);
  }
});

test("isNonNegInt rejects unsafe, negative, fractional, and non-number values", () => {
  for (const v of [UNSAFE, -1, -UNSAFE, 1.5, Number.NaN, Number.POSITIVE_INFINITY, "1", null, undefined, {}]) {
    assert.equal(isNonNegInt(v), false, `${String(v)} should be rejected`);
  }
});

test("isPosInt accepts positive safe integers only", () => {
  for (const v of [1, 2, 100, Number.MAX_SAFE_INTEGER]) {
    assert.equal(isPosInt(v), true, `${v} should be a positive safe integer`);
  }
  for (const v of [0, UNSAFE, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, "1", null, undefined]) {
    assert.equal(isPosInt(v), false, `${String(v)} should be rejected`);
  }
});

test("addSafeInt sums non-negative safe integers", () => {
  assert.equal(addSafeInt(0, 1, "x"), 1);
  assert.equal(addSafeInt(5, 7, "x"), 12);
  assert.equal(addSafeInt(Number.MAX_SAFE_INTEGER - 1, 1, "x"), Number.MAX_SAFE_INTEGER);
});

test("addSafeInt fails fast when accumulation would leave the safe-integer range", () => {
  // Both operands are individually safe, but their sum is not — a value that
  // would silently lose precision under further arithmetic/JSON round-trips.
  assert.throws(() => addSafeInt(Number.MAX_SAFE_INTEGER, 1, "credit"), RangeError);
  assert.throws(() => addSafeInt(Number.MAX_SAFE_INTEGER - 1, 2, "offset"), RangeError);
});
