import assert from "node:assert/strict";
import { test } from "node:test";
import { assertThatText, createTextMatcherRegistry } from "./assertion.ts";
// Import the barrel so the S2/S3 placeholder modules register on the default registry.
import "./index.ts";

test("registry: calling a matcher before registration throws a clear 'not installed' error", async () => {
  const registry = createTextMatcherRegistry();
  await assert.rejects(
    registry.assertThatText("x").matchesSemantically("y"),
    /matchesSemantically" is not installed/,
  );
});

test("registry: after registering a handler, the fluent method dispatches to it", async () => {
  const registry = createTextMatcherRegistry();
  const seen: { actual: string; args: readonly unknown[] }[] = [];
  registry.register("matchesSemantically", async (actual, args) => {
    seen.push({ actual, args });
  });

  assert.equal(registry.has("matchesSemantically"), true);
  await registry.assertThatText("hello").matchesSemantically("world", { threshold: 0.9 });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].actual, "hello");
  assert.deepEqual(seen[0].args, ["world", { threshold: 0.9 }]);
});

test("registry: satisfiesJudge forwards [criteria, options] to its handler", async () => {
  const registry = createTextMatcherRegistry();
  const captured: (readonly unknown[])[] = [];
  registry.register("satisfiesJudge", async (_actual, args) => {
    captured.push(args);
  });
  await registry.assertThatText("output").satisfiesJudge("must be polite");
  assert.deepEqual(captured, [["must be polite", undefined]]);
});

test("default registry: the S1 similarity placeholder is installed and throws until S2 lands", async () => {
  await assert.rejects(
    assertThatText("a").matchesSemantically("b"),
    /not yet implemented \(slice S2\)/,
  );
});

test("default registry: the S3 judge matcher is installed and dispatches", async () => {
  // S3 has landed — satisfiesJudge now judges against the deterministic fake: a met
  // criterion passes and an unmet one fails with the judge's rationale (not the old
  // placeholder "not yet implemented" error).
  await assertThatText("the cat sat on the mat").satisfiesJudge("cat");
  await assert.rejects(
    assertThatText("the cat sat on the mat").satisfiesJudge("elephant"),
    /elephant/,
  );
});
