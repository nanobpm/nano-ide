import assert from "node:assert/strict";
import { test } from "node:test";

import type { RelayPayload } from "@nanobpm/agentic-protocol";

import { type RelayOutbound, TerminalSession } from "./terminal-session.ts";

interface Harness {
  readonly session: TerminalSession;
  readonly sent: RelayOutbound[];
  readonly writes: string[];
  data(offset: number, chunk: string, stream?: string): RelayPayload;
}

function harness(options: { from?: number; credit?: number; stream?: string } = {}): Harness {
  const stream = options.stream ?? "worker-1";
  const sent: RelayOutbound[] = [];
  const writes: string[] = [];
  const session = new TerminalSession({
    stream,
    sink: { write: (chunk) => writes.push(chunk) },
    send: (message) => sent.push(message),
    from: options.from,
    credit: options.credit,
  });
  return {
    session,
    sent,
    writes,
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

test("an ack whose head is below our resume point clamps nextOffset down so fresh chunks are not dropped", () => {
  // Consumer resumed from 10, but the hub restarted/reset and its head is now 3
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
