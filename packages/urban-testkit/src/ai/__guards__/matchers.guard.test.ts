// S5 red/green per-matcher guard (issue #297): against the deterministic fake backends,
// a known-good input passes and a known-bad input FAILS, for BOTH matchers — and the
// judge failure surfaces the rationale. Fully deterministic, network-free.

import assert from "node:assert/strict";
import { test } from "node:test";
import { assertThatText } from "../index.ts";
import { lowercase, stripPunctuation } from "../index.ts";

test("red/green: matchesSemantically PASSES for known-similar text at a threshold", async () => {
  // Bag-of-tokens fake: these share every significant token → high cosine similarity.
  await assertThatText("the quick brown fox").matchesSemantically("the quick brown fox jumped", {
    threshold: 0.8,
  });
});

test("red/green: matchesSemantically FAILS for known-dissimilar text at a threshold", async () => {
  await assert.rejects(
    assertThatText("hello world").matchesSemantically("completely different phrase", {
      threshold: 0.8,
    }),
    /matchesSemantically failed/,
  );
});

test("red/green: preprocessors are honoured (composed transforms still yield a passing match)", async () => {
  // The fake tokenizer already normalises case/punctuation, so this asserts the composed
  // preprocessors are ACCEPTED and applied on the matcher path without altering a valid
  // match — the outcome-changing behaviour of preprocessors is covered by S2's own suite.
  await assertThatText("Hello, WORLD!").matchesSemantically("hello world", {
    threshold: 0.99,
    preprocessors: [lowercase, stripPunctuation],
  });
});

test("red/green: satisfiesJudge PASSES when the criteria are met", async () => {
  await assertThatText("a warm friendly greeting to you").satisfiesJudge("friendly greeting");
});

test("red/green: satisfiesJudge FAILS when the criteria are NOT met, surfacing the rationale", async () => {
  // The fake judge fails and names the missing criteria terms; the matcher must surface that
  // rationale (and the criteria) in the thrown assertion message.
  await assert.rejects(
    assertThatText("a warm friendly greeting").satisfiesJudge("formal apology"),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /satisfiesJudge failed/);
      assert.match(error.message, /judge rationale/);
      // The fake's rationale enumerates the missing significant terms of the criteria.
      assert.match(error.message, /apology/);
      return true;
    },
  );
});

test("red/green: satisfiesJudge multimodal input rides the same chat seam (no separate seam)", async () => {
  // An optional image part is opt-in per-call input on the SAME chat seam; the fake accepts
  // it without throwing and still evaluates the CRITERIA/ACTUAL text deterministically.
  await assertThatText("a warm friendly greeting to you").satisfiesJudge("friendly greeting", {
    image: { kind: "image", mediaType: "image/png", data: "AAAA" },
  });
});
