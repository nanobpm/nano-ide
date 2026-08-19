import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { FakeEmbeddingModelAdapter } from "./fakes.ts";
import {
  Cassette,
  RecordReplayChatModelAdapter,
  RecordReplayEmbeddingAdapter,
} from "./record-replay.ts";
import type { ChatInput, ChatModelAdapter, ChatResult, EmbeddingModelAdapter } from "./seams.ts";

const FIXTURE = join(fileURLToPath(new URL(".", import.meta.url)), "__cassettes__", "sample.json");

async function tempCassettePath(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "urban-testkit-cassette-"));
  return join(dir, "cassette.json");
}

test("record/replay: replays a committed cassette byte-stably", async () => {
  const cassette = await Cassette.load(FIXTURE);
  const embed = new RecordReplayEmbeddingAdapter({ mode: "replay", cassette });
  const chat = new RecordReplayChatModelAdapter({ mode: "replay", cassette });

  const vector = await embed.embed("hello world");
  const expected = await new FakeEmbeddingModelAdapter().embed("hello world");
  assert.deepEqual(vector, expected);

  const result = await chat.chat({
    prompt: "CRITERIA: friendly greeting\nACTUAL: a warm friendly greeting to you",
  });
  assert.equal(result.text, '{"pass":true,"rationale":"all criteria terms present in actual"}');
});

test("record/replay: a MISSING cassette file fails loudly", async () => {
  await assert.rejects(Cassette.load(join(tmpdir(), "does-not-exist-cassette.json")), /not found/);
});

test("record/replay: a MISSING entry in replay mode throws (never a silent pass)", async () => {
  const cassette = await Cassette.load(FIXTURE);
  const embed = new RecordReplayEmbeddingAdapter({ mode: "replay", cassette });
  await assert.rejects(embed.embed("a request that was never recorded"), /cassette miss/);
});

test("record/replay: an EDITED (corrupted) entry throws rather than replaying garbage", async () => {
  const path = await tempCassettePath();
  const source = JSON.parse(await readFile(FIXTURE, "utf8"));
  source.entries['embed\n"hello world"'] = "not-a-vector";
  await writeFile(path, JSON.stringify(source), "utf8");

  const cassette = await Cassette.load(path);
  const embed = new RecordReplayEmbeddingAdapter({ mode: "replay", cassette });
  await assert.rejects(embed.embed("hello world"), /corrupt/);
});

test("record/replay: record mode captures from the default fake and round-trips through disk", async () => {
  const path = await tempCassettePath();
  const recording = new Cassette(path);
  const recorder = new RecordReplayEmbeddingAdapter({ mode: "record", cassette: recording });
  const recorded = await recorder.embed("hello world");
  await recording.save();

  const reloaded = await Cassette.load(path);
  const replayer = new RecordReplayEmbeddingAdapter({ mode: "replay", cassette: reloaded });
  assert.deepEqual(await replayer.embed("hello world"), recorded);
});

test("record/replay: an INJECTED capture source is used in record mode", async () => {
  const calls: string[] = [];
  const stub: EmbeddingModelAdapter = {
    modelId: "stub-capture",
    dimension: 3,
    async embed(text) {
      calls.push(text);
      return [1, 2, 3];
    },
  };
  const cassette = new Cassette(null);
  const recorder = new RecordReplayEmbeddingAdapter({ mode: "record", cassette, dimension: 3 });
  recorder.setCaptureSource(stub);

  const recorded = await recorder.embed("capture me");
  assert.deepEqual(recorded, [1, 2, 3]);
  assert.deepEqual(calls, ["capture me"]);
});

test("record/replay: a constructor with a captureSource whose dimension disagrees with an explicit dimension throws", () => {
  const stubDim3: EmbeddingModelAdapter = {
    modelId: "stub-capture",
    dimension: 3,
    async embed() {
      return [1, 2, 3];
    },
  };
  const cassette = new Cassette(null);
  assert.throws(
    () => new RecordReplayEmbeddingAdapter({ mode: "record", cassette, captureSource: stubDim3, dimension: 64 }),
    /dimension \(3\) must match this adapter's dimension \(64\)/,
  );
});

test("record/replay: an EDITED (wrong-length) entry throws rather than replaying a dimension-violating vector", async () => {
  const path = await tempCassettePath();
  const source = JSON.parse(await readFile(FIXTURE, "utf8"));
  source.entries['embed\n"hello world"'] = [1, 2, 3];
  await writeFile(path, JSON.stringify(source), "utf8");

  const cassette = await Cassette.load(path);
  const embed = new RecordReplayEmbeddingAdapter({ mode: "replay", cassette });
  await assert.rejects(embed.embed("hello world"), /replayed cassette vector length \(3\)/);
});

test("record/replay: a capture source that returns a wrong-length vector throws in record mode", async () => {
  const stub: EmbeddingModelAdapter = {
    modelId: "misbehaving-capture",
    dimension: 3,
    async embed() {
      return [1, 2];
    },
  };
  const cassette = new Cassette(null);
  const recorder = new RecordReplayEmbeddingAdapter({ mode: "record", cassette, dimension: 3 });
  recorder.setCaptureSource(stub);
  await assert.rejects(recorder.embed("capture me"), /capture source vector length \(2\)/);
});

test("record/replay: an injected chat capture source is used in record mode", async () => {
  const inputs: ChatInput[] = [];
  const stub: ChatModelAdapter = {
    modelId: "stub-chat",
    async chat(input): Promise<ChatResult> {
      inputs.push(input);
      return { text: "captured" };
    },
  };
  const cassette = new Cassette(null);
  const recorder = new RecordReplayChatModelAdapter({ mode: "record", cassette, captureSource: stub });
  const result = await recorder.chat({ prompt: "hi" });
  assert.equal(result.text, "captured");
  assert.equal(inputs.length, 1);
});
