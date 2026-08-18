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
import {
  HostedChatModelAdapter,
  HostedEmbeddingAdapter,
  type HostedProviderConfig,
} from "./hosted.ts";
import { LocalEmbeddingAdapter } from "./local.ts";
import { readEnvVar } from "./env.ts";

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
  const stubInstalled = Reflect.set(globalThis, "fetch", () => {
    networkTouched = true;
    throw new Error("network access is blocked in this test");
  });
  assert.equal(stubInstalled, true, "fetch stub must install so stray network access stays detectable");
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
    // Restore the exact prior shape: if fetch was originally absent, delete the stub
    // rather than leaving a `fetch` property defined as undefined.
    if (original === undefined) {
      Reflect.deleteProperty(globalThis, "fetch");
    } else {
      Reflect.set(globalThis, "fetch", original);
    }
  }
});

// --- Robustness guards for the injected real adapters (no opt-in / network needed: the
// adapter classes take an injected client/pipeline, so they are unit-testable directly). ---

/** Builds a structural fake of the hosted client that returns a fixed embedding + chat content. */
function fakeHostedClient(embedding: number[], chatContent: string | null) {
  return {
    embeddings: {
      create: async (_body: { model: string; input: string }) => ({ data: [{ embedding }] }),
    },
    chat: {
      completions: {
        create: async (_body: { model: string; messages: unknown[] }) => ({
          choices: [{ message: { content: chatContent } }],
        }),
      },
    },
  };
}

test("HostedEmbeddingAdapter.embed rejects a vector whose length != advertised dimension", async () => {
  const config: HostedProviderConfig = { embeddingDimension: 3 };
  const adapter = new HostedEmbeddingAdapter(fakeHostedClient([0.1, 0.2], null), config);
  await assert.rejects(adapter.embed("hi"), /does not match advertised dimension 3/);
});

test("HostedEmbeddingAdapter.embed returns a vector whose length matches the dimension", async () => {
  const config: HostedProviderConfig = { embeddingDimension: 3 };
  const adapter = new HostedEmbeddingAdapter(fakeHostedClient([0.1, 0.2, 0.3], null), config);
  assert.deepEqual(await adapter.embed("hi"), [0.1, 0.2, 0.3]);
});

test("HostedChatModelAdapter.chat fails loudly when the provider returns no content", async () => {
  const adapter = new HostedChatModelAdapter(fakeHostedClient([], null));
  await assert.rejects(adapter.chat({ prompt: "judge this" }), /no message content/);
});

test("HostedChatModelAdapter.chat returns the provider's text when present", async () => {
  const adapter = new HostedChatModelAdapter(fakeHostedClient([], "PASS"));
  assert.deepEqual(await adapter.chat({ prompt: "judge this" }), { text: "PASS" });
});

test("LocalEmbeddingAdapter.embed rejects a pipeline vector whose length != advertised dimension", async () => {
  const pipeline = async (_input: unknown, _options?: Record<string, unknown>) => ({
    data: new Float32Array([0.1, 0.2]),
  });
  const adapter = new LocalEmbeddingAdapter(pipeline, { embeddingDimension: 3 });
  await assert.rejects(adapter.embed("hi"), /does not match advertised dimension 3/);
});

test("readEnvVar treats a Deno --allow-env denial as unset (safe by default, never throws)", () => {
  const key = "URBAN_TESTKIT_AI_REAL_ENV_PERMISSION_PROBE";
  const original = Reflect.get(globalThis, "Deno");
  Reflect.set(globalThis, "Deno", {
    env: {
      get() {
        throw new Error("Requires env access to \"" + key + "\", run again with the --allow-env flag");
      },
    },
  });
  try {
    assert.doesNotThrow(() => readEnvVar(key));
    assert.equal(readEnvVar(key), undefined);
  } finally {
    if (original === undefined) {
      Reflect.deleteProperty(globalThis, "Deno");
    } else {
      Reflect.set(globalThis, "Deno", original);
    }
  }
});

test("createRealAdapters throws on an unknown provider before any import/network (opt-in set)", async () => {
  // A JS caller (or a TS caller with `any`) can pass a typo like "loacl"; the factory must
  // reject it explicitly rather than silently routing to the hosted backend. Build the
  // runtime-invalid options via JSON.parse so no `as` cast is needed.
  const badOptions = JSON.parse('{ "provider": "loacl" }');
  const proc = Reflect.get(globalThis, "process");
  const env = typeof proc === "object" && proc !== null ? Reflect.get(proc, "env") : undefined;
  const hadEnv = typeof env === "object" && env !== null;
  const previous = hadEnv ? Reflect.get(env, REAL_AI_OPT_IN_ENV) : undefined;
  if (hadEnv) {
    Reflect.set(env, REAL_AI_OPT_IN_ENV, "1");
  }
  try {
    await assert.rejects(createRealAdapters(badOptions), /unknown provider/);
  } finally {
    if (hadEnv) {
      if (previous === undefined) {
        Reflect.deleteProperty(env, REAL_AI_OPT_IN_ENV);
      } else {
        Reflect.set(env, REAL_AI_OPT_IN_ENV, previous);
      }
    }
  }
});
