import assert from "node:assert/strict";
import { test } from "node:test";
import { decodeFrame, encodeFrame, type Frame, validatePayload } from "@nanobpm/agentic-protocol";
import { CORE_VOCAB } from "./core-vocab.ts";
import { VocabResolver } from "./resolver.ts";
import { buildServeFrame, buildServePayload, serveCapability, type ServeSink } from "./serve.ts";

test("buildServePayload copies tokens into a serve payload", () => {
  const payload = buildServePayload("w-1", ["planning.planner"]);
  assert.deepEqual(payload, { instance: "w-1", tokens: ["planning.planner"] });
  assert.equal(validatePayload("serve", payload).ok, true);
});

test("buildServeFrame rides the control lane and round-trips through the codec", () => {
  const frame = buildServeFrame("w-1", ["planning.planner", "planning.reviewer"], 3);
  assert.equal(frame.lane, "control");
  assert.equal(frame.family, "serve");
  assert.equal(frame.seq, 3);
  const decoded = decodeFrame(encodeFrame(frame));
  assert.deepEqual(decoded.payload, { instance: "w-1", tokens: ["planning.planner", "planning.reviewer"] });
});

test("buildServeFrame refuses an invalid routing token", () => {
  assert.throws(() => buildServeFrame("w-1", ["Not A Token"]), /invalid serve frame/);
});

test("serveCapability resolves a capability and emits the serve frame", () => {
  const resolver = new VocabResolver(CORE_VOCAB);
  const sent: Frame[] = [];
  const sink: ServeSink = { send: (frame) => sent.push(frame) };

  const resolution = serveCapability(resolver, sink, "w-1", { cognition: "planning", family: "acme" }, 1);

  assert.deepEqual(resolution.tokens, ["planning.planner", "planning.reviewer"]);
  assert.equal(sent.length, 1);
  assert.equal(sent[0]?.family, "serve");
  assert.equal(sent[0]?.lane, "control");
  assert.deepEqual(sent[0]?.payload, {
    instance: "w-1",
    tokens: ["planning.planner", "planning.reviewer"],
  });
});

test("serveCapability serves an empty token set for an unqualified capability", () => {
  const resolver = new VocabResolver(CORE_VOCAB);
  const sent: Frame[] = [];
  const resolution = serveCapability(resolver, { send: (f) => sent.push(f) }, "w-2", { cognition: "unknown" });
  assert.deepEqual(resolution.tokens, []);
  assert.deepEqual(sent[0]?.payload, { instance: "w-2", tokens: [] });
});
