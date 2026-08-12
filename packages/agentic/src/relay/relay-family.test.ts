import assert from "node:assert/strict";
import { test } from "node:test";
import type { Frame } from "../protocol/index.ts";
import { RelayHub, RelayMessageError } from "./relay-family.ts";
import type { RelayConnection } from "./relay-family.ts";

class FakeRegistry {
  readonly live = new Set<string>();
  has(id: string): boolean {
    return this.live.has(id);
  }
}

class FakeConn implements RelayConnection {
  readonly id: string;
  readonly registry: FakeRegistry;
  readonly sent: Frame[] = [];
  constructor(id: string, registry: FakeRegistry) {
    this.id = id;
    this.registry = registry;
    registry.live.add(id);
  }
  send(frame: Frame): void {
    this.sent.push(frame);
  }
  disconnect(): void {
    this.registry.live.delete(this.id);
  }
}

function produce(stream: string, incarnation: number, chunk: string): Frame {
  return { lane: "bulk", family: "relay", seq: 0, payload: { op: "produce", stream, incarnation, chunk } };
}
function subscribe(stream: string, from: number, credit: number): Frame {
  return { lane: "control", family: "relay", seq: 0, payload: { op: "subscribe", stream, from, credit } };
}
function credit(n: number): Frame {
  return { lane: "control", family: "relay", seq: 0, payload: { op: "credit", credit: n } };
}

function field(payload: unknown, key: string): unknown {
  return typeof payload === "object" && payload !== null ? Reflect.get(payload, key) : undefined;
}

/** Chunks the consumer received as bulk data frames, in emission order. */
function dataChunks(conn: FakeConn): string[] {
  return conn.sent
    .filter((f) => f.lane === "bulk" && field(f.payload, "op") === undefined)
    .map((f) => String(field(f.payload, "chunk")));
}
function dataOffsets(conn: FakeConn): number[] {
  return conn.sent
    .filter((f) => f.lane === "bulk" && field(f.payload, "op") === undefined)
    .map((f) => Number(field(f.payload, "offset")));
}
function acks(conn: FakeConn): Frame[] {
  return conn.sent.filter((f) => field(f.payload, "op") === "subscribed");
}

test("produce appends to the stream ring and assigns authoritative offsets", () => {
  const relay = new RelayHub();
  const reg = new FakeRegistry();
  const prod = new FakeConn("p", reg);
  relay.handle(produce("t", 1, "a"), prod);
  relay.handle(produce("t", 1, "b"), prod);
  const ring = relay.ring("t");
  assert.ok(ring);
  assert.equal(ring.nextOffset, 2);
  assert.deepEqual(ring.since(0).entries, [
    { offset: 0, chunk: "a" },
    { offset: 1, chunk: "b" },
  ]);
});

test("a subscriber gets a control ack then the live stream broadcast to it", () => {
  const relay = new RelayHub();
  const reg = new FakeRegistry();
  const prod = new FakeConn("p", reg);
  const cons = new FakeConn("c", reg);
  relay.handle(subscribe("t", 0, 100), cons);
  relay.handle(produce("t", 1, "x"), prod);
  relay.handle(produce("t", 1, "y"), prod);
  assert.equal(acks(cons).length, 1);
  assert.equal(field(acks(cons)[0]?.payload, "gap"), false);
  assert.deepEqual(dataChunks(cons), ["x", "y"]);
});

test("resume-from-offset: a reconnecting consumer receives only the tail it is missing", () => {
  const relay = new RelayHub();
  const reg = new FakeRegistry();
  const prod = new FakeConn("p", reg);
  for (const c of ["a", "b", "c", "d"]) {
    relay.handle(produce("t", 1, c), prod);
  }
  // Consumer had received through offset 1 (a,b); it reconnects on a new socket
  // and resumes from offset 2.
  const resumed = new FakeConn("c2", reg);
  relay.handle(subscribe("t", 2, 100), resumed);
  assert.equal(field(acks(resumed)[0]?.payload, "gap"), false);
  assert.deepEqual(dataChunks(resumed), ["c", "d"]);
  assert.deepEqual(dataOffsets(resumed), [2, 3]);
  // The stream survives the reconnect: subsequent live chunks flow to the resumed consumer.
  relay.handle(produce("t", 1, "e"), prod);
  assert.deepEqual(dataChunks(resumed), ["c", "d", "e"]);
});

test("resume flags a gap when the requested offset was already evicted", () => {
  const relay = new RelayHub({ ringCapacity: 2 });
  const reg = new FakeRegistry();
  const prod = new FakeConn("p", reg);
  for (const c of ["a", "b", "c", "d"]) {
    relay.handle(produce("t", 1, c), prod); // retains offsets 2,3
  }
  const cons = new FakeConn("c", reg);
  relay.handle(subscribe("t", 0, 100), cons);
  assert.equal(field(acks(cons)[0]?.payload, "gap"), true);
  assert.deepEqual(dataOffsets(cons), [2, 3]); // best-effort tail
});

test("credit-based backpressure: bulk data waits for credit; control ack is not gated", () => {
  const relay = new RelayHub();
  const reg = new FakeRegistry();
  const prod = new FakeConn("p", reg);
  const cons = new FakeConn("c", reg);
  relay.handle(subscribe("t", 0, 0), cons); // zero credit
  relay.handle(produce("t", 1, "x"), prod);
  relay.handle(produce("t", 1, "y"), prod);
  // The control-lane ack arrived; no bulk data yet (starved of credit).
  assert.equal(acks(cons).length, 1);
  assert.deepEqual(dataChunks(cons), []);
  // Consumer grants credit → buffered data drains in order.
  relay.handle(credit(5), cons);
  assert.deepEqual(dataChunks(cons), ["x", "y"]);
});

test("a bulk storm to a starved consumer never blocks another consumer's control ack", () => {
  const relay = new RelayHub();
  const reg = new FakeRegistry();
  const prod = new FakeConn("p", reg);
  const slow = new FakeConn("slow", reg);
  const fast = new FakeConn("fast", reg);
  relay.handle(subscribe("t", 0, 0), slow); // slow consumer, no credit
  for (let i = 0; i < 500; i++) {
    relay.handle(produce("t", 1, `b${i}`), prod);
  }
  assert.deepEqual(dataChunks(slow), []); // slow consumer is backpressured
  // A brand-new consumer still gets its control ack immediately.
  relay.handle(subscribe("t", 500, 0), fast);
  assert.equal(acks(fast).length, 1);
});

test("stale incarnations are fenced: a lower incarnation is rejected and not stored", () => {
  const fenced: Array<{ stream: string; incarnation: number; current: number }> = [];
  const relay = new RelayHub({ onFenced: (stream, incarnation, current) => fenced.push({ stream, incarnation, current }) });
  const reg = new FakeRegistry();
  const prod = new FakeConn("p", reg);
  relay.handle(produce("t", 2, "new"), prod);
  relay.handle(produce("t", 1, "zombie"), prod); // stale → fenced
  assert.deepEqual(fenced, [{ stream: "t", incarnation: 1, current: 2 }]);
  assert.deepEqual(relay.ring("t")?.since(0).entries.map((e) => e.chunk), ["new"]);
});

test("a newer incarnation takes over and its chunks are appended", () => {
  const relay = new RelayHub();
  const reg = new FakeRegistry();
  const prod = new FakeConn("p", reg);
  relay.handle(produce("t", 1, "old"), prod);
  relay.handle(produce("t", 2, "new"), prod); // takeover
  assert.equal(relay.fence.current("t"), 2);
  assert.deepEqual(relay.ring("t")?.since(0).entries.map((e) => e.chunk), ["old", "new"]);
});

test("a disconnected consumer is pruned lazily on the next inbound frame", () => {
  const relay = new RelayHub();
  const reg = new FakeRegistry();
  const prod = new FakeConn("p", reg);
  const cons = new FakeConn("c", reg);
  relay.handle(subscribe("t", 0, 100), cons);
  assert.equal(relay.subscriberCount, 1);
  cons.disconnect(); // registry no longer has "c"
  relay.handle(produce("t", 1, "x"), prod); // triggers prune
  assert.equal(relay.subscriberCount, 0);
  assert.deepEqual(dataChunks(cons), []); // nothing sent to the dead socket
});

test("a malformed relay payload is reported to onError and dropped", () => {
  const errors: unknown[] = [];
  const relay = new RelayHub({ onError: (err) => errors.push(err) });
  const reg = new FakeRegistry();
  const conn = new FakeConn("c", reg);
  const bad: Frame = { lane: "control", family: "relay", seq: 0, payload: { op: "produce", stream: "" } };
  relay.handle(bad, conn);
  assert.equal(errors.length, 1);
  assert.ok(errors[0] instanceof RelayMessageError);
  assert.equal(relay.streamCount, 0);
});

test("a credit grant before subscribe pre-loads the consumer's budget", () => {
  const relay = new RelayHub();
  const reg = new FakeRegistry();
  const prod = new FakeConn("p", reg);
  const cons = new FakeConn("c", reg);
  relay.handle(credit(10), cons); // credit first
  relay.handle(subscribe("t", 0, 0), cons); // subscribe with no additional credit
  relay.handle(produce("t", 1, "x"), prod);
  assert.deepEqual(dataChunks(cons), ["x"]); // pre-loaded credit let it flow
});

test("the subscribed ack is emitted before a previously buffered bulk tail flushes", () => {
  const relay = new RelayHub();
  const reg = new FakeRegistry();
  const prod = new FakeConn("p", reg);
  const cons = new FakeConn("c", reg);
  // Subscribe to A with zero credit, then produce bulk that stays buffered.
  relay.handle(subscribe("A", 0, 0), cons);
  relay.handle(produce("A", 1, "a0"), prod);
  relay.handle(produce("A", 1, "a1"), prod);
  assert.deepEqual(dataChunks(cons), []); // starved of credit → buffered
  const before = cons.sent.length;
  // Subscribe to B WITH credit. Releasing that credit must NOT flush A's buffered
  // bulk tail out ahead of B's control ack — the ack rides first.
  relay.handle(subscribe("B", 0, 100), cons);
  const emitted = cons.sent.slice(before);
  const ackIndex = emitted.findIndex((f) => field(f.payload, "op") === "subscribed");
  const firstBulkIndex = emitted.findIndex((f) => f.lane === "bulk" && field(f.payload, "op") === undefined);
  assert.ok(ackIndex >= 0, "B's control ack was emitted");
  assert.ok(firstBulkIndex >= 0, "A's buffered bulk flushed once credit was granted");
  assert.ok(ackIndex < firstBulkIndex, "the ack precedes the flushed bulk tail");
});

test("RelayHub validates capacity/credit options up-front and fails fast", () => {
  assert.throws(() => new RelayHub({ ringCapacity: 0 }), RangeError);
  assert.throws(() => new RelayHub({ ringCapacity: 1.5 }), RangeError);
  assert.throws(() => new RelayHub({ bulkCapacity: 0 }), RangeError);
  assert.throws(() => new RelayHub({ defaultCredit: -1 }), RangeError);
});
