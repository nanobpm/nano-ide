/**
 * Conformance: the worker client is held to the SAME shared adversarial corpus
 * (`@nanobpm/agentic-protocol/conformance`) as the S0 codec and the cross-repo
 * c8ctl client. A shared prose spec does not stop divergence — shared vectors
 * do. This test file is the package's `test:conformance` entry point and runs
 * with no build step (source-only imports), so the CI `conformance` job
 * exercises the real vectors against this client.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  GOLDEN_FRAMES,
  MALFORMED_FRAMES,
  VALID_TOKENS,
  INVALID_TOKENS,
} from "@nanobpm/agentic-protocol/source/conformance";
import { AgenticClient } from "./client.ts";
import {
  FrameDecodeError,
  bytesToHex,
  decodeFrame,
  encodeFrame,
  hexToBytes,
  isValidToken,
  validatePayload,
} from "./protocol.ts";
import type { Frame, ServePayload } from "./protocol.ts";
import { fakeTransportFactory } from "./testkit.ts";

test("golden frames round-trip through the codec the client uses (both directions)", () => {
  for (const golden of GOLDEN_FRAMES) {
    const decoded = decodeFrame(hexToBytes(golden.hex));
    assert.deepEqual(decoded, golden.frame, `decode ${golden.name}`);
    assert.equal(bytesToHex(encodeFrame(golden.frame)), golden.hex, `encode ${golden.name}`);
  }
});

test("malformed vectors reject with the codes the corpus specifies", () => {
  for (const bad of MALFORMED_FRAMES) {
    assert.throws(
      () => decodeFrame(hexToBytes(bad.hex)),
      (error: unknown) => {
        assert.ok(error instanceof FrameDecodeError, `${bad.name} threw FrameDecodeError`);
        assert.equal(error.code, bad.expected, `${bad.name} code`);
        return true;
      },
    );
  }
});

test("the client tolerates every malformed corpus vector without crashing", () => {
  const t = fakeTransportFactory();
  const client = new AgenticClient({
    url: "ws://test",
    instance: "w-conformance",
    transport: t.factory,
    reconnect: { enabled: false },
    serveTimeoutMs: 0,
  });
  const errors: Error[] = [];
  client.onError((e) => errors.push(e));
  client.connect();
  t.last().fireOpen();

  for (const bad of MALFORMED_FRAMES) {
    t.last().deliver(hexToBytes(bad.hex));
  }
  // Every malformed vector surfaced an error; the client is still usable.
  assert.equal(errors.length, MALFORMED_FRAMES.length);
  client.heartbeat();
  assert.ok(t.last().sentFrames.some((f) => f.family === "heartbeat"));
  client.close();
});

test("the client resolves register against a golden SERVE frame from the corpus", async () => {
  const golden = GOLDEN_FRAMES.find((g) => g.frame.family === "serve");
  assert.ok(golden, "corpus has a serve golden");
  const servePayload = golden.frame.payload;
  assert.ok(isServePayload(servePayload));

  const t = fakeTransportFactory();
  const client = new AgenticClient({
    url: "ws://test",
    instance: servePayload.instance,
    transport: t.factory,
    reconnect: { enabled: false },
    serveTimeoutMs: 1000,
  });
  client.connect();
  t.last().fireOpen();
  const pending = client.register({ capability: { cognition: "opus" } });
  t.last().deliver(hexToBytes(golden.hex));
  const { serve } = await pending;
  assert.deepEqual(serve, servePayload.tokens);
  client.close();
});

test("frames the client produces satisfy the S0 payload contract and family codes", () => {
  const t = fakeTransportFactory();
  const client = new AgenticClient({
    url: "ws://test",
    instance: "w-1",
    transport: t.factory,
    reconnect: { enabled: false },
    serveTimeoutMs: 0,
    capability: { cognition: "opus", weight: 3, family: "anthropic", host: "mac-01" },
  });
  client.connect();
  t.last().fireOpen(); // auto-registers
  client.heartbeat();
  client.relay("stdout", "multi-byte: café ☕");
  client.deregister("done");

  for (const frame of t.last().sentFrames) {
    // Every emitted frame decodes to a known family and passes its contract.
    const result = validatePayload(frame.family, frame.payload);
    assert.ok(result.ok, `emitted ${frame.family} frame is contract-valid`);
    // And its wire bytes round-trip byte-for-byte.
    assert.equal(bytesToHex(encodeFrame(frame)), bytesToHex(encodeFrame(reencode(frame))));
  }
  const families = t.last().sentFrames.map((f) => f.family);
  assert.deepEqual(new Set(families), new Set(["register", "heartbeat", "relay", "deregister"]));
  client.close();
});

test("the client accepts exactly the corpus's valid routing tokens in a SERVE", () => {
  // The client validates SERVE tokens via the S0 codec's isValidToken; assert it
  // agrees with the corpus so token acceptance can never drift from the vectors.
  for (const valid of VALID_TOKENS) {
    assert.ok(isValidToken(valid.token), `accepts ${valid.name}`);
  }
  for (const invalid of INVALID_TOKENS) {
    assert.ok(!isValidToken(invalid.token), `rejects ${invalid.name}`);
  }
});

function reencode(frame: Frame): Frame {
  return decodeFrame(encodeFrame(frame));
}

function isServePayload(payload: unknown): payload is ServePayload {
  if (typeof payload !== "object" || payload === null) {
    return false;
  }
  if (!("instance" in payload) || !("tokens" in payload)) {
    return false;
  }
  const { instance, tokens } = payload;
  return typeof instance === "string" && Array.isArray(tokens);
}
