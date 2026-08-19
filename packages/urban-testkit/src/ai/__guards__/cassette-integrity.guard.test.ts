// S5 record/replay integrity guard (issue #297): a committed cassette replays byte-stably,
// while a MISSING file or an EDITED (tampered) entry fails LOUDLY (throws) rather than
// silently passing. Committed fixtures under `./__cassettes__/` demonstrate the caught case.

import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  Cassette,
  RecordReplayChatModelAdapter,
  RecordReplayEmbeddingAdapter,
} from "../index.ts";
import { FakeEmbeddingModelAdapter } from "../index.ts";

const CASSETTES = join(fileURLToPath(new URL(".", import.meta.url)), "__cassettes__");
const VALID_FIXTURE = join(CASSETTES, "judge-verdict.json");
const TAMPERED_FIXTURE = join(CASSETTES, "judge-verdict.tampered.json");
const RECORDED_TEXT = '{"pass":true,"rationale":"the greeting is warm and friendly"}';
const CHAT_REQUEST = { prompt: "Is this greeting friendly?" };

test("record/replay integrity: a committed cassette replays byte-stably", async () => {
  const cassette = await Cassette.load(VALID_FIXTURE);
  const chat = new RecordReplayChatModelAdapter({ mode: "replay", cassette });

  const first = await chat.chat(CHAT_REQUEST);
  const second = await chat.chat(CHAT_REQUEST);
  assert.equal(first.text, RECORDED_TEXT, "replay returns the exact recorded text");
  assert.equal(second.text, first.text, "replay is byte-stable across calls");
});

test("record/replay integrity: a MISSING cassette file fails loudly", async () => {
  await assert.rejects(
    Cassette.load(join(tmpdir(), "urban-testkit-s5-missing-cassette.json")),
    /not found/,
  );
});

test("record/replay integrity: a MISSING entry in replay mode throws (never a silent pass)", async () => {
  const cassette = await Cassette.load(VALID_FIXTURE);
  const chat = new RecordReplayChatModelAdapter({ mode: "replay", cassette });
  await assert.rejects(chat.chat({ prompt: "a request that was never recorded" }), /cassette miss/);
});

test("record/replay integrity: an EDITED (tampered) committed cassette throws rather than replaying garbage", async () => {
  const cassette = await Cassette.load(TAMPERED_FIXTURE);
  const chat = new RecordReplayChatModelAdapter({ mode: "replay", cassette });
  await assert.rejects(chat.chat(CHAT_REQUEST), /corrupt/);
});

test("record/replay integrity: record → save → reload → replay round-trips byte-stably", async () => {
  const dir = await mkdtemp(join(tmpdir(), "urban-testkit-s5-cassette-"));
  const path = join(dir, "cassette.json");

  const recording = new Cassette(path);
  const recorder = new RecordReplayEmbeddingAdapter({ mode: "record", cassette: recording });
  const recorded = await recorder.embed("hello world");
  await recording.save();

  const reloaded = await Cassette.load(path);
  const replayer = new RecordReplayEmbeddingAdapter({ mode: "replay", cassette: reloaded });
  assert.deepEqual(await replayer.embed("hello world"), recorded);
  // And equals the deterministic fake it captured from — proving the round-trip is faithful.
  assert.deepEqual(recorded, await new FakeEmbeddingModelAdapter().embed("hello world"));
});
