import assert from "node:assert/strict";
import { test } from "node:test";
import { ACP_FIDELITY_GAPS, type AcpClassifiedUpdate, classifyUpdate } from "./normalize.ts";

function textChunk(sessionUpdate: string, text: string, extra: Record<string, unknown> = {}): unknown {
  return { sessionUpdate, content: { type: "text", text }, ...extra };
}

test("agent_message_chunk → an assistant message", () => {
  const result = classifyUpdate(textChunk("agent_message_chunk", "hello"));
  assert.deepEqual(result, { kind: "message", role: "assistant", messageId: null, text: "hello" });
});

test("agent_thought_chunk → a reasoning message", () => {
  const result = classifyUpdate(textChunk("agent_thought_chunk", "thinking", { messageId: "m1" }));
  assert.deepEqual(result, { kind: "message", role: "reasoning", messageId: "m1", text: "thinking" });
});

test("user_message_chunk → a user message", () => {
  const result = classifyUpdate(textChunk("user_message_chunk", "hi"));
  assert.deepEqual(result, { kind: "message", role: "user", messageId: null, text: "hi" });
});

test("a chunk with an array of content blocks concatenates their text", () => {
  const update = {
    sessionUpdate: "agent_message_chunk",
    content: [
      { type: "text", text: "a" },
      { type: "image", data: "…", mimeType: "image/png" },
      { type: "text", text: "b" },
    ],
  };
  assert.deepEqual(classifyUpdate(update), { kind: "message", role: "assistant", messageId: null, text: "ab" });
});

test("a chunk with no textual content is ignored (a fidelity gap, not data)", () => {
  const update = { sessionUpdate: "agent_message_chunk", content: { type: "image", data: "…", mimeType: "image/png" } };
  const result = classifyUpdate(update);
  assert.equal(result.kind, "ignored");
});

test("tool_call → a tool-call using title as the name and rawInput as args", () => {
  const update = {
    sessionUpdate: "tool_call",
    toolCallId: "call-1",
    title: "Read config",
    kind: "read",
    status: "pending",
    rawInput: { path: "/etc/app.conf" },
  };
  assert.deepEqual(classifyUpdate(update), {
    kind: "tool-call",
    callId: "call-1",
    name: "Read config",
    args: { path: "/etc/app.conf" },
  });
});

test("tool_call without a title falls back to the call id for the name", () => {
  const result = classifyUpdate({ sessionUpdate: "tool_call", toolCallId: "call-2" });
  assert.deepEqual(result, { kind: "tool-call", callId: "call-2", name: "call-2", args: undefined });
});

test("tool_call_update completed → a successful tool-result carrying rawOutput", () => {
  const update = { sessionUpdate: "tool_call_update", toolCallId: "call-1", status: "completed", rawOutput: { ok: 1 } };
  assert.deepEqual(classifyUpdate(update), { kind: "tool-result", callId: "call-1", ok: true, result: { ok: 1 } });
});

test("tool_call_update failed → a failed tool-result falling back to content", () => {
  const update = {
    sessionUpdate: "tool_call_update",
    toolCallId: "call-1",
    status: "failed",
    content: [{ type: "content", content: { type: "text", text: "boom" } }],
  };
  const result = classifyUpdate(update);
  assert.equal(result.kind, "tool-result");
  assert.equal(result.kind === "tool-result" && result.ok, false);
});

test("an intermediate tool_call_update (in_progress) is ignored", () => {
  const result = classifyUpdate({ sessionUpdate: "tool_call_update", toolCallId: "call-1", status: "in_progress" });
  assert.equal(result.kind, "ignored");
});

test("non-canonical updates (plan, unknown, malformed) are ignored without throwing", () => {
  for (const value of [
    { sessionUpdate: "plan", plan: { entries: [] } },
    { sessionUpdate: "available_commands_update", availableCommands: [] },
    { sessionUpdate: "usage_update", used: 10, size: 100 },
    { notAnUpdate: true },
    "nonsense",
    null,
    42,
  ]) {
    assert.equal(classifyUpdate(value).kind, "ignored");
  }
});

test("the classifier only ever produces the five canonical event kinds", () => {
  const corpus: unknown[] = [
    textChunk("agent_message_chunk", "x"),
    textChunk("agent_thought_chunk", "y"),
    textChunk("user_message_chunk", "z"),
    { sessionUpdate: "tool_call", toolCallId: "c", title: "t" },
    { sessionUpdate: "tool_call_update", toolCallId: "c", status: "completed" },
    { sessionUpdate: "plan" },
  ];
  const producedTypes = new Set<string>();
  for (const value of corpus) {
    const result: AcpClassifiedUpdate = classifyUpdate(value);
    if (result.kind === "message") producedTypes.add(result.role);
    else producedTypes.add(result.kind);
  }
  producedTypes.delete("ignored");
  assert.deepEqual(
    [...producedTypes].sort(),
    ["assistant", "reasoning", "tool-call", "tool-result", "user"],
    "ACP can only reconstruct message/tool events; everything else is a documented gap",
  );
});

test("ACP_FIDELITY_GAPS documents the canonical concepts ACP cannot reconstruct", () => {
  assert.ok(ACP_FIDELITY_GAPS.length > 0);
  const blob = ACP_FIDELITY_GAPS.map((gap) => `${gap.concept} ${gap.detail}`).join(" ").toLowerCase();
  // The canonical event types ACP has no source for must each be accounted for.
  for (const missing of ["usage", "compaction", "turn", "continuation", "model"]) {
    assert.ok(blob.includes(missing), `fidelity gaps should mention "${missing}"`);
  }
});
