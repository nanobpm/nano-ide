import assert from "node:assert/strict";
import { test } from "node:test";
// Import the barrel so the fake + record/replay backings are declared for both seams.
import "./index.ts";
import { registerRealSeamDescriptor, seamInventory } from "./inventory.ts";

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

test("seamInventory: hasReal is false in slice S1 (no static real descriptor registered)", () => {
  for (const entry of seamInventory()) {
    assert.equal(entry.hasReal, false, `${entry.seam} has no real backend yet`);
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
