import assert from "node:assert/strict";
import { test } from "node:test";

import type { RelayPayload } from "../protocol/index.ts";
import { TRANSCRIPT_EVENT_MARKER, type TranscriptEvent, encodeTranscriptEvent } from "../transcript/index.ts";

import { type RelayOutbound, type StructuredSink, TerminalSession } from "./terminal-session.ts";

interface Harness {
  readonly session: TerminalSession;
  readonly sent: RelayOutbound[];
  readonly writes: string[];
  readonly events: TranscriptEvent[];
  data(offset: number, chunk: string, stream?: string): RelayPayload;
}

function harness(options: { from?: number; credit?: number; stream?: string; structured?: boolean } = {}): Harness {
  const stream = options.stream ?? "worker-1";
  const sent: RelayOutbound[] = [];
  const writes: string[] = [];
  const events: TranscriptEvent[] = [];
  const structured: StructuredSink | undefined = options.structured
    ? { event: (event) => events.push(event) }
    : undefined;
  const session = new TerminalSession({
    stream,
    sink: { write: (chunk) => writes.push(chunk) },
    structured,
    send: (message) => sent.push(message),
    from: options.from,
    credit: options.credit,
  });
  return {
    session,
    sent,
    writes,
    events,
    data: (offset, chunk, s = stream) => ({ stream: s, offset, chunk }),
  };
}

test("attach subscribes from the initial offset with the configured credit", () => {
  const h = harness({ from: 0, credit: 256 });
  h.session.attach();
  assert.deepEqual(h.sent, [{ op: "subscribe", stream: "worker-1", from: 0, credit: 256 }]);
});

test("data chunks are written in order and advance the resume offset", () => {
  const h = harness();
  h.session.attach();
  h.session.handle(h.data(0, "hello "));
  h.session.handle(h.data(1, "world"));
  assert.deepEqual(h.writes, ["hello ", "world"]);
  assert.equal(h.session.nextOffset, 2);
});

test("a chunk at Number.MAX_SAFE_INTEGER fails fast instead of overflowing nextOffset", () => {
  // Advancing nextOffset past MAX_SAFE_INTEGER would produce an unsafe integer
  // that loses precision on any JSON round-trip when echoed back in subscribe.from,
  // silently corrupting resume semantics. Guard the increment so it throws instead.
  const h = harness();
  h.session.attach();
  assert.throws(
    () => h.session.handle(h.data(Number.MAX_SAFE_INTEGER, "x")),
    RangeError,
    "a boundary chunk must reject rather than corrupt the resume offset",
  );
  // The apply must be atomic: rejecting the boundary chunk must NOT write it to
  // the sink. A write-then-throw would leave output applied but nextOffset not
  // advanced, so the chunk re-delivers and duplicates on reconnect.
  assert.deepEqual(h.writes, [], "a rejected boundary chunk must not be written");
  assert.equal(h.session.nextOffset, 0);
});

test("a reconnect resumes from nextOffset — no lost and no duplicated output", () => {
  const h = harness();
  h.session.attach(); // subscribe from 0
  h.session.handle(h.data(0, "a"));
  h.session.handle(h.data(1, "b"));
  assert.equal(h.session.nextOffset, 2);

  // Socket drops and the client reconnects → the session re-attaches.
  h.session.attach();
  assert.deepEqual(h.sent[1], { op: "subscribe", stream: "worker-1", from: 2, credit: 1024 });

  // The hub replays from offset 2 (the retained tail). The boundary is not
  // re-sent because we resumed *past* it; new chunks flow through.
  h.session.handle(h.data(2, "c"));
  h.session.handle(h.data(3, "d"));
  assert.deepEqual(h.writes, ["a", "b", "c", "d"]);
  assert.equal(h.session.nextOffset, 4);
});

test("an already-applied replayed chunk (offset < nextOffset) is dropped idempotently", () => {
  const h = harness();
  h.session.attach();
  h.session.handle(h.data(0, "a"));
  h.session.handle(h.data(1, "b"));

  // Reconnect and the hub re-delivers the already-seen tail from a lower offset
  // (e.g. a subscribe raced with in-flight data): duplicates must not reappear.
  h.session.attach();
  h.session.handle(h.data(0, "a"));
  h.session.handle(h.data(1, "b"));
  h.session.handle(h.data(2, "c"));
  assert.deepEqual(h.writes, ["a", "b", "c"]);
  assert.equal(h.session.nextOffset, 3);
});

test("data for another stream is ignored", () => {
  const h = harness();
  h.session.attach();
  h.session.handle(h.data(0, "mine"));
  h.session.handle(h.data(1, "theirs", "worker-2"));
  assert.deepEqual(h.writes, ["mine"]);
  assert.equal(h.session.nextOffset, 1);
});

test("a subscribed ack reporting a gap fires onGap and records it", () => {
  let gaps = 0;
  const session = new TerminalSession({
    stream: "worker-1",
    sink: { write: () => {} },
    send: () => {},
    onGap: () => {
      gaps += 1;
    },
  });
  session.handle({ op: "subscribed", stream: "worker-1", gap: true, nextOffset: 5 });
  assert.equal(gaps, 1);
  assert.equal(session.gap, true);
});

test("a subscribed ack with no gap does not fire onGap", () => {
  let gaps = 0;
  const session = new TerminalSession({
    stream: "worker-1",
    sink: { write: () => {} },
    send: () => {},
    onGap: () => {
      gaps += 1;
    },
  });
  session.handle({ op: "subscribed", stream: "worker-1", gap: false, nextOffset: 0 });
  assert.equal(gaps, 0);
  assert.equal(session.gap, false);
});

test("a later no-gap ack clears a gap recorded by an earlier ack", () => {
  const session = new TerminalSession({
    stream: "worker-1",
    sink: { write: () => {} },
    send: () => {},
  });
  session.handle({ op: "subscribed", stream: "worker-1", gap: true, nextOffset: 5 });
  assert.equal(session.gap, true);
  session.handle({ op: "subscribed", stream: "worker-1", gap: false, nextOffset: 5 });
  assert.equal(session.gap, false);
});

test("a subscribed ack with a negative/unsafe nextOffset is rejected and does not corrupt the resume point", () => {
  // nextOffset is echoed into subscribe.from on the next attach, so a
  // negative/NaN/unsafe value from a buggy or malicious transport that bypasses
  // RelayChannelClient's validation must fail fast rather than corrupt resume.
  const h = harness({ from: 4 });
  h.session.attach();
  assert.throws(
    () => h.session.handle({ op: "subscribed", stream: "worker-1", gap: false, nextOffset: -1 }),
    RangeError,
    "a negative ack nextOffset must reject",
  );
  assert.throws(
    () =>
      h.session.handle({ op: "subscribed", stream: "worker-1", gap: false, nextOffset: Number.MAX_SAFE_INTEGER + 1 }),
    RangeError,
    "an unsafe ack nextOffset must reject",
  );
  // A rejected ack must leave the resume point untouched.
  assert.equal(h.session.nextOffset, 4);
});

test("an ack whose head is below our resume point clamps nextOffset down so fresh chunks are not dropped", () => {
  // (we are ahead of the stream). Without a clamp, offsets 3,4,… stay below our
  // resume point and every fresh chunk is dropped as a stale replay — output lost.
  const h = harness({ from: 10 });
  h.session.attach();
  h.session.handle({ op: "subscribed", stream: "worker-1", gap: false, nextOffset: 3 });
  assert.equal(h.session.nextOffset, 3);
  // Chunks from the restarted hub now apply instead of being dropped.
  h.session.handle(h.data(3, "fresh"));
  h.session.handle(h.data(4, "output"));
  assert.deepEqual(h.writes, ["fresh", "output"]);
  assert.equal(h.session.nextOffset, 5);
});

test("an ack whose head is at or above our resume point never advances nextOffset (no skipped chunks)", () => {
  // The normal case: the hub has more data than we have applied. The ack must
  // NOT bump nextOffset up to the head, or the un-applied tail would be skipped.
  const h = harness({ from: 2 });
  h.session.attach();
  h.session.handle({ op: "subscribed", stream: "worker-1", gap: false, nextOffset: 9 });
  assert.equal(h.session.nextOffset, 2);
  h.session.handle(h.data(2, "tail"));
  assert.deepEqual(h.writes, ["tail"]);
  assert.equal(h.session.nextOffset, 3);
});

test("resuming from a non-zero offset subscribes there and drops earlier replays", () => {
  const h = harness({ from: 10 });
  h.session.attach();
  assert.deepEqual(h.sent[0], { op: "subscribe", stream: "worker-1", from: 10, credit: 1024 });
  h.session.handle(h.data(8, "old")); // below resume point
  h.session.handle(h.data(10, "new"));
  assert.deepEqual(h.writes, ["new"]);
  assert.equal(h.session.nextOffset, 11);
});

test("grant sends a credit message", () => {
  const h = harness();
  h.session.grant(512);
  assert.deepEqual(h.sent, [{ op: "credit", credit: 512 }]);
});

test("an invalid from offset is rejected at construction", () => {
  assert.throws(
    () => new TerminalSession({ stream: "s", sink: { write: () => {} }, send: () => {}, from: -1 }),
    RangeError,
  );
});

test("an unsafe-integer from offset is rejected at construction", () => {
  assert.throws(
    () =>
      new TerminalSession({
        stream: "s",
        sink: { write: () => {} },
        send: () => {},
        from: Number.MAX_SAFE_INTEGER + 1,
      }),
    RangeError,
  );
});

test("a non-positive or unsafe credit is rejected at construction", () => {
  for (const credit of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, Number.NaN]) {
    assert.throws(
      () => new TerminalSession({ stream: "s", sink: { write: () => {} }, send: () => {}, credit }),
      RangeError,
      `credit ${credit} should be rejected`,
    );
  }
});

test("grant rejects a non-positive or unsafe credit", () => {
  const h = harness();
  for (const credit of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, Number.NaN]) {
    assert.throws(() => h.session.grant(credit), RangeError, `grant(${credit}) should be rejected`);
  }
});

// A marker-tagged chunk (encoded via the ONE canonical grammar, never a hand-rolled marker literal).
function structuredChunk(event: TranscriptEvent): string {
  return encodeTranscriptEvent(event);
}

test("a structured (marker-tagged) chunk routes to the structured sink, NOT the byte-terminal", () => {
  const h = harness({ structured: true });
  h.session.attach();
  h.session.handle(h.data(0, structuredChunk({ kind: "message", offset: 0, role: "assistant", text: "hi" })));
  assert.deepEqual(h.writes, [], "a structured chunk must not be dumped into the byte-terminal");
  assert.equal(h.events.length, 1);
  assert.deepEqual(h.events[0], { kind: "message", offset: 0, role: "assistant", text: "hi" });
  assert.equal(h.session.nextOffset, 1, "the resume offset advances for a structured chunk too");
});

test("a raw (untagged) chunk still renders on the byte-terminal even when a structured sink is wired", () => {
  const h = harness({ structured: true });
  h.session.attach();
  h.session.handle(h.data(0, "plain bytes\n"));
  assert.deepEqual(h.writes, ["plain bytes\n"]);
  assert.deepEqual(h.events, [], "raw bytes never reach the structured sink");
  assert.equal(h.session.nextOffset, 1);
});

test("with no structured sink a marker-tagged chunk is written verbatim (legacy raw-only behaviour)", () => {
  const h = harness();
  h.session.attach();
  const chunk = structuredChunk({ kind: "message", offset: 0, role: "assistant", text: "hi" });
  h.session.handle(h.data(0, chunk));
  assert.deepEqual(h.writes, [chunk], "without a structured sink the envelope falls through to the byte-terminal");
  assert.equal(h.session.nextOffset, 1);
});

test("a mixed stream that starts raw and only later carries tagged chunks routes each chunk correctly", () => {
  const h = harness({ structured: true });
  h.session.attach();
  h.session.handle(h.data(0, "booting...\n"));
  h.session.handle(h.data(1, structuredChunk({ kind: "turn", offset: 1, index: 0 })));
  h.session.handle(h.data(2, structuredChunk({ kind: "message", offset: 2, role: "assistant", text: "done" })));
  h.session.handle(h.data(3, "trailing raw\n"));
  assert.deepEqual(h.writes, ["booting...\n", "trailing raw\n"], "raw chunks land on the terminal");
  assert.deepEqual(
    h.events.map((e) => e.kind),
    ["turn", "message"],
    "only the tagged chunks reach the structured sink",
  );
  assert.equal(h.session.nextOffset, 4);
});

test("a marker-tagged but malformed envelope falls back to raw bytes (byte-terminal), never the structured sink", () => {
  // A chunk mentioning the marker but with an unknown/rejected body must be
  // retained verbatim for byte-replay fidelity, not routed as a structured event.
  const h = harness({ structured: true });
  h.session.attach();
  const malformed = JSON.stringify({ [TRANSCRIPT_EVENT_MARKER]: 1, kind: "message" }); // no text → decoder rejects
  h.session.handle(h.data(0, malformed));
  assert.deepEqual(h.writes, [malformed]);
  assert.deepEqual(h.events, []);
  assert.equal(h.session.nextOffset, 1);
});

test("a structured reconnect resumes from nextOffset — no dropped and no double-applied events", () => {
  const h = harness({ structured: true });
  h.session.attach();
  h.session.handle(h.data(0, structuredChunk({ kind: "turn", offset: 0, index: 0 })));
  h.session.handle(h.data(1, structuredChunk({ kind: "message", offset: 1, role: "assistant", text: "a" })));
  assert.equal(h.session.nextOffset, 2);

  // Socket drops; the client reconnects → re-attach resumes from offset 2.
  h.session.attach();
  assert.deepEqual(h.sent[1], { op: "subscribe", stream: "worker-1", from: 2, credit: 1024 });

  // The hub replays the retained tail (re-sends offset 1) then continues. The
  // replayed event is below nextOffset and must be dropped (no double-apply);
  // the fresh event applies exactly once (no loss).
  h.session.handle(h.data(1, structuredChunk({ kind: "message", offset: 1, role: "assistant", text: "a" })));
  h.session.handle(h.data(2, structuredChunk({ kind: "message", offset: 2, role: "assistant", text: "b" })));
  assert.deepEqual(
    h.events.map((e) => (e.kind === "message" ? e.text : e.kind)),
    ["turn", "a", "b"],
    "no dropped and no duplicated structured events across the reconnect",
  );
  assert.equal(h.session.nextOffset, 3);
});

