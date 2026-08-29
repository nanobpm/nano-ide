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
  optionKindAllows,
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

test("vocab maps are null-prototype so inherited keys never leak into `in` / Object.keys", () => {
  // A prototype-bearing vocab (`Object.assign({}, …)`) makes `"toString" in vocab` true and surfaces
  // inherited Object.prototype keys to any consumer doing `kind in vocab` / `Object.keys(vocab)`,
  // classifying a hostile `kind` off the prototype chain. Both the core vocab AND every merge result
  // must be null-prototype so only OWN kinds exist — this guards the whole class, not one bad key.
  const merged = mergeTranscriptVocab(CORE_TRANSCRIPT_VOCAB, {
    custom: (_body, offset) => ({ kind: "step", offset }),
  });
  const vocabs: readonly (readonly [string, TranscriptVocab])[] = [
    ["core", CORE_TRANSCRIPT_VOCAB],
    ["merged", merged],
  ];
  for (const [name, vocab] of vocabs) {
    assert.equal(Object.getPrototypeOf(vocab), null, `${name} vocab must have a null prototype`);
    for (const inherited of ["toString", "constructor", "hasOwnProperty", "valueOf", "__proto__"]) {
      assert.equal(inherited in vocab, false, `${name} vocab must not expose inherited key ${inherited}`);
    }
  }
});

test("EXTENSION POINT: a downstream app registers a brand-new kind via mergeTranscriptVocab", () => {
  // An app adds an app-specific kind + parse handler WITHOUT editing this package. The synthetic
  // extra kind is decoded (here into a message the core fold understands) and parses through the one
  // parser; the core vocab stays untouched. (`permission` itself is now a first-class core kind — see
  // the dedicated permission tests below — so this uses a genuinely non-core kind.)
  const appVocab: TranscriptVocab = mergeTranscriptVocab(CORE_TRANSCRIPT_VOCAB, {
    annotation: (body, offset) => {
      const noteId = typeof body.noteId === "string" ? body.noteId : undefined;
      if (noteId === undefined) return undefined; // reject malformed → raw fallback
      const pinned = body.pinned === true;
      return { kind: "message", offset, role: "system", text: `annotation(${noteId}):${pinned ? "pinned" : "loose"}` };
    },
  });

  const pinned = parseTranscriptEvent({ offset: 10, chunk: env("annotation", { noteId: "n-1", pinned: true }) }, appVocab);
  assert.deepEqual(pinned, { kind: "message", offset: 10, role: "system", text: "annotation(n-1):pinned" });

  // A malformed extension envelope (missing noteId) still falls back to raw — no throw, no crash.
  assert.equal(
    parseTranscriptEvent({ offset: 11, chunk: env("annotation", { pinned: false }) }, appVocab).kind,
    "stream-chunk",
  );

  // The package's core vocab never learned `annotation` — the extension did not fork or mutate it.
  assert.equal(parseTranscriptEvent({ offset: 10, chunk: env("annotation", { noteId: "n-1", pinned: true }) }).kind, "stream-chunk");
  assert.equal(CORE_TRANSCRIPT_VOCAB.annotation, undefined);
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

test("deriveView: results pair into the correct turn's tool with interleaved, out-of-order calls across turns", () => {
  // Two turns, each with two tools; results arrive interleaved and out of call order. Each result must
  // land on its own call's card in BOTH the flat list and the owning turn — guarding the O(1) position
  // tracking against pairing into the wrong turn/index.
  const view = deriveView([
    { kind: "turn", offset: 0, index: 0 },
    { kind: "tool-call", offset: 1, name: "t0a", callId: "a" },
    { kind: "tool-call", offset: 2, name: "t0b", callId: "b" },
    { kind: "turn", offset: 3, index: 1 },
    { kind: "tool-call", offset: 4, name: "t1c", callId: "c" },
    { kind: "tool-call", offset: 5, name: "t1d", callId: "d" },
    { kind: "tool-result", offset: 6, ok: true, callId: "c", content: "C" },
    { kind: "tool-result", offset: 7, ok: false, callId: "a", content: "A" },
    { kind: "tool-result", offset: 8, ok: true, callId: "d", content: "D" },
    { kind: "tool-result", offset: 9, ok: false, callId: "b", content: "B" },
  ]);
  // Flat list keeps call order, each with its own result.
  assert.deepEqual(
    view.tools.map((t) => [t.name, t.result?.content]),
    [["t0a", "A"], ["t0b", "B"], ["t1c", "C"], ["t1d", "D"]],
  );
  // Each result also lands on the matching card inside its OWN turn (not another turn's).
  assert.deepEqual(
    view.turns[0]?.tools.map((t) => [t.name, t.result?.ok]),
    [["t0a", false], ["t0b", false]],
  );
  assert.deepEqual(
    view.turns[1]?.tools.map((t) => [t.name, t.result?.ok]),
    [["t1c", true], ["t1d", true]],
  );
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

test("core vocab decodes a permission REQUEST with all optional fields", () => {
  const chunk = env("permission", {
    phase: "request",
    callId: "p1",
    policy: "escalate",
    options: [
      { optionId: "o1", name: "Allow once", kind: "allow-once" },
      { optionId: "o2", name: "Reject", kind: "reject-always" },
    ],
    toolName: "bash",
    title: "Run command?",
    reason: "The agent wants to run `rm -rf build`",
  });
  assert.deepEqual(parseTranscriptEvent({ offset: 1, chunk }), {
    kind: "permission",
    phase: "request",
    offset: 1,
    callId: "p1",
    policy: "escalate",
    options: [
      { optionId: "o1", name: "Allow once", kind: "allow-once" },
      { optionId: "o2", name: "Reject", kind: "reject-always" },
    ],
    toolName: "bash",
    title: "Run command?",
    reason: "The agent wants to run `rm -rf build`",
  });
});

test("core vocab decodes a minimal permission REQUEST (no optional fields)", () => {
  const chunk = env("permission", {
    phase: "request",
    callId: "p2",
    policy: "yolo",
    options: [{ optionId: "o1", name: "Allow", kind: "allow-always" }],
  });
  assert.deepEqual(parseTranscriptEvent({ offset: 2, chunk }), {
    kind: "permission",
    phase: "request",
    offset: 2,
    callId: "p2",
    policy: "yolo",
    options: [{ optionId: "o1", name: "Allow", kind: "allow-always" }],
  });
});

test("core vocab decodes a permission RESOLUTION, with and without provenance", () => {
  const withBy = env("permission", { phase: "resolution", callId: "p1", optionId: "o1", allowed: true, by: "operator" });
  assert.deepEqual(parseTranscriptEvent({ offset: 3, chunk: withBy }), {
    kind: "permission",
    phase: "resolution",
    offset: 3,
    callId: "p1",
    optionId: "o1",
    allowed: true,
    by: "operator",
  });
  const noBy = env("permission", { phase: "resolution", callId: "p1", optionId: "o2", allowed: false });
  assert.deepEqual(parseTranscriptEvent({ offset: 4, chunk: noBy }), {
    kind: "permission",
    phase: "resolution",
    offset: 4,
    callId: "p1",
    optionId: "o2",
    allowed: false,
  });
});

test("core vocab: malformed permission envelopes fall back to raw (never a silent mis-decode)", () => {
  const cases: Record<string, Record<string, unknown>> = {
    "missing callId": { phase: "request", policy: "escalate", options: [{ optionId: "o", name: "n", kind: "allow-once" }] },
    "unknown phase": { phase: "maybe", callId: "p" },
    "missing phase": { callId: "p" },
    "bad policy": { phase: "request", callId: "p", policy: "sometimes", options: [{ optionId: "o", name: "n", kind: "allow-once" }] },
    "empty options": { phase: "request", callId: "p", policy: "yolo", options: [] },
    "missing options": { phase: "request", callId: "p", policy: "yolo" },
    "bad option kind": { phase: "request", callId: "p", policy: "yolo", options: [{ optionId: "o", name: "n", kind: "allow-sometimes" }] },
    "option missing name": { phase: "request", callId: "p", policy: "yolo", options: [{ optionId: "o", kind: "allow-once" }] },
    "resolution missing optionId": { phase: "resolution", callId: "p", allowed: true },
    "resolution non-boolean allowed": { phase: "resolution", callId: "p", optionId: "o", allowed: "yes" },
    "resolution bad by (unknown)": { phase: "resolution", callId: "p", optionId: "o", allowed: true, by: "robot" },
    "resolution bad by (non-string)": { phase: "resolution", callId: "p", optionId: "o", allowed: true, by: 7 },
  };
  for (const [label, body] of Object.entries(cases)) {
    assert.equal(
      parseTranscriptEvent({ offset: 0, chunk: env("permission", body) }).kind,
      "stream-chunk",
      `${label} must fall back to a raw stream-chunk`,
    );
  }
});

test("optionKindAllows: allow-* allow, reject-* reject (single source of truth)", () => {
  assert.equal(optionKindAllows("allow-once"), true);
  assert.equal(optionKindAllows("allow-always"), true);
  assert.equal(optionKindAllows("reject-once"), false);
  assert.equal(optionKindAllows("reject-always"), false);
});

test("encodeTranscriptEvent round-trips permission request + resolution through the one parser", () => {
  const events: TranscriptEvent[] = [
    {
      kind: "permission",
      phase: "request",
      offset: 0,
      callId: "p1",
      policy: "escalate",
      options: [{ optionId: "o1", name: "Allow once", kind: "allow-once" }],
      toolName: "bash",
      title: "t",
      reason: "r",
    },
    { kind: "permission", phase: "resolution", offset: 1, callId: "p1", optionId: "o1", allowed: true, by: "auto" },
  ];
  for (const original of events) {
    const chunk = encodeTranscriptEvent(original);
    assert.deepEqual(parseTranscriptEvent({ offset: original.offset, chunk }), original);
  }
});

test("deriveView: pairs a permission request with its resolution by callId (flat + per-turn)", () => {
  const view = deriveView([
    { kind: "turn", offset: 0, index: 0 },
    {
      kind: "permission",
      phase: "request",
      offset: 1,
      callId: "p1",
      policy: "escalate",
      options: [{ optionId: "o1", name: "Allow", kind: "allow-once" }],
      toolName: "bash",
    },
    { kind: "permission", phase: "resolution", offset: 2, callId: "p1", optionId: "o1", allowed: true, by: "operator" },
  ]);
  assert.equal(view.permissions.length, 1);
  assert.deepEqual(view.permissions[0]?.resolved, { allowed: true, optionId: "o1", offset: 2, by: "operator" });
  assert.equal(view.permissions[0]?.toolName, "bash");
  // The same resolved card is paired inside its owning turn.
  assert.equal(view.turns[0]?.permissions.length, 1);
  assert.deepEqual(view.turns[0]?.permissions[0]?.resolved, { allowed: true, optionId: "o1", offset: 2, by: "operator" });
});

test("deriveView: an unresolved permission request stays pending (no resolution)", () => {
  const view = deriveView([
    {
      kind: "permission",
      phase: "request",
      offset: 0,
      callId: "p1",
      policy: "yolo",
      options: [{ optionId: "o1", name: "Allow", kind: "allow-always" }],
    },
  ]);
  assert.equal(view.turns.length, 1); // request opens an implicit turn 0
  assert.equal(view.permissions.length, 1);
  assert.equal(view.permissions[0]?.resolved, undefined);
});

test("deriveView: resolutions pair to the correct request across turns, interleaved and out of order", () => {
  const req = (offset: number, callId: string): TranscriptEvent => ({
    kind: "permission",
    phase: "request",
    offset,
    callId,
    policy: "escalate",
    options: [{ optionId: "o", name: "Allow", kind: "allow-once" }],
  });
  const view = deriveView([
    { kind: "turn", offset: 0, index: 0 },
    req(1, "a"),
    req(2, "b"),
    { kind: "turn", offset: 3, index: 1 },
    req(4, "c"),
    { kind: "permission", phase: "resolution", offset: 5, callId: "c", optionId: "o", allowed: true },
    { kind: "permission", phase: "resolution", offset: 6, callId: "a", optionId: "o", allowed: false },
    { kind: "permission", phase: "resolution", offset: 7, callId: "b", optionId: "o", allowed: true },
  ]);
  assert.deepEqual(
    view.permissions.map((p) => [p.callId, p.resolved?.allowed]),
    [["a", false], ["b", true], ["c", true]],
  );
  assert.deepEqual(
    view.turns[0]?.permissions.map((p) => [p.callId, p.resolved?.allowed]),
    [["a", false], ["b", true]],
  );
  assert.deepEqual(
    view.turns[1]?.permissions.map((p) => [p.callId, p.resolved?.allowed]),
    [["c", true]],
  );
});

test("deriveView: a resolution with no matching open request is ignored (no throw)", () => {
  const view = deriveView([
    { kind: "permission", phase: "resolution", offset: 0, callId: "ghost", optionId: "o", allowed: true },
  ]);
  assert.equal(view.permissions.length, 0);
  assert.equal(view.turns.length, 0); // a lone resolution opens no turn
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