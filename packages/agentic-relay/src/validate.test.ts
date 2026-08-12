import assert from "node:assert/strict";
import { test } from "node:test";
import { isNonNegInt, isPosInt } from "./validate.ts";

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
