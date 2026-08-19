import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
// Import ONLY the fake + record/replay backing modules — NOT the `/ai` barrel. The barrel
// eagerly registers S4's static real-seam descriptors at import, so importing it here would
// force `beforeEach` to clear them, making "hasReal is false" an artifact of the reset
// rather than a genuine property of the import graph. Pulling in just the backings declares
// both seams' fake + record/replay backings while keeping the empty-real default honest.
import "./fakes.ts";
import "./record-replay.ts";
import {
  registerRealSeamDescriptor,
  resetRealSeamDescriptorsForTest,
  seamInventory,
} from "./inventory.ts";

// The real-seam-descriptor registry is module-level mutable state; reset it before every
// test so no test's registration leaks into another. Without this, "hasReal is false"
// would pass only while it runs before the registering test — an order-dependent trap.
beforeEach(resetRealSeamDescriptorsForTest);

test("seamInventory: enumerates exactly the two seams, fake + record/replay backed", () => {
  const inventory = seamInventory();
  assert.deepEqual(
    inventory.map((entry) => entry.seam),
    ["ChatModelAdapter", "EmbeddingModelAdapter"],
  );
  for (const entry of inventory) {
    assert.equal(entry.hasFake, true, `${entry.seam} has a fake`);
    assert.equal(entry.hasRecordReplay, true, `${entry.seam} has record/replay`);
  }
});

test("seamInventory: hasReal is false when no real descriptor is registered (fake + record/replay only)", () => {
  for (const entry of seamInventory()) {
    assert.equal(entry.hasReal, false, `${entry.seam} has no real descriptor registered`);
    assert.equal(entry.docRef, null);
  }
});

test("registerRealSeamDescriptor: flips hasReal/docRef with NO adapter instantiation", () => {
  registerRealSeamDescriptor({ seam: "EmbeddingModelAdapter", docRef: "src/ai/adapters/real#embedding" });
  const entry = seamInventory().find((row) => row.seam === "EmbeddingModelAdapter");
  assert.ok(entry);
  assert.equal(entry.hasReal, true);
  assert.equal(entry.docRef, "src/ai/adapters/real#embedding");
  // The chat seam, with no descriptor, stays false — the derivation is per-seam.
  const chat = seamInventory().find((row) => row.seam === "ChatModelAdapter");
  assert.ok(chat);
  assert.equal(chat.hasReal, false);
});

test("registerRealSeamDescriptor: rejects an empty docRef", () => {
  assert.throws(
    () => registerRealSeamDescriptor({ seam: "ChatModelAdapter", docRef: "   " }),
    /non-empty docRef/,
  );
});

// Guards the defect class the suppressed advisory flagged: a prior test's registration
// must not leak into this one. Running AFTER the registering test above, this only passes
// because `beforeEach` reset the registry — proving the isolation holds regardless of order.
test("seamInventory: real descriptors do not leak across tests", () => {
  for (const entry of seamInventory()) {
    assert.equal(entry.hasReal, false, `${entry.seam} must start with no real backend`);
    assert.equal(entry.docRef, null);
  }
});
