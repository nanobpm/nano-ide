import assert from "node:assert/strict";
import { test } from "node:test";
import { copilotNormalizer } from "./copilot.ts";
import { normalizeSession } from "./link.ts";
import { NormalizerDialectError } from "./types.ts";

test("copilot maps turn boundaries, system, and usage frames", () => {
  const events = normalizeSession(copilotNormalizer, [
    { type: "system_message", text: "you are a coding agent" },
    { type: "turn_started", turn: 0 },
    { type: "assistant_message", text: "done" },
    { type: "turn_completed", turn: 0 },
    { type: "usage", input_tokens: 10, output_tokens: 3, model: "gpt" },
  ]);
  assert.deepEqual(events.map((e) => e.type), ["system", "turn-start", "assistant", "turn-end", "usage"]);
});

test("copilot lifts a failed tool result (isError) to ok:false", () => {
  const [call, result] = normalizeSession(copilotNormalizer, [
    { type: "tool_call", id: "c9", name: "run", arguments: { cmd: "ls" } },
    { type: "tool_result", id: "c9", isError: true, output: "boom" },
  ]);
  assert.equal(call.type, "tool-call");
  assert.equal(result.type, "tool-result");
  if (result.type === "tool-result") {
    assert.equal(result.ok, false);
    assert.equal(result.result, "boom");
    assert.equal(result.callId, "c9");
  }
});

test("copilot correlates a tool call and its result by callId across generated ids", () => {
  const events = normalizeSession(copilotNormalizer, [
    { type: "tool_call", id: "abc", name: "write", arguments: {} },
    { type: "tool_result", id: "abc", output: "ok" },
  ]);
  assert.equal(events[0].type === "tool-call" && events[0].callId, "abc");
  assert.equal(events[1].type === "tool-result" && events[1].callId, "abc");
});

test("copilot preserves reasoningOpaque as the canonical providerContinuation", () => {
  const [reasoning] = normalizeSession(copilotNormalizer, [
    { type: "reasoning", text: "thinking", reasoningOpaque: "ENCRYPTED-BLOB" },
  ]);
  assert.ok(reasoning.type === "reasoning");
  if (reasoning.type === "reasoning") {
    assert.equal(reasoning.text, "thinking");
    assert.equal(reasoning.providerContinuation, "ENCRYPTED-BLOB");
  }
});

test("copilot ignores transport frames it does not model", () => {
  assert.deepEqual(normalizeSession(copilotNormalizer, [{ type: "heartbeat" }, { type: "session_ready" }]), []);
});

test("a structurally invalid record fails loudly with a dialect error", () => {
  assert.throws(() => copilotNormalizer.toDrafts({ type: "tool_call", name: "no-id" }), NormalizerDialectError);
  assert.throws(() => copilotNormalizer.toDrafts(42), NormalizerDialectError);
});
