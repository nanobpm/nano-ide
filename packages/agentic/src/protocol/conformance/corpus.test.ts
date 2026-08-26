import { test } from "node:test";
import assert from "node:assert/strict";
import { MESSAGE_FAMILIES } from "../families.ts";
import { QOS_LANES } from "../lanes.ts";
import { GOLDEN_FRAMES } from "./frames.ts";
import type { FrameDirection } from "./frames.ts";
import { MALFORMED_FRAMES } from "./malformed.ts";
import type { FrameDecodeErrorCode } from "../frame.ts";
import {
  parseInboundRelayChunk,
  encodeInboundControlFrame,
  type InboundControlErrorCode,
  type InboundControlKind,
} from "../control.ts";
import { VALID_CONTROL_FRAMES, MALFORMED_CONTROL_FRAMES } from "./control.ts";

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

test("golden frames cover every channel direction", () => {
  // Derived from the FrameDirection union via an exhaustive Record so tsc fails
  // when the union grows without a covering golden — no hand-maintained list.
  const ALL_DIRECTIONS: Record<FrameDirection, true> = {
    "worker->hub": true,
    "hub->worker": true,
    "hub->observers": true,
  };
  const covered = new Set<string>(GOLDEN_FRAMES.map((g) => g.direction));
  for (const direction of Object.keys(ALL_DIRECTIONS)) {
    assert.ok(covered.has(direction), `no golden frame covers direction: ${direction}`);
  }
});

test("malformed corpus covers every decode-error code", () => {
  // Derived from the FrameDecodeErrorCode union via an exhaustive Record so tsc
  // fails when the union grows without a covering key — no hand-maintained list.
  const ALL_CODES: Record<FrameDecodeErrorCode, true> = {
    empty: true,
    "short-header": true,
    "bad-magic": true,
    "unsupported-version": true,
    "unknown-lane": true,
    "unknown-family": true,
    "truncated-payload": true,
    "trailing-bytes": true,
    "invalid-payload-json": true,
  };
  const allCodes = Object.keys(ALL_CODES);
  const covered = new Set<string>(MALFORMED_FRAMES.map((m) => m.expected));
  for (const code of allCodes) {
    assert.ok(covered.has(code), `no malformed vector covers code: ${code}`);
  }
});

test("golden frame names are unique", () => {
  const names = GOLDEN_FRAMES.map((g) => g.name);
  assert.equal(new Set(names).size, names.length);
});

// --- Inbound control vocabulary (steer-in) -------------------------------

test("valid control corpus decodes to its declared frame", () => {
  for (const v of VALID_CONTROL_FRAMES) {
    const result = parseInboundRelayChunk(v.chunk);
    assert.ok(result.ok, `${v.name}: ${result.ok ? "" : JSON.stringify(result.errors)}`);
    assert.deepEqual(result.frame, v.frame, v.name);
    assert.equal(result.structured, v.structured, `${v.name}: structured flag`);
  }
});

test("structured control frames round-trip through the encoder", () => {
  for (const v of VALID_CONTROL_FRAMES) {
    if (!v.roundTrips) continue;
    const encoded = encodeInboundControlFrame(v.frame);
    const back = parseInboundRelayChunk(encoded);
    assert.ok(back.ok, `${v.name}: re-decode failed`);
    assert.deepEqual(back.frame, v.frame, `${v.name}: round-trip frame`);
    assert.equal(back.structured, true, `${v.name}: round-trip is structured`);
  }
});

test("valid control corpus covers every control kind", () => {
  const ALL_KINDS: Record<InboundControlKind, true> = {
    prompt: true,
    cancel: true,
    permission: true,
  };
  const covered = new Set<string>(VALID_CONTROL_FRAMES.map((v) => v.frame.kind));
  for (const kind of Object.keys(ALL_KINDS)) {
    assert.ok(covered.has(kind), `no valid control vector covers kind: ${kind}`);
  }
});

test("legacy bare-string steer still decodes as a prompt (no regression)", () => {
  const legacy = VALID_CONTROL_FRAMES.filter((v) => !v.structured);
  assert.ok(legacy.length > 0, "corpus must retain legacy bare-string vectors");
  for (const v of legacy) {
    const result = parseInboundRelayChunk(v.chunk);
    assert.ok(result.ok && result.frame.kind === "prompt", v.name);
    assert.equal(result.ok && result.frame.kind === "prompt" && result.frame.text, v.chunk, v.name);
  }
});

test("malformed control corpus is rejected with the expected code", () => {
  for (const m of MALFORMED_CONTROL_FRAMES) {
    const result = parseInboundRelayChunk(m.chunk);
    assert.ok(!result.ok, `${m.name}: expected rejection`);
    assert.ok(
      !result.ok && result.errors.some((e) => e.code === m.expected),
      `${m.name}: expected code ${m.expected}, got ${result.ok ? "ok" : JSON.stringify(result.errors)}`,
    );
  }
});

test("malformed control corpus covers every control error code", () => {
  const ALL_CODES: Record<InboundControlErrorCode, true> = {
    "bad-kind": true,
    "bad-prompt-text": true,
    "bad-cancel-reason": true,
    "bad-permission-request-id": true,
    "bad-permission-outcome": true,
  };
  const covered = new Set<string>(MALFORMED_CONTROL_FRAMES.map((m) => m.expected));
  for (const code of Object.keys(ALL_CODES)) {
    assert.ok(covered.has(code), `no malformed control vector covers code: ${code}`);
  }
});
