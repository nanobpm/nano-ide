import assert from "node:assert/strict";
import { test } from "node:test";
import type { Frame, QosLane } from "@nanobpm/agentic-protocol";
import { QosScheduler, compareFrameOrder } from "./scheduler.ts";

let seq = 0;
function frame(lane: QosLane, tag: string): Frame {
  return { lane, family: "relay", seq: seq++, payload: { tag } };
}

function tagsOf(frames: Frame[]): string[] {
  return frames.map((f) => {
    const p = f.payload;
    if (typeof p === "object" && p !== null) {
      const tag = Reflect.get(p, "tag");
      if (typeof tag === "string") {
        return tag;
      }
    }
    return "";
  });
}

test("drains in strict lane priority: control > interactive > bulk", () => {
  seq = 0;
  const out: Frame[] = [];
  // Credit 0 holds the bulk lane so this asserts the guarantee directly: control
  // and interactive drain eagerly and are NOT head-of-line-blocked by buffered
  // bulk. Once credit is granted the bulk tail follows, strictly last.
  const s = new QosScheduler({ sink: (f) => out.push(f), credit: 0 });
  s.enqueue(frame("bulk", "b1"));
  s.enqueue(frame("control", "c1"));
  s.enqueue(frame("interactive", "i1"));
  s.enqueue(frame("bulk", "b2"));
  s.enqueue(frame("control", "c2"));
  // Bulk is still buffered; every control/interactive frame has already sailed past it.
  assert.deepEqual(tagsOf(out), ["c1", "i1", "c2"]);
  assert.equal(s.pendingBulk, 2);
  s.grantCredit(100);
  // Full drain: every control/interactive frame precedes every bulk frame.
  assert.deepEqual(tagsOf(out), ["c1", "i1", "c2", "b1", "b2"]);
});

test("bulk is strictly ranked below control/interactive and drains in S0 compareFrameOrder", () => {
  seq = 0;
  const out: Frame[] = [];
  // Credit 0 holds the bulk lane while the higher lanes drain eagerly (low
  // latency). The load-bearing guarantee: every bulk frame is emitted only AFTER
  // every control/interactive frame — bulk never head-of-line-blocks them.
  const s = new QosScheduler({ sink: (f) => out.push(f), credit: 0 });
  const bulk = [frame("bulk", "b0"), frame("bulk", "b1"), frame("bulk", "b2")];
  const high = [frame("control", "c0"), frame("interactive", "i0"), frame("control", "c1")];
  for (const f of [bulk[0], high[0], bulk[1], high[1], bulk[2], high[2]]) {
    s.enqueue(f);
  }
  // Only the higher-lane frames have drained; all bulk is still held.
  assert.deepEqual(new Set(tagsOf(out)), new Set(["c0", "i0", "c1"]));
  assert.equal(s.pendingBulk, 3);
  s.grantCredit(100);
  // Bulk now drains, in S0 compareFrameOrder (ascending seq within the lane),
  // and strictly after every higher-lane frame.
  const firstBulkIndex = out.findIndex((f) => f.lane === "bulk");
  assert.ok(out.slice(0, firstBulkIndex).every((f) => f.lane !== "bulk"));
  const drainedBulk = out.filter((f) => f.lane === "bulk");
  assert.deepEqual(tagsOf(drainedBulk), tagsOf([...bulk].sort(compareFrameOrder)));
});

test("a bulk storm never head-of-line-blocks a control frame (zero credit)", () => {
  seq = 0;
  const out: Frame[] = [];
  const s = new QosScheduler({ sink: (f) => out.push(f), credit: 0 });
  for (let i = 0; i < 1000; i++) {
    s.enqueue(frame("bulk", `b${i}`));
  }
  // No credit → not one bulk frame has been emitted...
  assert.equal(out.length, 0);
  assert.equal(s.pendingBulk, 1000 <= 1024 ? 1000 : 1024);
  // ...yet a heartbeat on the control lane sails straight through.
  s.enqueue(frame("control", "hb"));
  assert.deepEqual(tagsOf(out), ["hb"]);
});

test("credit gates the bulk lane; grantCredit releases exactly that many", () => {
  seq = 0;
  const out: Frame[] = [];
  const s = new QosScheduler({ sink: (f) => out.push(f), credit: 0 });
  s.enqueue(frame("bulk", "b0"));
  s.enqueue(frame("bulk", "b1"));
  s.enqueue(frame("bulk", "b2"));
  assert.equal(out.length, 0);
  s.grantCredit(2);
  assert.deepEqual(tagsOf(out), ["b0", "b1"]);
  assert.equal(s.credit, 0);
  assert.equal(s.pendingBulk, 1);
  s.grantCredit(5); // more than remains
  assert.deepEqual(tagsOf(out), ["b0", "b1", "b2"]);
  assert.equal(s.credit, 4); // leftover credit is retained
});

test("initial credit lets bulk flow immediately", () => {
  seq = 0;
  const out: Frame[] = [];
  const s = new QosScheduler({ sink: (f) => out.push(f), credit: 3 });
  s.enqueue(frame("bulk", "b0"));
  s.enqueue(frame("bulk", "b1"));
  assert.deepEqual(tagsOf(out), ["b0", "b1"]);
  assert.equal(s.credit, 1);
});

test("bulk overflow sheds the OLDEST bulk frame; control is never shed", () => {
  seq = 0;
  const out: Frame[] = [];
  const s = new QosScheduler({ sink: (f) => out.push(f), credit: 0, bulkCapacity: 3 });
  s.enqueue(frame("bulk", "b0"));
  s.enqueue(frame("bulk", "b1"));
  s.enqueue(frame("bulk", "b2"));
  s.enqueue(frame("bulk", "b3")); // overflow → b0 shed
  assert.equal(s.shed, 1);
  assert.equal(s.pendingBulk, 3);
  s.grantCredit(100);
  assert.deepEqual(tagsOf(out), ["b1", "b2", "b3"]);
});

test("bulk circular buffer wraps correctly across interleaved overflow and draining", () => {
  seq = 0;
  const out: Frame[] = [];
  // Exercises the ring's head wrap-around (defect-class guard for the O(1)
  // circular buffer that replaced Array.shift()): fill past capacity, drain a
  // partial slice so the head advances, then refill past capacity again so the
  // write index wraps around the buffer.
  const s = new QosScheduler({ sink: (f) => out.push(f), credit: 0, bulkCapacity: 3 });
  for (const t of ["b0", "b1", "b2", "b3", "b4"]) {
    s.enqueue(frame("bulk", t)); // b0, b1 shed → holds b2, b3, b4
  }
  assert.equal(s.shed, 2);
  assert.equal(s.pendingBulk, 3);
  s.grantCredit(2); // drain b2, b3 → head advances, b4 remains
  assert.deepEqual(tagsOf(out), ["b2", "b3"]);
  assert.equal(s.pendingBulk, 1);
  for (const t of ["b5", "b6", "b7"]) {
    s.enqueue(frame("bulk", t)); // holds b4,b5,b6 then b4 shed → b5,b6,b7 (write index wraps)
  }
  assert.equal(s.shed, 3); // b4 was shed on the third refill
  assert.equal(s.pendingBulk, 3);
  s.grantCredit(100);
  assert.deepEqual(tagsOf(out), ["b2", "b3", "b5", "b6", "b7"]); // b4 evicted, never emitted
  assert.equal(s.pendingBulk, 0);
});

test("flush is a no-op when every lane is empty (guards the allocation-free empty-lane path)", () => {
  seq = 0;
  let sinkCalls = 0;
  const s = new QosScheduler({ sink: () => sinkCalls++, credit: 100 });
  // No frames enqueued: flush() must touch nothing and emit nothing. This guards
  // the empty-lane fast path (splice(0) skipped under a length check) — draining
  // an empty scheduler stays correct and side-effect-free.
  s.flush();
  assert.equal(sinkCalls, 0);
  assert.equal(s.pending, 0);
  // A bulk-only backlog (control/interactive empty) still flushes correctly: the
  // guarded empty higher lanes are skipped, the bulk tail drains under credit.
  s.enqueue(frame("bulk", "b0"));
  assert.equal(sinkCalls, 1);
  assert.equal(s.pending, 0);
});

test("clear discards buffered frames across all lanes", () => {
  seq = 0;
  const out: Frame[] = [];
  const s = new QosScheduler({ sink: (f) => out.push(f), credit: 0 });
  s.enqueue(frame("bulk", "b0"));
  s.enqueue(frame("bulk", "b1"));
  assert.equal(s.pending, 2);
  s.clear();
  assert.equal(s.pending, 0);
  s.grantCredit(100);
  assert.equal(out.length, 0);
});

test("rejects invalid credit and bulkCapacity", () => {
  assert.throws(() => new QosScheduler({ sink: () => {}, credit: -1 }), RangeError);
  assert.throws(() => new QosScheduler({ sink: () => {}, bulkCapacity: 0 }), RangeError);
  const s = new QosScheduler({ sink: () => {} });
  assert.throws(() => s.grantCredit(-1), RangeError);
});
