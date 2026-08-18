import assert from "node:assert/strict";
import { test } from "node:test";

import { assertThatText } from "../assertion.ts";
import { FakeChatModelAdapter } from "../fakes.ts";
import type { ChatInput, ChatModelAdapter, ChatResult, ImagePart } from "../seams.ts";
import { serializeVerdict } from "../verdict.ts";
// Import the barrel so the S3 matcher registers on the default registry.
import "../index.ts";
import { configureJudge, defaultJudgePrompt, satisfiesJudge } from "./index.ts";

/** Records the last chat input and returns a canned verdict — deterministic, no network. */
class SpyChatAdapter implements ChatModelAdapter {
  readonly modelId = "spy-chat";
  last: ChatInput | null = null;
  private readonly verdict: { pass: boolean; rationale: string };
  constructor(verdict: { pass: boolean; rationale: string }) {
    this.verdict = verdict;
  }
  async chat(input: ChatInput): Promise<ChatResult> {
    this.last = input;
    return { text: serializeVerdict(this.verdict) };
  }
}

test("satisfiesJudge: a criterion that is met passes against the deterministic fake", async () => {
  await satisfiesJudge("the cat sat on the mat", "cat");
});

test("satisfiesJudge: an unmet criterion fails and surfaces the judge's rationale", async () => {
  await assert.rejects(
    satisfiesJudge("the cat sat on the mat", "elephant"),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      // rationale from the fake names the missing term …
      assert.match(error.message, /elephant/);
      // … and the criteria is included in the message.
      assert.match(error.message, /criteria/);
      return true;
    },
  );
});

test("satisfiesJudge: verdict parsing is deterministic (same input → same outcome)", async () => {
  await satisfiesJudge("hello world", "hello");
  await satisfiesJudge("hello world", "hello");
  await assert.rejects(satisfiesJudge("hello world", "missing"));
  await assert.rejects(satisfiesJudge("hello world", "missing"));
});

test("satisfiesJudge: reachable through the fluent assertThatText().satisfiesJudge entry", async () => {
  await assertThatText("polite and helpful response").satisfiesJudge("polite");
  await assert.rejects(
    assertThatText("polite and helpful response").satisfiesJudge("rude"),
    /rude/,
  );
});

test("satisfiesJudge: multimodal image part rides the same chat seam", async () => {
  const spy = new SpyChatAdapter({ pass: true, rationale: "image satisfies criteria" });
  const image: ImagePart = { kind: "image", mediaType: "image/png", data: "aGVsbG8=" };
  await satisfiesJudge("a photo of a cat", "contains a cat", { adapter: spy, image });
  assert.ok(spy.last !== null);
  assert.deepEqual(spy.last?.image, image);
  assert.match(spy.last?.prompt ?? "", /CRITERIA:/);
});

test("satisfiesJudge: the fake accepts multimodal input without throwing", async () => {
  const image: ImagePart = { kind: "image", mediaType: "image/jpeg", data: "Zm9v" };
  await satisfiesJudge("mentions a dog", "dog", { adapter: new FakeChatModelAdapter(), image });
});

test("satisfiesJudge: a custom adapter's fail verdict throws with its rationale", async () => {
  const spy = new SpyChatAdapter({ pass: false, rationale: "tone is not formal enough" });
  await assert.rejects(
    satisfiesJudge("hey there", "formal tone", { adapter: spy }),
    /tone is not formal enough/,
  );
});

test("satisfiesJudge: a per-call promptTemplate overrides the default", async () => {
  const spy = new SpyChatAdapter({ pass: true, rationale: "ok" });
  await satisfiesJudge("x", "y", {
    adapter: spy,
    promptTemplate: (criteria, actual) => `JUDGE ${criteria} :: ${actual}`,
  });
  assert.equal(spy.last?.prompt, "JUDGE y :: x");
});

test("configureJudge: sets a global default adapter that per-call options override", async () => {
  const globalSpy = new SpyChatAdapter({ pass: true, rationale: "global" });
  const callSpy = new SpyChatAdapter({ pass: true, rationale: "per-call" });
  try {
    configureJudge({ adapter: globalSpy });
    await satisfiesJudge("some text", "some");
    assert.ok(globalSpy.last !== null, "global default adapter should be used");

    globalSpy.last = null;
    await satisfiesJudge("other text", "other", { adapter: callSpy });
    assert.ok(callSpy.last !== null, "per-call adapter should be used");
    assert.equal(globalSpy.last, null, "per-call option should override the global default");
  } finally {
    configureJudge({});
  }
});

test("defaultJudgePrompt: emits CRITERIA and ACTUAL sections", () => {
  const prompt = defaultJudgePrompt("be concise", "a very long rambling answer");
  assert.match(prompt, /CRITERIA:\nbe concise/);
  assert.match(prompt, /ACTUAL:\na very long rambling answer/);
});
