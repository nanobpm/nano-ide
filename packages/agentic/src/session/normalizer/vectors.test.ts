import assert from "node:assert/strict";
import { test } from "node:test";
import { parseSessionEvent, type SessionEvent } from "../events.ts";
import { normalizeSession } from "./link.ts";
import { FLEET_NORMALIZERS } from "./index.ts";
import type { DistributiveOmit, HarnessNormalizer } from "./types.ts";
import { copilotNormalizer } from "./copilot.ts";
import { claudeNormalizer } from "./claude.ts";
import { qwenNormalizer } from "./qwen.ts";
import { kimiNormalizer } from "./kimi.ts";
import { piNormalizer } from "./pi.ts";
import { deepseekNormalizer } from "./deepseek.ts";

/**
 * The shared canonical scenario every dialect must map onto (ADR 0062 slice 3
 * acceptance: "shared normalization test vectors validate every dialect maps
 * onto the same canonical SessionEvent shape"). It is the *semantic* projection —
 * the canonical union payload minus the causal-chain fields (`id`/`parentId`),
 * which the shared linker assigns and a separate test checks. A native transcript
 * from *any* harness in the fleet, when normalized, must equal this exactly.
 */
const CANONICAL: readonly DistributiveOmit<SessionEvent, "id" | "parentId">[] = [
  { type: "user", text: "please refactor the parser" },
  { type: "reasoning", text: "weighing two approaches", providerContinuation: "OPAQUE-CONT" },
  { type: "assistant", text: "here is the plan" },
  { type: "tool-call", callId: "t1", name: "write_file", args: { path: "a.ts" } },
  { type: "tool-result", callId: "t1", ok: true, result: "written" },
  { type: "usage", inputTokens: 100, outputTokens: 50, model: "m-1" },
];

/** One dialect's native transcript that must normalize to {@link CANONICAL}. */
interface Vector {
  readonly normalizer: HarnessNormalizer;
  readonly records: readonly unknown[];
}

const VECTORS: readonly Vector[] = [
  {
    // @github/copilot — copilot-sdk SessionEvent stream. reasoningOpaque is the
    // provider reasoning-continuation blob (ADR 0062 §5 resume-critical fidelity).
    normalizer: copilotNormalizer,
    records: [
      { type: "user_message", text: "please refactor the parser" },
      { type: "reasoning", text: "weighing two approaches", reasoningOpaque: "OPAQUE-CONT" },
      { type: "assistant_message", text: "here is the plan" },
      { type: "tool_call", id: "t1", name: "write_file", arguments: { path: "a.ts" } },
      { type: "tool_result", id: "t1", output: "written" },
      { type: "usage", inputTokens: 100, outputTokens: 50, model: "m-1" },
    ],
  },
  {
    // Claude Code — `-p --output-format stream-json`. thinking.signature is the
    // encrypted reasoning-continuation token; usage rides the terminal `result`.
    normalizer: claudeNormalizer,
    records: [
      { type: "user", message: { role: "user", content: [{ type: "text", text: "please refactor the parser" }] } },
      {
        type: "assistant",
        message: {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "weighing two approaches", signature: "OPAQUE-CONT" },
            { type: "text", text: "here is the plan" },
            { type: "tool_use", id: "t1", name: "write_file", input: { path: "a.ts" } },
          ],
        },
      },
      { type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "written" }] } },
      { type: "result", subtype: "success", model: "m-1", usage: { input_tokens: 100, output_tokens: 50 } },
    ],
  },
  {
    // Qwen Code — `-p -o stream-json` (Gemini-CLI lineage).
    normalizer: qwenNormalizer,
    records: [
      { type: "content", role: "user", text: "please refactor the parser" },
      { type: "thought", description: "weighing two approaches", thoughtSignature: "OPAQUE-CONT" },
      { type: "content", role: "model", text: "here is the plan" },
      { type: "tool_call_request", callId: "t1", name: "write_file", args: { path: "a.ts" } },
      { type: "tool_call_response", callId: "t1", responseParts: "written" },
      { type: "usage_metadata", promptTokenCount: 100, candidatesTokenCount: 50, model: "m-1" },
    ],
  },
  {
    // Kimi — `-p --output-format stream-json` (event/phase discriminated).
    normalizer: kimiNormalizer,
    records: [
      { event: "text", role: "user", text: "please refactor the parser" },
      { event: "reasoning", text: "weighing two approaches", continuation: "OPAQUE-CONT" },
      { event: "text", role: "assistant", text: "here is the plan" },
      { event: "tool", phase: "call", id: "t1", name: "write_file", arguments: { path: "a.ts" } },
      { event: "tool", phase: "result", id: "t1", ok: true, output: "written" },
      { event: "usage", prompt_tokens: 100, completion_tokens: 50, model: "m-1" },
    ],
  },
  {
    // pi / little-coder — `-p --mode json` (JSON-RPC notifications).
    normalizer: piNormalizer,
    records: [
      { jsonrpc: "2.0", method: "session/message", params: { role: "user", text: "please refactor the parser" } },
      { jsonrpc: "2.0", method: "session/reasoning", params: { text: "weighing two approaches", continuation: "OPAQUE-CONT" } },
      { jsonrpc: "2.0", method: "session/message", params: { role: "assistant", text: "here is the plan" } },
      { jsonrpc: "2.0", method: "session/toolCall", params: { id: "t1", name: "write_file", args: { path: "a.ts" } } },
      { jsonrpc: "2.0", method: "session/toolResult", params: { id: "t1", ok: true, result: "written" } },
      { jsonrpc: "2.0", method: "session/usage", params: { inputTokens: 100, outputTokens: 50, model: "m-1" } },
    ],
  },
  {
    // DeepSeek Harness — live SessionEvent feed (kind-tagged).
    normalizer: deepseekNormalizer,
    records: [
      { kind: "message", role: "user", content: "please refactor the parser" },
      { kind: "reasoning", content: "weighing two approaches", continuation: "OPAQUE-CONT" },
      { kind: "message", role: "assistant", content: "here is the plan" },
      { kind: "tool", id: "t1", name: "write_file", arguments: { path: "a.ts" } },
      { kind: "tool_result", id: "t1", ok: true, output: "written" },
      { kind: "usage", input: 100, output: 50, model: "m-1" },
    ],
  },
];

/** Strip the linker-assigned causal-chain fields to get the semantic projection. */
function semantic(event: SessionEvent): DistributiveOmit<SessionEvent, "id" | "parentId"> {
  const { id: _id, parentId: _parentId, ...rest } = event;
  return rest;
}

// Every dialect in the fleet has a vector (no harness ships without a test vector).
assert.equal(VECTORS.length, FLEET_NORMALIZERS.length, "every fleet normalizer must have a shared test vector");

for (const { normalizer, records } of VECTORS) {
  test(`[${normalizer.harness}] native transcript normalizes onto the shared canonical shape`, () => {
    const events = normalizeSession(normalizer, records);
    assert.deepEqual(events.map(semantic), CANONICAL, "dialect must map onto the identical canonical SessionEvent shape");
  });

  test(`[${normalizer.harness}] normalized events form a well-formed causal chain`, () => {
    const events = normalizeSession(normalizer, records);
    assert.equal(events[0].parentId, null, "first event starts a fresh chain");
    const ids = new Set<string>();
    for (let i = 0; i < events.length; i++) {
      assert.equal(typeof events[i].id, "string");
      assert.ok(!ids.has(events[i].id), "ids are unique");
      ids.add(events[i].id);
      if (i > 0) assert.equal(events[i].parentId, events[i - 1].id, "parentId links to the prior event");
      // The whole event re-validates against the slice-1 storage boundary.
      assert.deepEqual(parseSessionEvent(events[i]), events[i]);
    }
  });

  test(`[${normalizer.harness}] preserves the resume-critical provider reasoning continuation`, () => {
    const events = normalizeSession(normalizer, records);
    const reasoning = events.find((e) => e.type === "reasoning");
    assert.ok(reasoning && reasoning.type === "reasoning");
    assert.equal(reasoning.providerContinuation, "OPAQUE-CONT", "the opaque reasoning blob must survive normalization");
  });
}

test("a resume continues the same causal chain across the boundary", () => {
  // First leg produces a chain; the resumed leg is threaded onto the last id, so
  // offset-free causality is preserved across the resume (parentId, not offset).
  const first = normalizeSession(copilotNormalizer, [
    { type: "user_message", text: "hi" },
    { type: "assistant_message", text: "hello" },
  ]);
  const lastId = first[first.length - 1].id;
  const resumed = normalizeSession(
    copilotNormalizer,
    [{ type: "user_message", text: "continue" }],
    { parentId: lastId, newId: (() => { let n = 0; return () => `r-${n++}`; })() },
  );
  assert.equal(resumed[0].parentId, lastId, "the resumed transcript continues the pre-resume chain");
});
