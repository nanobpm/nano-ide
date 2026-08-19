import assert from "node:assert/strict";
import { test } from "node:test";
import { FakeChatModelAdapter, FakeEmbeddingModelAdapter } from "./fakes.ts";
import type { ImagePart } from "./seams.ts";
import { cosineSimilarity } from "./similarity/cosine.ts";
import { parseVerdict } from "./verdict.ts";

test("fake embedding: same input yields the same vector (deterministic)", async () => {
  const fake = new FakeEmbeddingModelAdapter();
  const first = await fake.embed("hello world");
  const second = await fake.embed("hello world");
  assert.deepEqual(first, second);
  assert.equal(first.length, fake.dimension);
});

test("fake embedding: cosine is 1 for identical, order-independent, and low for disjoint text", async () => {
  const fake = new FakeEmbeddingModelAdapter();
  const hello = await fake.embed("hello world");
  const helloReordered = await fake.embed("world hello");
  const disjoint = await fake.embed("quantum turbine");
  assert.ok(Math.abs(cosineSimilarity(hello, helloReordered) - 1) < 1e-9, "identical bag → cosine 1");
  assert.ok(cosineSimilarity(hello, disjoint) < 0.5, "disjoint tokens → low cosine");
});

test("fake embedding: rejects a non-positive dimension", () => {
  assert.throws(() => new FakeEmbeddingModelAdapter(0), /positive integer/);
});

test("fake chat: PASS verdict when every criteria term is present in the actual", async () => {
  const fake = new FakeChatModelAdapter();
  const result = await fake.chat({
    prompt: "CRITERIA: friendly greeting\nACTUAL: a warm friendly greeting for you",
  });
  const verdict = parseVerdict(result.text);
  assert.equal(verdict.pass, true);
});

test("fake chat: FAIL verdict names the missing criteria terms", async () => {
  const fake = new FakeChatModelAdapter();
  const result = await fake.chat({
    prompt: "CRITERIA: apology refund\nACTUAL: hello there",
  });
  const verdict = parseVerdict(result.text);
  assert.equal(verdict.pass, false);
  assert.match(verdict.rationale, /apology/);
  assert.match(verdict.rationale, /refund/);
});

test("fake chat: transparently accepts an optional image part (multimodal) without throwing", async () => {
  const fake = new FakeChatModelAdapter();
  const image: ImagePart = { kind: "image", mediaType: "image/png", data: "AAAA" };
  const result = await fake.chat({
    prompt: "CRITERIA: chart\nACTUAL: a bar chart of revenue",
    image,
  });
  const verdict = parseVerdict(result.text);
  assert.equal(verdict.pass, true);
});

test("fake chat: verdict output round-trips through the canonical parser", async () => {
  const fake = new FakeChatModelAdapter();
  const result = await fake.chat({ prompt: "no sections here" });
  const verdict = parseVerdict(result.text);
  assert.equal(verdict.pass, true);
  assert.equal(typeof verdict.rationale, "string");
});
