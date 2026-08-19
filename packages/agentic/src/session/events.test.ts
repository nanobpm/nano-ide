import assert from "node:assert/strict";
import { test } from "node:test";
import {
  parseSessionEvent,
  SESSION_EVENT_TYPES,
  type SessionEvent,
  SessionEventShapeError,
} from "./events.ts";

/** Build a runtime value from untyped JSON (never an `as`-cast — see AGENTS.md). */
function fromJson(json: string): unknown {
  return JSON.parse(json);
}

const sample: readonly SessionEvent[] = [
  { type: "system", id: "s0", parentId: null, text: "you are nano" },
  { type: "user", id: "u1", parentId: "s0", text: "hi" },
  { type: "assistant", id: "a2", parentId: "u1", text: "hello" },
  { type: "reasoning", id: "r3", parentId: "u1", text: "thinking", providerContinuation: "OPAQUE==" },
  { type: "reasoning", id: "r3b", parentId: "u1" },
  { type: "tool-call", id: "tc4", parentId: "a2", callId: "c1", name: "read", args: { path: "/x" } },
  { type: "tool-result", id: "tr5", parentId: "tc4", callId: "c1", ok: true, result: { bytes: 12 } },
  { type: "tool-result", id: "tr5b", parentId: "tc4", callId: "c2", ok: false, result: "boom" },
  { type: "compaction", id: "cp6", parentId: "a2", reason: "compaction", replacesFrom: 0, replacesTo: 3, summary: "…" },
  { type: "compaction", id: "cp6b", parentId: "a2", reason: "truncation", replacesFrom: 4, replacesTo: 6 },
  { type: "usage", id: "us7", parentId: "a2", inputTokens: 100, outputTokens: 42, model: "opus" },
  { type: "usage", id: "us7b", parentId: "a2", inputTokens: 1, outputTokens: 2 },
  { type: "turn-start", id: "ts8", parentId: null, turn: 1 },
  { type: "turn-end", id: "te9", parentId: "ts8", turn: 1 },
];

test("every SessionEvent variant round-trips through JSON + parseSessionEvent unchanged", () => {
  for (const event of sample) {
    const restored = parseSessionEvent(fromJson(JSON.stringify(event)));
    assert.deepEqual(restored, event, `variant ${event.type} (${event.id}) must round-trip`);
  }
});

test("the sample corpus covers every declared SessionEventType", () => {
  const covered = new Set(sample.map((e) => e.type));
  for (const type of SESSION_EVENT_TYPES) {
    assert.ok(covered.has(type), `missing round-trip coverage for event type "${type}"`);
  }
});

test("parseSessionEvent rejects an unknown event type", () => {
  assert.throws(() => parseSessionEvent(fromJson('{"type":"bogus","id":"x","parentId":null}')), SessionEventShapeError);
});

test("parseSessionEvent rejects a missing required field", () => {
  assert.throws(() => parseSessionEvent(fromJson('{"type":"user","id":"u","parentId":null}')), SessionEventShapeError);
});

test("parseSessionEvent rejects a malformed parentId", () => {
  assert.throws(
    () => parseSessionEvent(fromJson('{"type":"system","id":"s","parentId":7,"text":"x"}')),
    SessionEventShapeError,
  );
});

test("parseSessionEvent rejects a compaction with an invalid reason", () => {
  assert.throws(
    () =>
      parseSessionEvent(
        fromJson('{"type":"compaction","id":"c","parentId":null,"reason":"nope","replacesFrom":0,"replacesTo":1}'),
      ),
    SessionEventShapeError,
  );
});

test("parseSessionEvent rejects a non-object", () => {
  assert.throws(() => parseSessionEvent(fromJson("42")), SessionEventShapeError);
});
