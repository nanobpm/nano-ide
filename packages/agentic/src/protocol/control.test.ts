import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CONTROL_FRAME_MARKER,
  CONTROL_FRAME_VERSION,
  isInboundControlEnvelope,
  parseInboundRelayChunk,
  encodeInboundControlFrame,
  type InboundControlFrame,
} from "./control.ts";

test("marker + version are the canonical tag", () => {
  assert.equal(CONTROL_FRAME_MARKER, "nanoControlFrame");
  assert.equal(CONTROL_FRAME_VERSION, 1);
});

test("isInboundControlEnvelope only accepts the tagged object at the current version", () => {
  assert.ok(isInboundControlEnvelope({ [CONTROL_FRAME_MARKER]: 1, kind: "cancel" }));
  assert.ok(!isInboundControlEnvelope({ [CONTROL_FRAME_MARKER]: 2, kind: "cancel" }));
  assert.ok(!isInboundControlEnvelope({ kind: "cancel" }));
  assert.ok(!isInboundControlEnvelope("cancel"));
  assert.ok(!isInboundControlEnvelope(null));
  assert.ok(!isInboundControlEnvelope([{ [CONTROL_FRAME_MARKER]: 1 }]));
});

test("prompt frame decodes with its text", () => {
  const chunk = encodeInboundControlFrame({ kind: "prompt", text: "hello" });
  const result = parseInboundRelayChunk(chunk);
  assert.ok(result.ok);
  assert.equal(result.structured, true);
  assert.deepEqual(result.frame, { kind: "prompt", text: "hello" });
});

test("cancel frame decodes with and without a reason", () => {
  const bare = parseInboundRelayChunk(encodeInboundControlFrame({ kind: "cancel" }));
  assert.ok(bare.ok && bare.frame.kind === "cancel");
  assert.equal(bare.ok && "reason" in bare.frame, false);

  const withReason = parseInboundRelayChunk(
    encodeInboundControlFrame({ kind: "cancel", reason: "stop" }),
  );
  assert.ok(withReason.ok);
  assert.deepEqual(withReason.frame, { kind: "cancel", reason: "stop" });
});

test("permission frame carries the request id and outcome", () => {
  for (const outcome of ["granted", "denied"] as const) {
    const chunk = encodeInboundControlFrame({ kind: "permission", requestId: "r1", outcome });
    const result = parseInboundRelayChunk(chunk);
    assert.ok(result.ok);
    assert.deepEqual(result.frame, { kind: "permission", requestId: "r1", outcome });
  }
});

test("a bare keystroke string decodes as a prompt verbatim (legacy raw-byte steer)", () => {
  for (const raw of ["ls -la\n", "\u0003", "y", "{not json", "42", "true"]) {
    const result = parseInboundRelayChunk(raw);
    assert.ok(result.ok, raw);
    assert.equal(result.structured, false, raw);
    assert.deepEqual(result.frame, { kind: "prompt", text: raw }, raw);
  }
});

test("an untagged JSON object is a legacy prompt, not a control frame", () => {
  const chunk = JSON.stringify({ kind: "cancel" });
  const result = parseInboundRelayChunk(chunk);
  assert.ok(result.ok);
  assert.equal(result.structured, false);
  assert.deepEqual(result.frame, { kind: "prompt", text: chunk });
});

test("a tagged-but-malformed envelope is an error, never a silent prompt", () => {
  const cases: Array<{ chunk: string; code: string }> = [
    { chunk: JSON.stringify({ [CONTROL_FRAME_MARKER]: 1 }), code: "bad-kind" },
    { chunk: JSON.stringify({ [CONTROL_FRAME_MARKER]: 1, kind: "nope" }), code: "bad-kind" },
    { chunk: JSON.stringify({ [CONTROL_FRAME_MARKER]: 1, kind: "prompt" }), code: "bad-prompt-text" },
    {
      chunk: JSON.stringify({ [CONTROL_FRAME_MARKER]: 1, kind: "permission", outcome: "granted" }),
      code: "bad-permission-request-id",
    },
    {
      chunk: JSON.stringify({
        [CONTROL_FRAME_MARKER]: 1,
        kind: "permission",
        requestId: "r",
        outcome: "meh",
      }),
      code: "bad-permission-outcome",
    },
  ];
  for (const c of cases) {
    const result = parseInboundRelayChunk(c.chunk);
    assert.ok(!result.ok, c.chunk);
    assert.ok(!result.ok && result.errors.some((e) => e.code === c.code), c.chunk);
  }
});

test("every frame kind round-trips through encode/parse", () => {
  const frames: InboundControlFrame[] = [
    { kind: "prompt", text: "多 bytes ✓" },
    { kind: "cancel" },
    { kind: "cancel", reason: "why" },
    { kind: "permission", requestId: "req-42", outcome: "denied" },
  ];
  for (const frame of frames) {
    const back = parseInboundRelayChunk(encodeInboundControlFrame(frame));
    assert.ok(back.ok);
    assert.deepEqual(back.frame, frame);
  }
});
