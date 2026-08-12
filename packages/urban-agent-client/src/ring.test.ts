import assert from "node:assert/strict";
import { test } from "node:test";
import { OutboundRing, compareFrameOrder } from "./ring.ts";
import type { Frame, QosLane } from "./protocol.ts";

function frame(lane: QosLane, seq: number, family: Frame["family"] = "relay"): Frame {
  return { lane, family, seq, payload: { seq } };
}

test("drains in strict QoS lane priority, FIFO within a lane", () => {
  const ring = new OutboundRing({ capacity: 16 });
  ring.enqueue(frame("bulk", 0));
  ring.enqueue(frame("interactive", 1));
  ring.enqueue(frame("control", 2, "heartbeat"));
  ring.enqueue(frame("bulk", 3));
  ring.enqueue(frame("control", 4, "heartbeat"));

  const order = [ring.dequeue(), ring.dequeue(), ring.dequeue(), ring.dequeue(), ring.dequeue()];
  assert.deepEqual(
    order.map((f) => f && [f.lane, f.seq]),
    [
      ["control", 2],
      ["control", 4],
      ["interactive", 1],
      ["bulk", 0],
      ["bulk", 3],
    ],
  );
  assert.equal(ring.dequeue(), undefined);
});

test("a bulk storm never head-of-line-blocks a control frame", () => {
  const ring = new OutboundRing({ capacity: 1000 });
  for (let i = 0; i < 500; i++) {
    ring.enqueue(frame("bulk", i));
  }
  ring.enqueue(frame("control", 500, "heartbeat"));
  // Despite 500 queued bulk frames enqueued first, the heartbeat drains next.
  const next = ring.dequeue();
  assert.equal(next?.lane, "control");
  assert.equal(next?.seq, 500);
});

test("toArray drain order equals sorting by S0 compareFrameOrder", () => {
  const ring = new OutboundRing({ capacity: 32 });
  const frames = [
    frame("bulk", 10),
    frame("control", 11, "heartbeat"),
    frame("interactive", 12),
    frame("bulk", 13),
    frame("control", 14, "heartbeat"),
    frame("interactive", 15),
  ];
  for (const f of frames) {
    ring.enqueue(f);
  }
  const expected = [...frames].sort(compareFrameOrder);
  assert.deepEqual(ring.toArray(), expected);
});

test("overflow evicts the oldest bulk frame first, never a control frame", () => {
  const ring = new OutboundRing({ capacity: 3 });
  const c = frame("control", 0, "heartbeat");
  ring.enqueue(c);
  ring.enqueue(frame("bulk", 1));
  ring.enqueue(frame("bulk", 2));
  // Full. Next enqueue evicts the oldest bulk (seq 1), keeps the control frame.
  const { evicted } = ring.enqueue(frame("bulk", 3));
  assert.equal(evicted?.lane, "bulk");
  assert.equal(evicted?.seq, 1);
  assert.equal(ring.size, 3);
  const remaining = ring.toArray();
  assert.deepEqual(remaining.map((f) => [f.lane, f.seq]), [
    ["control", 0],
    ["bulk", 2],
    ["bulk", 3],
  ]);
});

test("overflow falls back to interactive, then control, when nothing lower is buffered", () => {
  const ring = new OutboundRing({ capacity: 2 });
  ring.enqueue(frame("control", 0, "heartbeat"));
  ring.enqueue(frame("interactive", 1));
  // Full with only control+interactive: the interactive frame is shed before control.
  let res = ring.enqueue(frame("control", 2, "heartbeat"));
  assert.equal(res.evicted?.lane, "interactive");
  // Now two control frames: an overflow must evict the oldest control frame.
  res = ring.enqueue(frame("control", 3, "heartbeat"));
  assert.equal(res.evicted?.lane, "control");
  assert.equal(res.evicted?.seq, 0);
});

test("peek is non-destructive and matches the next dequeue", () => {
  const ring = new OutboundRing({ capacity: 4 });
  ring.enqueue(frame("bulk", 1));
  ring.enqueue(frame("control", 2, "heartbeat"));
  const peeked = ring.peek();
  assert.equal(peeked?.lane, "control");
  assert.equal(ring.size, 2);
  assert.deepEqual(ring.dequeue(), peeked);
});

test("rejects a non-positive capacity", () => {
  assert.throws(() => new OutboundRing({ capacity: 0 }), RangeError);
  assert.throws(() => new OutboundRing({ capacity: -1 }), RangeError);
  assert.throws(() => new OutboundRing({ capacity: 1.5 }), RangeError);
});

test("clear empties the ring", () => {
  const ring = new OutboundRing({ capacity: 4 });
  ring.enqueue(frame("bulk", 1));
  ring.enqueue(frame("control", 2, "heartbeat"));
  ring.clear();
  assert.equal(ring.size, 0);
  assert.ok(ring.isEmpty);
  assert.equal(ring.dequeue(), undefined);
});
