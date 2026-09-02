import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MESSAGE_FAMILIES,
  FAMILY_CODES,
  familyForCode,
  isMessageFamily,
} from "./families.ts";
import {
  QOS_LANES,
  LANE_CODES,
  laneForCode,
  lanePriority,
  isQosLane,
  compareFrameOrder,
  type QosLane,
} from "./lanes.ts";

test("MESSAGE_FAMILIES is the exact canonical set", () => {
  assert.deepEqual(
    [...MESSAGE_FAMILIES],
    ["register", "heartbeat", "deregister", "serve", "demand", "blackboard", "relay", "claim", "release"],
  );
});

test("appended families keep the original codes stable and add claim=8/release=9", () => {
  // Codes are an append-only wire contract: 1–7 MUST NOT move; 8/9 are the new
  // ownership frames.
  assert.deepEqual(
    { register: 1, heartbeat: 2, deregister: 3, serve: 4, demand: 5, blackboard: 6, relay: 7 },
    {
      register: FAMILY_CODES.register,
      heartbeat: FAMILY_CODES.heartbeat,
      deregister: FAMILY_CODES.deregister,
      serve: FAMILY_CODES.serve,
      demand: FAMILY_CODES.demand,
      blackboard: FAMILY_CODES.blackboard,
      relay: FAMILY_CODES.relay,
    },
  );
  assert.equal(FAMILY_CODES.claim, 8);
  assert.equal(FAMILY_CODES.release, 9);
});

test("family codes are a bijection with the family set", () => {
  const codes = MESSAGE_FAMILIES.map((f) => FAMILY_CODES[f]);
  assert.equal(new Set(codes).size, MESSAGE_FAMILIES.length, "codes must be unique");
  for (const family of MESSAGE_FAMILIES) {
    assert.equal(familyForCode(FAMILY_CODES[family]), family);
  }
});

test("isMessageFamily gates unknown values", () => {
  assert.ok(isMessageFamily("relay"));
  assert.ok(!isMessageFamily("gossip"));
  assert.ok(!isMessageFamily(4));
});

test("familyForCode returns undefined for unknown codes", () => {
  assert.equal(familyForCode(99), undefined);
});

test("QOS_LANES are in strict priority order control > interactive > bulk", () => {
  assert.deepEqual([...QOS_LANES], ["control", "interactive", "bulk"]);
  assert.ok(lanePriority("control") < lanePriority("interactive"));
  assert.ok(lanePriority("interactive") < lanePriority("bulk"));
});

test("lane codes are a bijection with the lane set", () => {
  for (const lane of QOS_LANES) {
    assert.equal(laneForCode(LANE_CODES[lane]), lane);
  }
  assert.equal(laneForCode(9), undefined);
});

test("isQosLane gates unknown values", () => {
  assert.ok(isQosLane("bulk"));
  assert.ok(!isQosLane("urgent"));
});

test("compareFrameOrder: a bulk storm never head-of-line-blocks control/interactive", () => {
  // A queue where a bulk storm is enqueued first, then a single control
  // heartbeat and an interactive blackboard write. Draining by the scheduler
  // ordering MUST surface control first, interactive second, bulk last —
  // regardless of enqueue order or seq.
  const queue: Array<{ lane: QosLane; seq: number; tag: string }> = [
    { lane: "bulk", seq: 1, tag: "bulk-a" },
    { lane: "bulk", seq: 2, tag: "bulk-b" },
    { lane: "bulk", seq: 3, tag: "bulk-c" },
    { lane: "control", seq: 50, tag: "heartbeat" },
    { lane: "interactive", seq: 40, tag: "blackboard" },
    { lane: "bulk", seq: 0, tag: "bulk-d" },
  ];
  const drained = [...queue].sort(compareFrameOrder).map((f) => f.tag);
  assert.deepEqual(drained, ["heartbeat", "blackboard", "bulk-d", "bulk-a", "bulk-b", "bulk-c"]);
});

test("compareFrameOrder: an ownership claim/release on the control lane is never head-of-line-blocked by a relay-chunk storm", () => {
  // The failure this guards: a burst of bulk relay chunks must not delay an
  // ownership frame. `claim`/`release` ride the control lane, so even enqueued
  // AFTER a storm of relay bulk chunks they drain first.
  const queue: Array<{ lane: QosLane; seq: number; tag: string }> = [
    { lane: "bulk", seq: 1, tag: "relay-chunk-1" },
    { lane: "bulk", seq: 2, tag: "relay-chunk-2" },
    { lane: "bulk", seq: 3, tag: "relay-chunk-3" },
    { lane: "bulk", seq: 4, tag: "relay-chunk-4" },
    { lane: "control", seq: 100, tag: "claim" },
    { lane: "control", seq: 101, tag: "release" },
  ];
  const drained = [...queue].sort(compareFrameOrder).map((f) => f.tag);
  assert.deepEqual(drained, [
    "claim",
    "release",
    "relay-chunk-1",
    "relay-chunk-2",
    "relay-chunk-3",
    "relay-chunk-4",
  ]);
});

test("compareFrameOrder: within a lane, lower seq drains first", () => {
  assert.ok(compareFrameOrder({ lane: "bulk", seq: 1 }, { lane: "bulk", seq: 2 }) < 0);
  assert.equal(compareFrameOrder({ lane: "bulk", seq: 5 }, { lane: "bulk", seq: 5 }), 0);
});
