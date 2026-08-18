import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { assertThatText } from "../assertion.ts";
import type { TextPreprocessor } from "../config.ts";
import { FakeEmbeddingModelAdapter } from "../fakes.ts";
import { lowercase, stripPunctuation } from "../preprocessors.ts";
import { cosineSimilarity } from "./cosine.ts";
// Importing the module installs the `matchesSemantically` handler on the default registry.
import {
  configureSimilarity,
  matchesSemantically,
  resetSimilarityDefaults,
  toSimilarityConfig,
} from "./index.ts";

/** Derives the fake's cosine score for two texts, so boundary tests never guess. */
async function fakeScore(actual: string, expected: string): Promise<number> {
  const adapter = new FakeEmbeddingModelAdapter();
  const [a, b] = await Promise.all([adapter.embed(actual), adapter.embed(expected)]);
  return cosineSimilarity(a, b);
}

beforeEach(() => {
  resetSimilarityDefaults();
});

test("known-similar texts pass at the default threshold", async () => {
  await assert.doesNotReject(matchesSemantically("the quick brown fox", "the quick brown fox"));
});

test("known-dissimilar texts fail at the default threshold", async () => {
  await assert.rejects(matchesSemantically("apple", "zebra"), /matchesSemantically failed/);
});

test("threshold boundary: a value just below the score passes, just above fails", async () => {
  // Partial overlap -> deterministic 0.5 against the fake.
  const score = await fakeScore("alpha beta", "alpha gamma");
  assert.ok(Math.abs(score - 0.5) < 1e-9, `expected ~0.5, got ${score}`);

  await assert.doesNotReject(
    matchesSemantically("alpha beta", "alpha gamma", { threshold: score - 0.01 }),
  );
  await assert.rejects(
    matchesSemantically("alpha beta", "alpha gamma", { threshold: score + 0.01 }),
    /matchesSemantically failed/,
  );
});

test("threshold boundary: score == threshold passes (>=)", async () => {
  const score = await fakeScore("alpha beta", "alpha gamma");
  await assert.doesNotReject(
    matchesSemantically("alpha beta", "alpha gamma", { threshold: score }),
  );
});

test("preprocessors change the outcome: a normalizing preprocessor flips a fail into a pass", async () => {
  const normalizeSpelling: TextPreprocessor = (input) => input.replace(/colour/g, "color");

  // Without the preprocessor the tokens differ -> cosine 0 -> fails at a high threshold.
  await assert.rejects(
    matchesSemantically("the colour is bright", "the color is bright", { threshold: 0.99 }),
    /matchesSemantically failed/,
  );
  // With it, both texts normalize to identical tokens -> cosine 1 -> passes.
  await assert.doesNotReject(
    matchesSemantically("the colour is bright", "the color is bright", {
      threshold: 0.99,
      preprocessors: [normalizeSpelling],
    }),
  );
});

test("preprocessors: case + punctuation preprocessors keep a match matching", async () => {
  await assert.doesNotReject(
    matchesSemantically("Hello, WORLD!", "hello world", {
      threshold: 0.99,
      preprocessors: [lowercase, stripPunctuation],
    }),
  );
});

test("failure message reports the computed score and the threshold", async () => {
  await assert.rejects(matchesSemantically("apple", "zebra", { threshold: 0.8 }), (error) => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /cosine similarity 0\.0000/);
    assert.match(error.message, /threshold 0\.8/);
    assert.match(error.message, /apple/);
    assert.match(error.message, /zebra/);
    return true;
  });
});

test("configureSimilarity sets a global default threshold that per-call options still override", async () => {
  // 0.5 score; a strict global default makes it fail...
  configureSimilarity({ threshold: 0.9 });
  await assert.rejects(matchesSemantically("alpha beta", "alpha gamma"));
  // ...but a lenient per-call override wins.
  await assert.doesNotReject(
    matchesSemantically("alpha beta", "alpha gamma", { threshold: 0.4 }),
  );
});

test("configureSimilarity can set a custom default embedding adapter", async () => {
  const calls: string[] = [];
  const spyAdapter = new FakeEmbeddingModelAdapter();
  const wrapped = {
    modelId: spyAdapter.modelId,
    dimension: spyAdapter.dimension,
    embed: async (text: string) => {
      calls.push(text);
      return spyAdapter.embed(text);
    },
  };
  configureSimilarity({ adapter: wrapped });
  await matchesSemantically("same tokens here", "same tokens here");
  assert.deepEqual(calls, ["same tokens here", "same tokens here"]);
});

test("reachable through the fluent assertThatText entry", async () => {
  await assert.doesNotReject(assertThatText("shared words here").matchesSemantically("shared words here"));
  await assert.rejects(
    assertThatText("apple").matchesSemantically("zebra"),
    /matchesSemantically failed/,
  );
});

test("threshold outside [0, 1] or non-finite is rejected as a TypeError", async () => {
  for (const bad of [-0.1, 1.1, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
    await assert.rejects(
      matchesSemantically("alpha beta", "alpha gamma", { threshold: bad }),
      /threshold must be a finite number in \[0, 1\]/,
      `expected threshold ${bad} to be rejected`,
    );
  }
});

test("configureSimilarity rejects an out-of-range global threshold", () => {
  assert.throws(
    () => configureSimilarity({ threshold: 2 }),
    /threshold must be a finite number in \[0, 1\]/,
  );
});

test("boundary thresholds 0 and 1 are accepted by validation", () => {
  assert.doesNotThrow(() => configureSimilarity({ threshold: 0 }));
  assert.doesNotThrow(() => configureSimilarity({ threshold: 1 }));
  resetSimilarityDefaults();
});

test("toSimilarityConfig rejects an array (arrays are not plain-object options)", () => {
  assert.throws(() => toSimilarityConfig([]), /options must be an object/);
  assert.throws(
    () => toSimilarityConfig([lowercase]),
    /options must be an object/,
  );
});

test("toSimilarityConfig rejects non-object primitives", () => {
  assert.throws(() => toSimilarityConfig("nope"), /options must be an object/);
  assert.throws(() => toSimilarityConfig(42), /options must be an object/);
});

test("toSimilarityConfig recovers a valid config and validates its threshold at use", () => {
  assert.deepEqual(toSimilarityConfig(undefined), undefined);
  const recovered = toSimilarityConfig({ threshold: 0.5 });
  assert.deepEqual(recovered, { threshold: 0.5 });
});

test("configureSimilarity defensively copies preprocessors so later caller mutation can't rewrite defaults", async () => {
  const identity: TextPreprocessor = (input) => input;
  const flipToColor: TextPreprocessor = (input) => input.replace(/colour/g, "color");
  const mutable = [identity];
  configureSimilarity({ threshold: 0.99, preprocessors: mutable });
  // Mutating the caller's array after configuring must NOT change the stored default.
  mutable.push(flipToColor);
  await assert.rejects(
    matchesSemantically("the colour is bright", "the color is bright"),
    /matchesSemantically failed/,
    "post-configure mutation leaked into the stored default preprocessors",
  );
});

test("toSimilarityConfig rejects an adapter whose dimension is non-integer or non-positive", () => {
  for (const dimension of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(
      () => toSimilarityConfig({ adapter: { modelId: "m", dimension, embed: async () => [] } }),
      /adapter must be an EmbeddingModelAdapter/,
      `expected dimension ${dimension} to be rejected`,
    );
  }
});

test("matchesSemantically rejects an adapter whose embedding length disagrees with its dimension", async () => {
  const liar = {
    modelId: "liar",
    dimension: 8,
    embed: async () => [1, 2, 3],
  };
  await assert.rejects(
    matchesSemantically("a", "b", { adapter: liar, threshold: 0.5 }),
    /has length 3, expected adapter\.dimension 8/,
  );
});
