// S5 completeness guard (issue #297): derived STATIC seam-completeness over the enumerated
// seams, on the DEFAULT no-opt-in, network-free path.
//
// The seam set is DERIVED from S1's `seamInventory()` (not a duplicated literal list), so a
// NEW seam added later without all three backings (fake, record/replay, real) makes this
// guard fail automatically — exactly the regression the epic's completeness rule protects.
//
// `hasReal` reflects STATIC existence of a documented real backend (S4 registers the static
// descriptor UNCONDITIONALLY at import via `registerRealSeamDescriptor`), NOT live
// activation — so this guard MUST NOT set `URBAN_TESTKIT_AI_REAL` and MUST NOT instantiate a
// real adapter. Importing the `/ai` barrel is enough to bring both seams' descriptors into
// existence; because S4 registers descriptors for BOTH seams at import, the guard passes on
// the combined default state.

import assert from "node:assert/strict";
import { test } from "node:test";
import { seamInventory } from "../index.ts";
import { isRealAiEnabled } from "../adapters/real/env.ts";

// The exactly-two-seams fact is part of the epic's contract (multimodal is folded into the
// chat seam — NOT a separate entry). Assert the derived enumeration matches without
// exempting any seam.
const EXPECTED_SEAMS = ["ChatModelAdapter", "EmbeddingModelAdapter"];

test("completeness guard: runs on the default path with NO live opt-in set", () => {
  assert.equal(
    isRealAiEnabled(),
    false,
    "the completeness guard checks STATIC existence — the LIVE opt-in must be OFF",
  );
});

test("completeness guard: seamInventory enumerates exactly the two seams (multimodal folded into chat)", () => {
  const seams = seamInventory().map((entry) => entry.seam);
  assert.deepEqual([...seams].sort(), [...EXPECTED_SEAMS].sort());
});

test("completeness guard: EVERY enumerated seam has a fake, record/replay AND a documented real backend", () => {
  const inventory = seamInventory();
  assert.ok(inventory.length > 0, "the inventory must enumerate at least one seam");

  // Derive the assertion set from the inventory itself — no seam is special-cased or
  // exempted. If a future seam is added without all three backings, this loop fails.
  for (const entry of inventory) {
    assert.equal(entry.hasFake, true, `${entry.seam} must have a deterministic fake backend`);
    assert.equal(
      entry.hasRecordReplay,
      true,
      `${entry.seam} must have a record/replay backend`,
    );
    assert.equal(
      entry.hasReal,
      true,
      `${entry.seam} must have a documented real backend (static descriptor) on the default path`,
    );
    assert.ok(
      entry.docRef !== null && entry.docRef.trim().length > 0,
      `${entry.seam} must carry a non-empty docRef pointing at its real implementation`,
    );
  }
});

test("completeness guard: hasReal derives purely from the static descriptor, no opt-in required", () => {
  // Re-assert on a fresh inventory read with the opt-in still OFF: hasReal is true because a
  // static descriptor is registered at import, decoupled from runtime activation. This is
  // the exact combined-state invariant S4 relies on and S5 certifies.
  assert.equal(isRealAiEnabled(), false);
  for (const entry of seamInventory()) {
    assert.equal(entry.hasReal, true, `${entry.seam} static real descriptor present without opt-in`);
  }
});
