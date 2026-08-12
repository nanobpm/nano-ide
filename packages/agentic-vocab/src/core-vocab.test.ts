import assert from "node:assert/strict";
import { test } from "node:test";
import { validateVocabDocument } from "@nanobpm/agentic-protocol";
import { CORE_VOCAB, CORE_VOCAB_VERSION } from "./core-vocab.ts";

test("the core vocabulary is a valid S0 vocab artifact", () => {
  const result = validateVocabDocument(CORE_VOCAB);
  assert.equal(result.ok, true);
});

test("the core vocabulary declares the opinionated networks and the bare decide role", () => {
  assert.equal(CORE_VOCAB.version, CORE_VOCAB_VERSION);
  const networks = Object.keys(CORE_VOCAB.networks).sort();
  assert.deepEqual(networks, ["ci", "decide", "implementation", "planning", "qa"]);
});

test("review roles opt into strict distinct-family seating with red/blue seats", () => {
  for (const network of ["planning", "qa", "implementation"] as const) {
    const reviewer = CORE_VOCAB.networks[network]?.roles?.reviewer;
    assert.ok(reviewer !== undefined, `${network}.reviewer exists`);
    assert.equal(reviewer?.seatsDistinctFamily, true);
    assert.deepEqual(reviewer?.seats, ["red", "blue"]);
  }
});

test("the core vocabulary is deep-frozen against mutation", () => {
  assert.equal(Object.isFrozen(CORE_VOCAB), true);
  assert.equal(Object.isFrozen(CORE_VOCAB.networks), true);
  assert.equal(Object.isFrozen(CORE_VOCAB.networks.planning), true);
  assert.throws(() => {
    // Attempting to mutate the frozen artifact throws in strict mode.
    Object.assign(CORE_VOCAB.networks.planning.roles ?? {}, { hacked: {} });
  });
});
