// Runtime smoke test for the re-exported `/ai` surface.
//
// `src/ai/index.ts` is now a pure `export * from "@nanobpm/ai-assert"` (issue
// Magikcraft/nano-bpm#894, S3b) — the AI-assertion DSL itself lives in, and is
// fully tested by, `@nanobpm/ai-assert`. This test does NOT re-test that DSL; it
// guards the *re-export* against packaging/wiring regressions the barrel swap
// could introduce: the dependency failing to resolve, the side-effecting matcher
// registration not running on import, or the surface drifting so a matcher call
// no longer dispatches at runtime.
//
// It imports the barrel by its relative path (the same file the `./ai` /
// `./source/ai` export maps point at) and exercises the deterministic fakes
// (zero network), so it stays reproducible in CI.
import assert from "node:assert/strict";
import { test } from "node:test";
import { assertThatText, seamInventory } from "./index.ts";

test("re-export: seamInventory enumerates the two ai-assert seams (side-effect wiring landed)", () => {
  assert.deepEqual(
    seamInventory().map((entry) => entry.seam),
    ["ChatModelAdapter", "EmbeddingModelAdapter"],
  );
});

test("re-export: assertThatText.matchesSemantically dispatches to the registered matcher", async () => {
  // Identical text scores 1.0 against the deterministic fake embedding, so it
  // passes any default threshold — proving the similarity matcher is installed
  // on the default registry via the re-export's import side effect.
  await assert.doesNotReject(
    assertThatText("a warm greeting").matchesSemantically("a warm greeting"),
  );
  // Dissimilar text fails through the same matcher (not a "not installed" error),
  // proving the call reaches the real handler rather than a missing stub.
  await assert.rejects(
    assertThatText("apple").matchesSemantically("zebra"),
    /matchesSemantically failed/,
  );
});

test("re-export: assertThatText.satisfiesJudge dispatches to the registered judge", async () => {
  await assert.doesNotReject(
    assertThatText("the cat sat on the mat").satisfiesJudge("cat"),
  );
  await assert.rejects(
    assertThatText("the cat sat on the mat").satisfiesJudge("elephant"),
    /elephant/,
  );
});
