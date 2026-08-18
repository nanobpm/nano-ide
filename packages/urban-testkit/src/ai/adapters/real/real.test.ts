// S4 guards (issue #297): the real, opt-in adapters must be import-safe, statically present
// in the seam inventory on the default path, and impossible to LIVE-activate without the
// explicit opt-in — all with ZERO network and the optional deps absent.
//
// These tests import the `/ai` barrel (which eagerly imports the real-adapter module) and
// run on both the Node and Deno lanes with no opt-in env set.

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  REAL_AI_OPT_IN_ENV,
  assertRealAiEnabled,
  createHostedProviderAdapters,
  createLocalModelAdapters,
  createRealAdapters,
  createRealChatModelAdapter,
  createRealEmbeddingAdapter,
  createRecordingChatModelAdapter,
  createRecordingEmbeddingAdapter,
  isRealAiEnabled,
  seamInventory,
} from "../../index.ts";
import { Cassette } from "../../record-replay.ts";

// Precondition: the whole S4 default-path contract assumes the LIVE opt-in is OFF. If this
// fails, the environment leaked `URBAN_TESTKIT_AI_REAL` — a real violation, not a flake.
test(`S4 precondition: ${REAL_AI_OPT_IN_ENV} is not opted in on the default path`, () => {
  assert.equal(isRealAiEnabled(), false);
});

test("import-safety: the barrel exposes the real-adapter surface without loading optional deps", () => {
  // Reaching this line means importing the barrel (hence ./adapters/real) did not resolve
  // `openai`/`@xenova/transformers` or touch the network — they load lazily, opt-in only.
  for (const factory of [
    createRealAdapters,
    createRealEmbeddingAdapter,
    createRealChatModelAdapter,
    createHostedProviderAdapters,
    createLocalModelAdapters,
    createRecordingEmbeddingAdapter,
    createRecordingChatModelAdapter,
  ]) {
    assert.equal(typeof factory, "function");
  }
});

test("completeness: seamInventory reports hasReal:true + docRef for BOTH seams, no opt-in", () => {
  assert.equal(isRealAiEnabled(), false);
  const inventory = seamInventory();
  assert.deepEqual(
    inventory.map((entry) => entry.seam),
    ["ChatModelAdapter", "EmbeddingModelAdapter"],
  );
  for (const entry of inventory) {
    assert.equal(entry.hasFake, true, `${entry.seam} has a fake`);
    assert.equal(entry.hasRecordReplay, true, `${entry.seam} has record/replay`);
    assert.equal(entry.hasReal, true, `${entry.seam} has a real backend (static descriptor)`);
    assert.ok(
      entry.docRef !== null && entry.docRef.trim().length > 0,
      `${entry.seam} carries a non-empty docRef`,
    );
  }
});

test("opt-in gate: assertRealAiEnabled throws without the env var", () => {
  assert.throws(() => assertRealAiEnabled(), /requires explicit opt-in/);
});

test("live activation is impossible without opt-in: every construction factory rejects, no network", async () => {
  // Block the network so a stray real activation would fail loudly rather than pass.
  const original = Reflect.get(globalThis, "fetch");
  let networkTouched = false;
  Reflect.set(globalThis, "fetch", () => {
    networkTouched = true;
    throw new Error("network access is blocked in this test");
  });
  try {
    const cassette = new Cassette(null);
    const attempts = [
      createRealAdapters(),
      createRealAdapters({ provider: "local" }),
      createRealEmbeddingAdapter(),
      createRealChatModelAdapter(),
      createHostedProviderAdapters(),
      createLocalModelAdapters(),
      createRecordingEmbeddingAdapter({ cassette }),
      createRecordingChatModelAdapter({ cassette }),
    ];
    for (const attempt of attempts) {
      // The opt-in error proves the factory threw BEFORE any dynamic import()/network I/O:
      // a missing optional dep would surface as a module-resolution error instead.
      await assert.rejects(attempt, /requires explicit opt-in/);
    }
    assert.equal(networkTouched, false, "no factory may touch the network without opt-in");
  } finally {
    Reflect.set(globalThis, "fetch", original);
  }
});
