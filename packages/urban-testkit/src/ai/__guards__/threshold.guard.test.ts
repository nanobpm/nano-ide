// S5 threshold-boundary guard (issue #297): with a deterministic fake returning a FIXED
// cosine score, a threshold just-below vs just-above that score flips the
// `matchesSemantically` result deterministically. Network-free.

import assert from "node:assert/strict";
import { test } from "node:test";
import { assertThatText } from "../index.ts";
import type { EmbeddingModelAdapter } from "../seams.ts";

// A deterministic fake whose two inputs embed to [1,0] and [1,1] → cosine = 1/√2. Fixing the
// score lets us probe the >= boundary exactly, independent of the bag-of-tokens fake.
const FIXED_SCORE = 1 / Math.SQRT2;

const fixedScoreAdapter: EmbeddingModelAdapter = {
  modelId: "fixed-score",
  dimension: 2,
  async embed(text: string): Promise<number[]> {
    if (text === "LEFT") {
      return [1, 0];
    }
    if (text === "RIGHT") {
      return [1, 1];
    }
    throw new Error(`fixedScoreAdapter received unexpected text: ${JSON.stringify(text)}`);
  },
};

// Sanity floor: the fixed score sits strictly inside (0, 1) so both a just-below and a
// just-above threshold are valid cosine values in [0, 1].
const JUST_BELOW = FIXED_SCORE - 0.05;
const JUST_ABOVE = FIXED_SCORE + 0.05;

test("threshold boundary: a threshold just BELOW the fixed score PASSES", async () => {
  await assertThatText("LEFT").matchesSemantically("RIGHT", {
    threshold: JUST_BELOW,
    adapter: fixedScoreAdapter,
  });
});

test("threshold boundary: a threshold just ABOVE the fixed score FAILS", async () => {
  await assert.rejects(
    assertThatText("LEFT").matchesSemantically("RIGHT", {
      threshold: JUST_ABOVE,
      adapter: fixedScoreAdapter,
    }),
    /matchesSemantically failed/,
  );
});

test("threshold boundary: a threshold EQUAL to the fixed score PASSES (match is score >= threshold)", async () => {
  await assertThatText("LEFT").matchesSemantically("RIGHT", {
    threshold: FIXED_SCORE,
    adapter: fixedScoreAdapter,
  });
});
