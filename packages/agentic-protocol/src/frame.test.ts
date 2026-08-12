import { test } from "node:test";
import assert from "node:assert/strict";
import {
  decodeFrame,
  encodeFrame,
  FrameDecodeError,
  FrameEncodeError,
  MAX_SEQ,
  type Frame,
} from "./frame.ts";
import { bytesToHex, hexToBytes } from "./hex.ts";
import { GOLDEN_FRAMES } from "./conformance/frames.ts";
import { MALFORMED_FRAMES } from "./conformance/malformed.ts";

test("golden frames: encode matches the committed wire hex", () => {
  for (const golden of GOLDEN_FRAMES) {
    assert.equal(bytesToHex(encodeFrame(golden.frame)), golden.hex, golden.name);
  }
});

test("golden frames: decode reproduces the frame (round-trip both directions)", () => {
  for (const golden of GOLDEN_FRAMES) {
    const decoded = decodeFrame(hexToBytes(golden.hex));
    assert.deepEqual(decoded, golden.frame, golden.name);
    // And re-encoding the decoded frame is byte-identical.
    assert.equal(bytesToHex(encodeFrame(decoded)), golden.hex, golden.name);
  }
});

test("malformed frames: decode rejects with the specified error code", () => {
  for (const vector of MALFORMED_FRAMES) {
    assert.throws(
      () => decodeFrame(hexToBytes(vector.hex)),
      (error: unknown) => {
        assert.ok(error instanceof FrameDecodeError, `${vector.name}: expected FrameDecodeError`);
        assert.equal(error.code, vector.expected, vector.name);
        return true;
      },
      vector.name,
    );
  }
});

test("decode: decodes a frame subarray with a non-zero byteOffset correctly", () => {
  // Guards the DataView(byteOffset,length) wiring: a valid frame embedded in a
  // larger buffer must decode from its subarray view, not from offset 0.
  const golden = GOLDEN_FRAMES[0];
  const bytes = hexToBytes(golden.hex);
  const padded = new Uint8Array(bytes.length + 5);
  padded.set(bytes, 5);
  const view = padded.subarray(5);
  assert.deepEqual(decodeFrame(view), golden.frame);
});

test("encode: rejects an invalid lane", () => {
  const frame: Frame = JSON.parse('{"lane":"urgent","family":"relay","seq":0,"payload":null}');
  assert.throws(
    () => encodeFrame(frame),
    (error: unknown) => error instanceof FrameEncodeError && error.code === "invalid-lane",
  );
});

test("encode: rejects an invalid family", () => {
  const frame: Frame = JSON.parse('{"lane":"control","family":"gossip","seq":0,"payload":null}');
  assert.throws(
    () => encodeFrame(frame),
    (error: unknown) => error instanceof FrameEncodeError && error.code === "invalid-family",
  );
});

test("encode: rejects out-of-range seq (boundary above uint32 max)", () => {
  const frame: Frame = { lane: "control", family: "heartbeat", seq: MAX_SEQ + 1, payload: null };
  assert.throws(
    () => encodeFrame(frame),
    (error: unknown) => error instanceof FrameEncodeError && error.code === "invalid-seq",
  );
});

test("encode: rejects a non-integer seq", () => {
  const frame: Frame = { lane: "control", family: "heartbeat", seq: 1.5, payload: null };
  assert.throws(
    () => encodeFrame(frame),
    (error: unknown) => error instanceof FrameEncodeError && error.code === "invalid-seq",
  );
});

test("encode: rejects an unserialisable payload (bigint)", () => {
  const frame: Frame = { lane: "bulk", family: "relay", seq: 0, payload: { n: 1n } };
  assert.throws(
    () => encodeFrame(frame),
    (error: unknown) => error instanceof FrameEncodeError && error.code === "unserialisable-payload",
  );
});

test("encode: seq boundaries 0 and uint32 max round-trip", () => {
  for (const seq of [0, MAX_SEQ]) {
    const frame: Frame = { lane: "control", family: "heartbeat", seq, payload: { instance: "w" } };
    assert.deepEqual(decodeFrame(encodeFrame(frame)), frame);
  }
});
