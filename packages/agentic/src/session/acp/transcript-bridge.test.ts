import { test } from "node:test";
import assert from "node:assert/strict";
import { ACP_TRANSCRIPT_VECTORS } from "../../protocol/conformance/transcript.ts";
import { deriveView, parseTranscriptEvent } from "../../transcript/events.ts";
import { acpUpdateToTranscriptChunk } from "./transcript-bridge.ts";

// --- Red: the drift the issue documents (the old harness envelope shape). ------------------------
//
// The c8ctl-nano harness historically emitted `{ "type": "nwfTranscriptEvent", "v": 1, … }` — the
// marker as a *value* under `type`, not as the `nwfTranscriptEvent` KEY the one parser looks for. So
// `parseTranscriptEvent` never matched the marker and fell back to a raw `stream-chunk`, and the
// cockpit rendered "No structured events derived — raw replay only". This test PROVES that failure
// mode against the shipped parser, so the green case below is a real fix, not a tautology.

test("RED: a real harness-shaped {type,v,…} envelope derives raw-only (the documented drift)", () => {
  const harnessEnvelopes = [
    JSON.stringify({ type: "nwfTranscriptEvent", v: 1, kind: "message", role: "agent", text: "Hello, world." }),
    JSON.stringify({ type: "nwfTranscriptEvent", v: 1, kind: "thought", text: "Let me think." }),
    JSON.stringify({ type: "nwfTranscriptEvent", v: 1, kind: "tool_call", tool: { id: "call-1", title: "read_file", status: "pending" } }),
  ];
  const events = harnessEnvelopes.map((chunk, offset) => parseTranscriptEvent({ offset, chunk }));

  // Every harness envelope falls back to raw — 0 structured events derived.
  for (const event of events) {
    assert.equal(event.kind, "stream-chunk", "harness-shaped envelope must fall back to raw stream-chunk");
  }
  const view = deriveView(events);
  assert.equal(view.messages.length, 0, "raw-only: no structured messages");
  assert.equal(view.tools.length, 0, "raw-only: no structured tool cards");
  assert.equal(view.rawChunkCount, harnessEnvelopes.length, "raw-only: all chunks retained as raw");
});

// --- Green: the canonical bridge makes an ACP update derive to structured events. ----------------

test("GREEN: the canonical bridge turns ACP updates into non-raw structured events", () => {
  const messageUpdate = { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Hello, world." } };
  const chunk = acpUpdateToTranscriptChunk(messageUpdate);
  assert.ok(chunk !== null, "an agent_message_chunk must produce a chunk");

  const event = parseTranscriptEvent({ offset: 0, chunk });
  assert.notEqual(event.kind, "stream-chunk", "the bridge output must NOT fall back to raw");
  assert.equal(event.kind, "message");

  const view = deriveView([event]);
  assert.equal(view.messages.length, 1, "the bridged chunk folds into a structured message");
  assert.equal(view.messages[0]?.text, "Hello, world.");
  assert.equal(view.rawChunkCount, 0, "no raw fallback");
});

// --- Conformance vectors: exact bytes + round-trip to non-raw for every core kind. ---------------

for (const vector of ACP_TRANSCRIPT_VECTORS) {
  test(`bridge emits the exact golden chunk: ${vector.name}`, () => {
    assert.equal(acpUpdateToTranscriptChunk(vector.update), vector.chunk);
  });

  test(`bridge round-trips through parse/derive: ${vector.name}`, () => {
    const chunk = acpUpdateToTranscriptChunk(vector.update);

    if (vector.chunk === null) {
      // An `ignored` ACP update (e.g. `plan`) emits no chunk at all.
      assert.equal(chunk, null, `${vector.sessionUpdate} must be ignored (null chunk)`);
      assert.equal(vector.event, null);
      return;
    }

    assert.ok(chunk !== null, `${vector.sessionUpdate} must produce a chunk`);
    const event = parseTranscriptEvent({ offset: vector.offset, chunk });

    // NOT a raw fallback, and byte-for-byte the pinned typed event.
    assert.notEqual(event.kind, "stream-chunk", `${vector.sessionUpdate} must NOT derive raw`);
    assert.deepEqual(event, vector.event);

    // …and it folds into a message or tool card (never leaves the derived view empty). A tool-result
    // only becomes a card once paired to its open call, so seed the matching tool-call first.
    const seed = event.kind === "tool-result" && event.callId !== undefined
      ? [parseTranscriptEvent({ offset: -1, chunk: acpUpdateToTranscriptChunk({ sessionUpdate: "tool_call", toolCallId: event.callId, title: "seed" }) ?? "" })]
      : [];
    const view = deriveView([...seed, event]);
    const derivedCards = view.messages.length + view.tools.length;
    assert.ok(derivedCards >= 1, `${vector.sessionUpdate} must fold into a message/tool card`);
    assert.equal(view.rawChunkCount, 0, `${vector.sessionUpdate} must not retain a raw chunk`);
  });
}

// --- Totality guard: a JSON.stringify-hostile tool result must NOT abort the stream. --------------
//
// `acpUpdateToTranscriptChunk` is documented "pure and total": every input yields a chunk or `null`,
// never a throw. A tool-result's `result` is opaque wire data, so a value `JSON.stringify` rejects (a
// `BigInt`, a circular reference, a `toJSON` that throws) must not crash a producer/ingestion stream
// for one bad tool result. This pins that the bad value falls back to `String(result)` and still
// derives a tool card, rather than propagating the `TypeError`.

test("TOTAL: a JSON.stringify-hostile tool result falls back to a string instead of throwing", () => {
  const circular: { self?: unknown } = {};
  circular.self = circular;
  const hostileResults: readonly unknown[] = [
    9007199254740993n, // BigInt — JSON.stringify throws a TypeError
    circular, // circular reference — JSON.stringify throws a TypeError
    { toJSON() { throw new Error("boom"); } }, // a toJSON that throws
  ];

  for (const rawOutput of hostileResults) {
    const update = { sessionUpdate: "tool_call_update", toolCallId: "call-hostile", status: "completed", rawOutput };
    let chunk: string | null = null;
    assert.doesNotThrow(() => { chunk = acpUpdateToTranscriptChunk(update); }, "the bridge must never throw on a bad tool result");
    assert.ok(chunk !== null, "a terminal tool_call_update must still produce a chunk");

    const event = parseTranscriptEvent({ offset: 0, chunk: chunk ?? "" });
    assert.equal(event.kind, "tool-result", "the hostile result still derives a structured tool-result");
    if (event.kind !== "tool-result") continue;
    assert.equal(typeof event.content, "string", "content falls back to a string representation");
  }
});

// --- Drift guard: the whole vector set derives to non-raw for every core ACP update kind. ---------

test("DRIFT GUARD: every non-ignored ACP update kind round-trips to a non-raw typed event", () => {
  const REQUIRED_KINDS = [
    "agent_message_chunk",
    "agent_thought_chunk",
    "user_message_chunk",
    "tool_call",
    "tool_call_update",
    "plan",
  ];
  const covered = new Set(ACP_TRANSCRIPT_VECTORS.map((v) => v.sessionUpdate));
  for (const kind of REQUIRED_KINDS) {
    assert.ok(covered.has(kind), `conformance vectors must cover ACP update kind: ${kind}`);
  }

  // Fold the whole non-ignored corpus in one pass: it must derive structured events, zero raw.
  const events = ACP_TRANSCRIPT_VECTORS.flatMap((vector, offset) => {
    const chunk = acpUpdateToTranscriptChunk(vector.update);
    return chunk === null ? [] : [parseTranscriptEvent({ offset, chunk })];
  });
  for (const event of events) {
    assert.notEqual(event.kind, "stream-chunk", "no bridged event may fall back to raw");
  }
  const view = deriveView(events);
  assert.equal(view.rawChunkCount, 0, "the bridged corpus retains zero raw chunks");
  assert.ok(view.messages.length >= 3, "the corpus derives the three message kinds");
  assert.ok(view.tools.length >= 1, "the corpus derives at least one tool card");
});
