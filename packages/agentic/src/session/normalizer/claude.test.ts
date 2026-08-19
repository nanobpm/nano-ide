import assert from "node:assert/strict";
import { test } from "node:test";
import { claudeNormalizer } from "./claude.ts";
import { normalizeSession } from "./link.ts";
import { NormalizerDialectError } from "./types.ts";

test("claude expands a multi-part assistant message into ordered canonical events", () => {
  const events = normalizeSession(claudeNormalizer, [
    {
      type: "assistant",
      message: {
        model: "claude",
        content: [
          { type: "thinking", thinking: "let me plan", signature: "SIG-1" },
          { type: "text", text: "here goes" },
          { type: "tool_use", id: "u1", name: "edit", input: { path: "x" } },
        ],
        usage: { input_tokens: 5, output_tokens: 7 },
      },
    },
  ]);
  assert.deepEqual(events.map((e) => e.type), ["reasoning", "assistant", "tool-call", "usage"]);
  const reasoning = events[0];
  if (reasoning.type === "reasoning") assert.equal(reasoning.providerContinuation, "SIG-1");
  const usage = events[3];
  if (usage.type === "usage") assert.equal(usage.model, "claude");
});

test("claude maps a tool_result user frame, honouring is_error", () => {
  const ok = normalizeSession(claudeNormalizer, [
    { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "u1", content: "fine" }] } },
  ]);
  assert.equal(ok[0].type === "tool-result" && ok[0].ok, true);

  const bad = normalizeSession(claudeNormalizer, [
    { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "u1", content: "nope", is_error: true }] } },
  ]);
  assert.equal(bad[0].type === "tool-result" && bad[0].ok, false);
});

test("claude treats the init system frame as metadata (no canonical event)", () => {
  assert.deepEqual(normalizeSession(claudeNormalizer, [{ type: "system", subtype: "init", tools: [], model: "m" }]), []);
});

test("claude accepts a bare-string message content", () => {
  const events = normalizeSession(claudeNormalizer, [
    { type: "assistant", message: { content: "just text" } },
  ]);
  assert.equal(events[0].type === "assistant" && events[0].text, "just text");
});

test("claude folds a terminal result frame's usage in", () => {
  const events = normalizeSession(claudeNormalizer, [
    { type: "result", subtype: "success", model: "m-2", usage: { input_tokens: 20, output_tokens: 8 } },
  ]);
  assert.equal(events.length, 1);
  const usage = events[0];
  assert.ok(usage.type === "usage");
  if (usage.type === "usage") {
    assert.equal(usage.inputTokens, 20);
    assert.equal(usage.outputTokens, 8);
    assert.equal(usage.model, "m-2");
  }
});

test("claude fails loudly on an assistant frame with no message object", () => {
  assert.throws(() => claudeNormalizer.toDrafts({ type: "assistant" }), NormalizerDialectError);
});
