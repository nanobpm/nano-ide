// Unit tests for the typed transcript-event vocabulary + the single derive() fold (#251).
//
// Pins: the ONE parser classifies raw bytes vs typed envelopes (raw fidelity preserved), the core
// vocabulary decodes each kind, merge-extensibility adds/overrides kinds without a second parser
// (including the downstream `permission` extension point), encode↔parse round-trips, and deriveView
// folds the log into per-turn structure / message history / tool cards / raw-byte accounting /
// lifecycle — "the log IS the state".
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CORE_TRANSCRIPT_EVENT_KINDS,
  CORE_TRANSCRIPT_VOCAB,
  deriveView,
  deriveViewFromChunks,
  encodeTranscriptEvent,
  mergeTranscriptVocab,
  parseTranscriptEvent,
  type TranscriptEvent,
  type TranscriptVocab,
  TRANSCRIPT_EVENT_MARKER,
  TRANSCRIPT_EVENT_VERSION,
  utf8ByteLength,
} from "./events.ts";

function env(kind: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ [TRANSCRIPT_EVENT_MARKER]: TRANSCRIPT_EVENT_VERSION, kind, ...extra });
}

test("marker + version constants are the canonical values (single source of truth)", () => {
  assert.equal(TRANSCRIPT_EVENT_MARKER, "nwfTranscriptEvent");
  assert.equal(TRANSCRIPT_EVENT_VERSION, 1);
});

test("utf8ByteLength counts UTF-8 bytes without depending on Buffer", () => {
  assert.equal(utf8ByteLength("abc"), 3);
  assert.equal(utf8ByteLength("é"), 2);
  assert.equal(utf8ByteLength("😀"), 4);
  assert.equal(utf8ByteLength(""), 0);
});

test("parseTranscriptEvent: raw terminal bytes are retained verbatim as a stream-chunk", () => {
  const event = parseTranscriptEvent({ offset: 3, chunk: "\u001b[32mok\u001b[0m\r\n" });
  assert.deepEqual(event, { kind: "stream-chunk", offset: 3, chunk: "\u001b[32mok\u001b[0m\r\n" });
});

test("parseTranscriptEvent: JSON without the marker is NOT mis-classified — stays a raw chunk", () => {
  const chunk = JSON.stringify({ kind: "message", text: "hi" }); // no marker → raw
  const event = parseTranscriptEvent({ offset: 0, chunk });
  assert.equal(event.kind, "stream-chunk");
});

test("parseTranscriptEvent: a marker envelope with an unknown kind falls back to raw", () => {
  const event = parseTranscriptEvent({ offset: 0, chunk: env("no-such-kind", { foo: 1 }) });
  assert.equal(event.kind, "stream-chunk");
});

test("parseTranscriptEvent: malformed JSON carrying the marker text falls back to raw", () => {
  const event = parseTranscriptEvent({ offset: 0, chunk: `{"${TRANSCRIPT_EVENT_MARKER}":1, broken` });
  assert.equal(event.kind, "stream-chunk");
});

test("parseTranscriptEvent: a marker at the wrong version falls back to raw", () => {
  const chunk = JSON.stringify({ [TRANSCRIPT_EVENT_MARKER]: 999, kind: "message", text: "hi" });
  assert.equal(parseTranscriptEvent({ offset: 0, chunk }).kind, "stream-chunk");
});

test("parseTranscriptEvent: an inherited-property kind never resolves a prototype decoder", () => {
  // A hostile chunk whose `kind` names an Object.prototype member ("constructor", "toString",
  // "__proto__", …) must NOT resolve `vocab[kind]` up the prototype chain to a non-decoder
  // function and call it — that either throws (DoS) or returns a non-TranscriptEvent value. The
  // vocab is a plain map, so only OWN kinds decode; every prototype key falls back to raw.
  for (const kind of ["constructor", "toString", "hasOwnProperty", "valueOf", "__proto__"]) {
    const event = parseTranscriptEvent({ offset: 0, chunk: env(kind, { foo: 1 }) });
    assert.equal(event.kind, "stream-chunk", `kind=${kind} must fall back to a raw stream-chunk`);
  }
});

test("core vocab decodes message with role (default assistant)", () => {
  assert.deepEqual(parseTranscriptEvent({ offset: 1, chunk: env("message", { text: "hello" }) }), {
    kind: "message",
    offset: 1,
    role: "assistant",
    text: "hello",
  });
  assert.deepEqual(parseTranscriptEvent({ offset: 2, chunk: env("message", { role: "user", text: "hi" }) }), {
    kind: "message",
    offset: 2,
    role: "user",
    text: "hi",
  });
});

test("core vocab: a message envelope missing text is rejected → raw fallback", () => {
  assert.equal(parseTranscriptEvent({ offset: 0, chunk: env("message", { role: "user" }) }).kind, "stream-chunk");
});

test("core vocab decodes tool-call / tool-result / turn / step / lifecycle", () => {
  assert.deepEqual(parseTranscriptEvent({ offset: 1, chunk: env("tool-call", { name: "grep", callId: "c1", args: { q: "x" } }) }), {
    kind: "tool-call",
    offset: 1,
    name: "grep",
    callId: "c1",
    args: { q: "x" },
  });
  assert.deepEqual(parseTranscriptEvent({ offset: 2, chunk: env("tool-result", { callId: "c1", ok: true, content: "found" }) }), {
    kind: "tool-result",
    offset: 2,
    ok: true,
    callId: "c1",
    content: "found",
  });
  assert.deepEqual(parseTranscriptEvent({ offset: 3, chunk: env("turn", { index: 4 }) }), { kind: "turn", offset: 3, index: 4 });
  assert.deepEqual(parseTranscriptEvent({ offset: 4, chunk: env("step", { label: "loop" }) }), { kind: "step", offset: 4, label: "loop" });
  assert.deepEqual(parseTranscriptEvent({ offset: 5, chunk: env("lifecycle", { phase: "completed" }) }), {
    kind: "lifecycle",
    offset: 5,
    phase: "completed",
  });
});

test("mergeTranscriptVocab: adds a new kind without forking the parser, and can override a core one", () => {
  const vocab = mergeTranscriptVocab(CORE_TRANSCRIPT_VOCAB, {
    // A brand new merge-extensible kind, decoded into a message so deriveView still folds it.
    reasoning: (body, offset) => ({ kind: "message", offset, role: "system", text: String(body.text ?? "") }),
  });
  const event = parseTranscriptEvent({ offset: 7, chunk: env("reasoning", { text: "thinking" }) }, vocab);
  assert.deepEqual(event, { kind: "message", offset: 7, role: "system", text: "thinking" });
  // The core vocab is unchanged (merge returns a new object).
  assert.equal(parseTranscriptEvent({ offset: 7, chunk: env("reasoning", { text: "thinking" }) }).kind, "stream-chunk");
});

test("EXTENSION POINT: a downstream app registers its own `permission` kind via mergeTranscriptVocab", () => {
  // Mirrors nano-workforce#559: an app adds a `permission` kind + parse handler WITHOUT editing this
  // package. The synthetic extra kind is decoded (here into a message the core fold understands) and
  // parses through the one parser; the core vocab stays untouched.
  const appVocab: TranscriptVocab = mergeTranscriptVocab(CORE_TRANSCRIPT_VOCAB, {
    permission: (body, offset) => {
      const requestId = typeof body.requestId === "string" ? body.requestId : undefined;
      if (requestId === undefined) return undefined; // reject malformed → raw fallback
      const granted = body.granted === true;
      return { kind: "message", offset, role: "system", text: `permission(${requestId}):${granted ? "granted" : "denied"}` };
    },
  });

  const granted = parseTranscriptEvent({ offset: 10, chunk: env("permission", { requestId: "req-1", granted: true }) }, appVocab);
  assert.deepEqual(granted, { kind: "message", offset: 10, role: "system", text: "permission(req-1):granted" });

  // A malformed extension envelope (missing requestId) still falls back to raw — no throw, no crash.
  assert.equal(
    parseTranscriptEvent({ offset: 11, chunk: env("permission", { granted: false }) }, appVocab).kind,
    "stream-chunk",
  );

  // The package's core vocab never learned `permission` — the extension did not fork or mutate it.
  assert.equal(parseTranscriptEvent({ offset: 10, chunk: env("permission", { requestId: "req-1", granted: true }) }).kind, "stream-chunk");
  assert.equal(CORE_TRANSCRIPT_VOCAB.permission, undefined);
});

test("encodeTranscriptEvent round-trips every non-raw kind through the one parser", () => {
  const events: TranscriptEvent[] = [
    { kind: "message", offset: 0, role: "assistant", text: "hi" },
    { kind: "tool-call", offset: 1, name: "ls", callId: "c1" },
    { kind: "tool-result", offset: 2, ok: false, callId: "c1", content: "boom" },
    { kind: "turn", offset: 3, index: 1 },
    { kind: "step", offset: 4, label: "s" },
    { kind: "lifecycle", offset: 5, phase: "exited" },
  ];
  for (const original of events) {
    const chunk = encodeTranscriptEvent(original);
    assert.deepEqual(parseTranscriptEvent({ offset: original.offset, chunk }), original);
  }
});

test("encodeTranscriptEvent returns raw bytes verbatim for a stream-chunk", () => {
  assert.equal(encodeTranscriptEvent({ kind: "stream-chunk", offset: 0, chunk: "raw" }), "raw");
});

test("deriveView: folds messages + tool cards into per-turn structure with lifecycle", () => {
  const events: TranscriptEvent[] = [
    { kind: "turn", offset: 0, index: 0 },
    { kind: "message", offset: 1, role: "user", text: "do it" },
    { kind: "step", offset: 2 },
    { kind: "tool-call", offset: 3, name: "grep", callId: "c1" },
    { kind: "tool-result", offset: 4, ok: true, callId: "c1", content: "hit" },
    { kind: "message", offset: 5, role: "assistant", text: "done" },
    { kind: "turn", offset: 6, index: 1 },
    { kind: "message", offset: 7, role: "assistant", text: "next" },
    { kind: "stream-chunk", offset: 8, chunk: "raw-bytes" },
    { kind: "lifecycle", offset: 9, phase: "completed" },
  ];
  const view = deriveView(events);
  assert.equal(view.turns.length, 2);
  assert.deepEqual(view.turns[0]?.messages.map((m) => m.text), ["do it", "done"]);
  assert.equal(view.turns[0]?.steps, 1);
  assert.equal(view.turns[0]?.tools.length, 1);
  assert.deepEqual(view.turns[0]?.tools[0]?.result, { ok: true, offset: 4, content: "hit" });
  assert.deepEqual(view.turns[1]?.messages.map((m) => m.text), ["next"]);
  assert.equal(view.messages.length, 3);
  assert.equal(view.tools.length, 1);
  assert.equal(view.lifecycle, "completed");
  assert.equal(view.rawChunkCount, 1);
  assert.equal(view.rawByteLength, utf8ByteLength("raw-bytes"));
  assert.equal(view.eventCount, 10);
});

test("deriveView: content before any turn event opens an implicit turn 0", () => {
  const view = deriveView([
    { kind: "message", offset: 0, role: "assistant", text: "hello" },
    { kind: "tool-call", offset: 1, name: "ls" },
  ]);
  assert.equal(view.turns.length, 1);
  assert.equal(view.turns[0]?.index, 0);
  assert.equal(view.turns[0]?.messages.length, 1);
  assert.equal(view.turns[0]?.tools.length, 1);
});

test("deriveView: an anonymous tool-result pairs with the most recent open anonymous call", () => {
  const view = deriveView([
    { kind: "tool-call", offset: 0, name: "a" },
    { kind: "tool-result", offset: 1, ok: false, content: "nope" },
  ]);
  assert.deepEqual(view.tools[0]?.result, { ok: false, offset: 1, content: "nope" });
});

test("deriveViewFromChunks: an all-raw log derives no structure but full raw fidelity accounting", () => {
  const view = deriveViewFromChunks([
    { offset: 0, chunk: "line-1\n" },
    { offset: 1, chunk: "line-2\n" },
  ]);
  assert.equal(view.turns.length, 0);
  assert.equal(view.messages.length, 0);
  assert.equal(view.rawChunkCount, 2);
  assert.ok(view.rawByteLength > 0);
});

test("deriveViewFromChunks: a mixed log derives typed structure while retaining raw chunks", () => {
  const view = deriveViewFromChunks([
    { offset: 0, chunk: env("turn", { index: 0 }) },
    { offset: 1, chunk: "\u001b[2Jraw frame" },
    { offset: 2, chunk: env("message", { role: "assistant", text: "hi" }) },
  ]);
  assert.equal(view.turns.length, 1);
  assert.deepEqual(view.messages.map((m) => m.text), ["hi"]);
  assert.equal(view.rawChunkCount, 1);
});

test("ONE-PARSER guard: every declared core kind is handled by the single parseTranscriptEvent fold", () => {
  // Port of the app-side drift guard: there is exactly one fold, and it decodes every core kind. If a
  // kind were added to the union but not to CORE_TRANSCRIPT_VOCAB (or vice versa), this fails — no
  // second parser and no undecoded kind can creep in.
  const vocabKinds = Object.keys(CORE_TRANSCRIPT_VOCAB).sort();
  assert.deepEqual(vocabKinds, [...CORE_TRANSCRIPT_EVENT_KINDS].sort());
  for (const kind of CORE_TRANSCRIPT_EVENT_KINDS) {
    assert.equal(typeof CORE_TRANSCRIPT_VOCAB[kind], "function", `core kind ${kind} must be handled by the one parser`);
  }
});
