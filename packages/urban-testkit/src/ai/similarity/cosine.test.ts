import assert from "node:assert/strict";
import { test } from "node:test";
import { cosineSimilarity } from "./cosine.ts";

test("cosine: identical vectors have similarity 1", () => {
  assert.equal(cosineSimilarity([1, 2, 3], [1, 2, 3]), 1);
});

test("cosine: orthogonal vectors have similarity 0", () => {
  assert.equal(cosineSimilarity([1, 0], [0, 1]), 0);
});

test("cosine: a zero-magnitude vector yields 0 (no direction)", () => {
  assert.equal(cosineSimilarity([0, 0], [1, 1]), 0);
  assert.equal(cosineSimilarity([0, 0], [0, 0]), 0);
});

test("cosine: opposite vectors yield -1", () => {
  assert.ok(Math.abs(cosineSimilarity([1, 1], [-1, -1]) - -1) < 1e-12);
});

test("cosine: partial overlap yields a known intermediate value", () => {
  // a=[1,1,0], b=[1,0,1] -> dot 1, |a|=|b|=sqrt2 -> 0.5
  assert.ok(Math.abs(cosineSimilarity([1, 1, 0], [1, 0, 1]) - 0.5) < 1e-12);
});

test("cosine: unequal-length vectors throw", () => {
  assert.throws(() => cosineSimilarity([1, 2], [1, 2, 3]), /equal-length/);
});
