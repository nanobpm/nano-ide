import assert from "node:assert/strict";
import { test } from "node:test";
import { ACP_FIDELITY_GAPS, type AcpClassifiedUpdate, classifyUpdate, parsePromptUsage } from "./normalize.ts";

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
    pending: true,
  });
});

test("tool_call without a title falls back to the call id for the name", () => {
  const result = classifyUpdate({ sessionUpdate: "tool_call", toolCallId: "call-2" });
  assert.deepEqual(result, { kind: "tool-call", callId: "call-2", name: "call-2", args: null });
});

test("tool_call without rawInput yields JSON-serialisable args (null, not dropped undefined)", () => {
  const result = classifyUpdate({ sessionUpdate: "tool_call", toolCallId: "call-3" });
  assert.equal(result.kind, "tool-call");
  // `ToolCallEvent.args` is documented as a JSON-serialisable value; `undefined`
  // is silently dropped by JSON.stringify, so the key must survive a round-trip.
  const roundTripped = JSON.parse(JSON.stringify(result));
  assert.ok("args" in roundTripped, "args key must survive JSON serialisation");
  assert.equal(roundTripped.args, null);
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

test("an intermediate tool_call_update: in_progress or restated rawInput → tool-call-update, otherwise ignored", () => {
  assert.deepEqual(classifyUpdate({ sessionUpdate: "tool_call_update", toolCallId: "call-1", status: "in_progress" }), {
    kind: "tool-call-update",
    callId: "call-1",
    running: true,
  });
  // opencode: the command arrives after the pending tool_call announced only {cwd}.
  assert.deepEqual(
    classifyUpdate({ sessionUpdate: "tool_call_update", toolCallId: "call-1", status: "in_progress", rawInput: { command: "ls", cwd: "/w" } }),
    { kind: "tool-call-update", callId: "call-1", running: true, args: { command: "ls", cwd: "/w" } },
  );
  assert.deepEqual(classifyUpdate({ sessionUpdate: "tool_call_update", toolCallId: "call-1", rawInput: { q: 1 } }), {
    kind: "tool-call-update",
    callId: "call-1",
    running: false,
    args: { q: 1 },
  });
  assert.equal(classifyUpdate({ sessionUpdate: "tool_call_update", toolCallId: "call-1", status: "pending" }).kind, "ignored");
});

test("inherited Object.prototype keys are not treated as chunk types (no prototype pollution)", () => {
  // `sessionUpdate in CHUNK_ROLE` must be an own-property check: a wire value like
  // "toString"/"constructor"/"hasOwnProperty" is an inherited Object.prototype key,
  // not an ACP chunk type, and must never classify a chunk with a bogus role.
  for (const proto of ["toString", "constructor", "hasOwnProperty", "valueOf", "__proto__"]) {
    const result = classifyUpdate({ sessionUpdate: proto, content: { type: "text", text: "x" } });
    assert.equal(result.kind, "ignored", `"${proto}" must be ignored, not classified as a chunk`);
  }
});

test("non-canonical updates (plan, unknown, malformed) are ignored without throwing", () => {
  for (const value of [
    { sessionUpdate: "plan", plan: { entries: [] } },
    { sessionUpdate: "available_commands_update", availableCommands: [] },
    { sessionUpdate: "usage_update", used: -1, size: 100 },
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

test("usage_update is context-window occupancy (with cost when reported)", () => {
  assert.deepEqual(classifyUpdate({ sessionUpdate: "usage_update", used: 13943, size: 200000, cost: { amount: 0.02, currency: "USD" } }), {
    kind: "context-usage",
    used: 13943,
    size: 200000,
    cost: { amount: 0.02, currency: "USD" },
  });
  assert.deepEqual(classifyUpdate({ sessionUpdate: "usage_update", used: 10, size: 100, cost: { amount: "x" } }), { kind: "context-usage", used: 10, size: 100 });
});

test("parsePromptUsage reads the session/prompt response's usage (opencode's shape)", () => {
  assert.deepEqual(
    parsePromptUsage({ stopReason: "end_turn", usage: { inputTokens: 119, outputTokens: 12, totalTokens: 13979, thoughtTokens: 24, cachedReadTokens: 13824 } }),
    { inputTokens: 119, outputTokens: 12, totalTokens: 13979, thoughtTokens: 24, cachedReadTokens: 13824 },
  );
  assert.equal(parsePromptUsage({ stopReason: "end_turn" }), undefined);
  assert.equal(parsePromptUsage({ stopReason: "end_turn", usage: { inputTokens: 1 } }), undefined);
  assert.deepEqual(parsePromptUsage({ usage: { inputTokens: 1, outputTokens: 2, thoughtTokens: -3 } }), { inputTokens: 1, outputTokens: 2 });
});

test("usage parsing rejects integers outside the safe range (they must never reach the session log)", () => {
  // A token count above Number.MAX_SAFE_INTEGER would pass `Number.isInteger` yet
  // fail `parseSessionEvent`'s safe-integer check on replay — the log would persist
  // an event it can never read back, making the session history unreadable. The
  // boundary must be discarded here, at ingestion.
  const unsafe = Number.MAX_SAFE_INTEGER + 1; // 9007199254740992 — an integer, but not a *safe* one.
  assert.equal(Number.isInteger(unsafe), true, "precondition: the test value is a plain integer");
  assert.equal(Number.isSafeInteger(unsafe), false, "precondition: the test value is not safe");

  // Required prompt-usage fields: any unsafe count poisons the whole usage report.
  assert.equal(parsePromptUsage({ usage: { inputTokens: unsafe, outputTokens: 2 } }), undefined);
  assert.equal(parsePromptUsage({ usage: { inputTokens: 1, outputTokens: unsafe } }), undefined);
  // Optional fields: an unsafe optional count is dropped, the safe rest is kept.
  for (const k of ["totalTokens", "thoughtTokens", "cachedReadTokens", "cachedWriteTokens"]) {
    assert.deepEqual(parsePromptUsage({ usage: { inputTokens: 1, outputTokens: 2, [k]: unsafe } }), { inputTokens: 1, outputTokens: 2 });
  }
  // The safe boundary itself is still accepted.
  assert.deepEqual(parsePromptUsage({ usage: { inputTokens: Number.MAX_SAFE_INTEGER, outputTokens: 2 } }), {
    inputTokens: Number.MAX_SAFE_INTEGER,
    outputTokens: 2,
  });

  // usage_update occupancy follows the same rule: unsafe used/size is ignored, not classified.
  assert.equal(classifyUpdate({ sessionUpdate: "usage_update", used: unsafe, size: 100 }).kind, "ignored");
  assert.equal(classifyUpdate({ sessionUpdate: "usage_update", used: 10, size: unsafe }).kind, "ignored");
  assert.deepEqual(classifyUpdate({ sessionUpdate: "usage_update", used: Number.MAX_SAFE_INTEGER, size: 100 }), {
    kind: "context-usage",
    used: Number.MAX_SAFE_INTEGER,
    size: 100,
  });
});

test("ACP_FIDELITY_GAPS documents the canonical concepts ACP cannot reconstruct", () => {
  assert.ok(ACP_FIDELITY_GAPS.length > 0);
  const blob = ACP_FIDELITY_GAPS.map((gap) => `${gap.concept} ${gap.detail}`).join(" ").toLowerCase();
  // The canonical event types ACP has no source for must each be accounted for.
  for (const missing of ["usage", "compaction", "turn", "continuation", "model"]) {
    assert.ok(blob.includes(missing), `fidelity gaps should mention "${missing}"`);
  }
});
