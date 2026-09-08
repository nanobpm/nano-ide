// Unit tests for the ordered display derivation (#566) — the projection that coalesces transport-
// fragmented message deltas back into logical blocks and interleaves them chronologically with tool
// cards and permission prompts, WITHOUT touching the raw log or its byte-faithful replay.
//
// Red-first: these pin the acceptance criteria of the issue — one-card-per-delta fragmentation
// reconstructs into a single exact block; distinct same-role messages stay distinct; tools/permissions
// stay chronologically positioned; snapshots replace while deltas append; Unicode survives byte-for-byte;
// replay/pagination/duplicate offsets never double text; and a retention gap stays visible.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createDisplayProjection,
  deriveDisplay,
  type DisplayBlock,
  type DisplayTextBlock,
  type DisplayToolBlock,
  type DisplayPermissionBlock,
  deriveView,
  encodeTranscriptEvent,
  type MessageEvent,
  type MessageMode,
  parseTranscriptEvent,
  type TranscriptEvent,
  type TranscriptRole,
} from "./index.ts";

/** A `message` delta event at `offset` with optional display metadata (no `as` cast — the returned
 *  object is a genuine {@link MessageEvent}). `extra` carries only the keys the caller passes. */
function msg(
  offset: number,
  text: string,
  extra: { role?: TranscriptRole; messageId?: string; mode?: MessageMode; start?: boolean; final?: boolean } = {},
): MessageEvent {
  const { role = "assistant", ...meta } = extra;
  return { kind: "message", offset, role, text, ...meta };
}

function textBlocks(blocks: readonly DisplayBlock[]): DisplayTextBlock[] {
  const out: DisplayTextBlock[] = [];
  for (const b of blocks) if (b.kind === "text") out.push(b);
  return out;
}

/** Narrow-or-throw guards (no `as` casts): assert the kind and return the narrowed block. */
function asText(block: DisplayBlock): DisplayTextBlock {
  if (block.kind !== "text") throw new Error(`expected text block, got ${block.kind}`);
  return block;
}
function asTool(block: DisplayBlock): DisplayToolBlock {
  if (block.kind !== "tool") throw new Error(`expected tool block, got ${block.kind}`);
  return block;
}
function asPermission(block: DisplayBlock): DisplayPermissionBlock {
  if (block.kind !== "permission") throw new Error(`expected permission block, got ${block.kind}`);
  return block;
}

test("red-first fragmentation: adjacent same-speaker deltas reconstruct into ONE exact block", () => {
  // The issue's motivating example: "I", "not", "ice I am act", "ive" arrive as separate transport
  // deltas but are one logical assistant message. deriveView emits one DerivedMessage per event (the
  // bug the display projection fixes); deriveDisplay coalesces them into a single block.
  const events = [msg(0, "I"), msg(1, "not"), msg(2, "ice I am act"), msg(3, "ive")];

  // deriveView still fragments (unchanged event-count semantics).
  assert.equal(deriveView(events).messages.length, 4);

  const blocks = deriveDisplay(events);
  assert.equal(blocks.length, 1);
  const block = asText(blocks[0]);
  assert.equal(block.text, "Inotice I am active"); // concatenated exactly, no injected spaces
  assert.equal(block.role, "assistant");
  assert.equal(block.startOffset, 0);
  assert.equal(block.endOffset, 3);
});

test("exact concatenation preserves Unicode, code and paragraph formatting byte-for-byte", () => {
  const parts = ["```ts\n", "const x = ", "'😀'", ";\n```", "\n\npara2 — café"];
  const events = parts.map((t, i) => msg(i, t));
  assert.equal(asText(deriveDisplay(events)[0]).text, parts.join(""));
});

test("a changed messageId keeps distinct same-role messages distinct", () => {
  const events = [
    msg(0, "first", { messageId: "m1" }),
    msg(1, " more", { messageId: "m1" }),
    msg(2, "second", { messageId: "m2" }),
  ];
  const blocks = textBlocks(deriveDisplay(events));
  assert.equal(blocks.length, 2);
  assert.equal(blocks[0].text, "first more");
  assert.equal(blocks[0].messageId, "m1");
  assert.equal(blocks[1].text, "second");
  assert.equal(blocks[1].messageId, "m2");
});

test("an explicit `start` boundary opens a new block even without an id change", () => {
  const events = [msg(0, "a"), msg(1, "b"), msg(2, "c", { start: true }), msg(3, "d")];
  assert.deepEqual(
    textBlocks(deriveDisplay(events)).map((b) => b.text),
    ["ab", "cd"],
  );
});

test("an explicit `final` closes the block so later same-speaker text starts fresh", () => {
  const events = [msg(0, "done", { final: true }), msg(1, "next")];
  const blocks = textBlocks(deriveDisplay(events));
  assert.equal(blocks.length, 2);
  assert.equal(blocks[0].complete, true);
  assert.equal(blocks[0].text, "done");
  assert.equal(blocks[1].text, "next");
});

test("a role change breaks coalescing", () => {
  const events = [msg(0, "hi"), msg(1, "yo", { role: "user" }), msg(2, "back")];
  assert.deepEqual(
    textBlocks(deriveDisplay(events)).map((b) => [b.role, b.text]),
    [["assistant", "hi"], ["user", "yo"], ["assistant", "back"]],
  );
});

test("snapshot REPLACES accumulated text; a delta APPENDS (never treat a snapshot as a delta)", () => {
  const events = [
    msg(0, "Hel"),
    msg(1, "lo"),
    msg(2, "Hello, world.", { mode: "snapshot" }), // cumulative full text replaces "Hello"
  ];
  const block = asText(deriveDisplay(events)[0]);
  assert.equal(block.text, "Hello, world.");
  assert.equal(block.endOffset, 2);
});

test("a tool call is chronologically positioned between the text before and after it", () => {
  const events: TranscriptEvent[] = [
    msg(0, "before"),
    { kind: "tool-call", offset: 1, name: "read_file", callId: "c1", args: { path: "a" } },
    { kind: "tool-result", offset: 2, callId: "c1", ok: true, content: "ok" },
    msg(3, "after"),
  ];
  const blocks = deriveDisplay(events);
  assert.deepEqual(blocks.map((b) => b.kind), ["text", "tool", "text"]);
  const tool = asTool(blocks[1]);
  assert.equal(tool.tool.name, "read_file");
  assert.equal(tool.tool.result?.content, "ok"); // result paired to its call
  assert.equal(tool.startOffset, 1);
  assert.equal(tool.endOffset, 2);
  assert.equal(asText(blocks[0]).text, "before");
  assert.equal(asText(blocks[2]).text, "after");
});

test("a pending tool result does not conceal that the result is still pending", () => {
  const events: TranscriptEvent[] = [{ kind: "tool-call", offset: 0, name: "run", callId: "c1" }];
  assert.equal(asTool(deriveDisplay(events)[0]).tool.result, undefined);
});

test("permission request/resolution stay chronologically positioned and pair by callId", () => {
  const events: TranscriptEvent[] = [
    msg(0, "may I?"),
    {
      kind: "permission",
      phase: "request",
      offset: 1,
      callId: "p1",
      policy: "escalate",
      options: [{ optionId: "o1", name: "Allow", kind: "allow-once" }],
    },
    { kind: "permission", phase: "resolution", offset: 2, callId: "p1", optionId: "o1", allowed: true, by: "operator" },
    msg(3, "thanks"),
  ];
  const blocks = deriveDisplay(events);
  assert.deepEqual(blocks.map((b) => b.kind), ["text", "permission", "text"]);
  const perm = asPermission(blocks[1]);
  assert.equal(perm.permission.callId, "p1");
  assert.equal(perm.permission.resolved?.allowed, true);
  assert.equal(perm.endOffset, 2);
});

test("legacy events with NO metadata still display via the adjacent-same-speaker fallback", () => {
  const events = [msg(10, "foo"), msg(11, "bar")];
  const blocks = textBlocks(deriveDisplay(events));
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].text, "foobar");
});

test("raw stream-chunk events neither create a block nor break coalescing (raw plane is separate)", () => {
  const events: TranscriptEvent[] = [msg(0, "a"), { kind: "stream-chunk", offset: 1, chunk: "\u001b[0m" }, msg(2, "b")];
  const blocks = deriveDisplay(events);
  assert.equal(blocks.length, 1);
  assert.equal(asText(blocks[0]).text, "ab");
});

test("replay / duplicate offsets are idempotent — text never doubles", () => {
  const events = [msg(0, "Hel"), msg(1, "lo")];
  const projection = createDisplayProjection();
  projection.applyAll(events);
  projection.applyAll(events); // a reconnect re-feeds the whole slice (overlapping offsets)
  projection.applyAll([msg(1, "lo")]); // a duplicated single chunk
  const blocks = textBlocks(projection.blocks());
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].text, "Hello");
});

test("pagination overlap then continuation appends only the genuinely-new text", () => {
  const projection = createDisplayProjection();
  projection.applyAll([msg(0, "one"), msg(1, "two")]);
  projection.applyAll([msg(1, "two"), msg(2, "three")]); // page 2 overlaps offset 1, adds offset 2
  assert.equal(textBlocks(projection.blocks())[0].text, "onetwothree");
});

test("a retention gap is a visible block and breaks continuity", () => {
  const projection = createDisplayProjection();
  projection.applyAll([msg(0, "early")]);
  projection.noteGap();
  projection.applyAll([msg(5, "later")]);
  const blocks = projection.blocks();
  assert.deepEqual(blocks.map((b) => b.kind), ["text", "gap", "text"]);
  assert.equal(asText(blocks[0]).complete, true); // gap closed the earlier block
  assert.equal(blocks[1].kind === "gap" && blocks[1].beforeOffset, 5);
  assert.deepEqual(textBlocks(blocks).map((b) => b.text), ["early", "later"]);
});

test("incremental apply reports the touched block and whether it was appended", () => {
  const projection = createDisplayProjection();
  const first = projection.apply(msg(0, "Hel"));
  assert.equal(first.appended, true);
  assert.equal(first.changed?.kind, "text");
  const second = projection.apply(msg(1, "lo"));
  assert.equal(second.appended, false); // same block updated in place
  const secondBlock = second.changed;
  assert.ok(secondBlock !== undefined);
  assert.equal(asText(secondBlock).text, "Hello");
  const firstBlock = first.changed;
  assert.ok(firstBlock !== undefined);
  assert.equal(asText(secondBlock).id, asText(firstBlock).id); // stable id
  const dup = projection.apply(msg(1, "lo"));
  assert.equal(dup.changed, undefined); // duplicate offset is a no-op
});

test("block identity is stable across deltas (keyed by the first fragment offset)", () => {
  const events = [msg(4, "a"), msg(5, "b"), msg(6, "c")];
  const block = asText(deriveDisplay(events)[0]);
  assert.equal(block.id, "text:4");
  assert.equal(block.startOffset, 4);
});

test("metadata survives the encode → parse round-trip (additive wire contract)", () => {
  const event: MessageEvent = {
    kind: "message",
    offset: 7,
    role: "assistant",
    text: "hi",
    messageId: "m9",
    mode: "snapshot",
    start: true,
    final: true,
  };
  const chunk = encodeTranscriptEvent(event);
  assert.deepEqual(parseTranscriptEvent({ offset: 7, chunk }), event);
});

test("a present-but-malformed metadata field rejects the envelope to raw fidelity (never mis-decoded)", () => {
  const chunk = JSON.stringify({ nwfTranscriptEvent: 1, kind: "message", role: "assistant", text: "x", mode: "bogus" });
  const parsed = parseTranscriptEvent({ offset: 0, chunk });
  assert.equal(parsed.kind, "stream-chunk"); // falls back to raw, byte-faithful
  assert.equal(parsed.kind === "stream-chunk" && parsed.chunk, chunk);
});
