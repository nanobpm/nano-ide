import { test } from "node:test";
import assert from "node:assert/strict";
import { MESSAGE_FAMILIES } from "../families.ts";
import { QOS_LANES } from "../lanes.ts";
import { GOLDEN_FRAMES } from "./frames.ts";
import { MALFORMED_FRAMES } from "./malformed.ts";
import type { FrameDecodeErrorCode } from "../frame.ts";

// The corpus is only a defence against drift if it is exhaustive. These tests
// fail if a new family, lane, or decode-error code is added without a covering
// vector — forcing the corpus to grow with the contract.

test("golden frames cover every message family", () => {
  const covered = new Set(GOLDEN_FRAMES.map((g) => g.frame.family));
  for (const family of MESSAGE_FAMILIES) {
    assert.ok(covered.has(family), `no golden frame covers family: ${family}`);
  }
});

test("golden frames cover every QoS lane", () => {
  const covered = new Set(GOLDEN_FRAMES.map((g) => g.frame.lane));
  for (const lane of QOS_LANES) {
    assert.ok(covered.has(lane), `no golden frame covers lane: ${lane}`);
  }
});

test("golden frames cover both channel directions", () => {
  const covered = new Set(GOLDEN_FRAMES.map((g) => g.direction));
  assert.ok(covered.has("worker->hub"));
  assert.ok(covered.has("hub->worker"));
});

test("malformed corpus covers every decode-error code", () => {
  const allCodes: readonly FrameDecodeErrorCode[] = [
    "empty",
    "short-header",
    "bad-magic",
    "unsupported-version",
    "unknown-lane",
    "unknown-family",
    "truncated-payload",
    "trailing-bytes",
    "invalid-payload-json",
  ];
  const covered = new Set(MALFORMED_FRAMES.map((m) => m.expected));
  for (const code of allCodes) {
    assert.ok(covered.has(code), `no malformed vector covers code: ${code}`);
  }
});

test("golden frame names are unique", () => {
  const names = GOLDEN_FRAMES.map((g) => g.name);
  assert.equal(new Set(names).size, names.length);
});
