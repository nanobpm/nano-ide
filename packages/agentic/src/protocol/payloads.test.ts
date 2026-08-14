import { test } from "node:test";
import assert from "node:assert/strict";
import { validatePayload } from "./payloads.ts";
import { GOLDEN_FRAMES } from "./conformance/frames.ts";

test("every golden frame payload satisfies its family contract", () => {
  for (const golden of GOLDEN_FRAMES) {
    // The null-payload envelope frame is a codec-level fixture, not a valid
    // family payload; skip it for the payload-contract check.
    if (golden.frame.payload === null) continue;
    const result = validatePayload(golden.frame.family, golden.frame.payload);
    assert.ok(
      result.ok,
      `${golden.name}: ${result.ok ? "" : JSON.stringify(result.errors)}`,
    );
  }
});

test("register requires a non-empty instance and a capability object", () => {
  assert.ok(validatePayload("register", { instance: "w", capability: {} }).ok);
  assert.ok(!validatePayload("register", { instance: "", capability: {} }).ok);
  assert.ok(!validatePayload("register", { instance: "w" }).ok);
  assert.ok(!validatePayload("register", { instance: "w", capability: "opus" }).ok);
});

test("register validates known capability field types when present", () => {
  assert.ok(
    validatePayload("register", {
      instance: "w",
      capability: { cognition: "reason", weight: 3, family: "opus", host: "h1" },
    }).ok,
  );
  for (const capability of [
    { weight: "3" },
    { cognition: 1 },
    { family: true },
    { host: 0 },
  ]) {
    const bad = validatePayload("register", { instance: "w", capability });
    assert.ok(!bad.ok, JSON.stringify(capability));
    if (!bad.ok) assert.ok(bad.errors.some((e) => e.code === "bad-capability"));
  }
});

test("serve rejects an invalid routing token in tokens[]", () => {
  assert.ok(validatePayload("serve", { instance: "w", tokens: ["planning.decide"] }).ok);
  const bad = validatePayload("serve", { instance: "w", tokens: ["Bad Token"] });
  assert.ok(!bad.ok);
  if (!bad.ok) assert.ok(bad.errors.some((e) => e.code === "bad-token"));
});

test("blackboard op must be append or read", () => {
  assert.ok(validatePayload("blackboard", { op: "append" }).ok);
  assert.ok(validatePayload("blackboard", { op: "read", since: 0 }).ok);
  assert.ok(!validatePayload("blackboard", { op: "delete" }).ok);
  assert.ok(!validatePayload("blackboard", { op: "read", since: -1 }).ok);
});

test("blackboard files must be an array of only strings when present", () => {
  assert.ok(validatePayload("blackboard", { op: "append", files: [] }).ok);
  assert.ok(validatePayload("blackboard", { op: "append", files: ["a.rs", "b.rs"] }).ok);
  const notArray = validatePayload("blackboard", { op: "append", files: "a.rs" });
  assert.ok(!notArray.ok);
  if (!notArray.ok) assert.ok(notArray.errors.some((e) => e.code === "bad-files"));
  // A mixed array must be rejected outright, not silently coerced to its string subset:
  // dropping the non-string element would store an incomplete file-claim and skew conflict detection.
  const mixed = validatePayload("blackboard", { op: "append", files: ["a.rs", 123] });
  assert.ok(!mixed.ok);
  if (!mixed.ok) assert.ok(mixed.errors.some((e) => e.code === "bad-files"));
});

test("relay delivery chunk (no op) requires stream, non-negative integer offset, and string chunk", () => {
  assert.ok(validatePayload("relay", { stream: "s", offset: 0, chunk: "" }).ok);
  assert.ok(!validatePayload("relay", { stream: "s", offset: -1, chunk: "" }).ok);
  assert.ok(!validatePayload("relay", { stream: "s", offset: 1.5, chunk: "" }).ok);
  assert.ok(!validatePayload("relay", { stream: "", offset: 0, chunk: "" }).ok);
});

test("relay produce control frame requires stream, non-negative integer incarnation, and string chunk", () => {
  assert.ok(validatePayload("relay", { op: "produce", stream: "s", incarnation: 0, chunk: "hi" }).ok);
  assert.ok(validatePayload("relay", { op: "produce", stream: "s", incarnation: 1786690000000, chunk: "" }).ok);
  const badInc = validatePayload("relay", { op: "produce", stream: "s", incarnation: -1, chunk: "" });
  assert.ok(!badInc.ok);
  if (!badInc.ok) assert.ok(badInc.errors.some((e) => e.code === "bad-incarnation"));
  assert.ok(!validatePayload("relay", { op: "produce", stream: "s", incarnation: 1.5, chunk: "" }).ok);
  // The legacy bug: a produce frame missing `incarnation` (the old { stream, offset, chunk } shape) is rejected.
  assert.ok(!validatePayload("relay", { op: "produce", stream: "s", offset: 0, chunk: "" }).ok);
  assert.ok(!validatePayload("relay", { op: "produce", stream: "", incarnation: 0, chunk: "" }).ok);
});

test("relay subscribe/credit/subscribed control frames validate their fields", () => {
  assert.ok(validatePayload("relay", { op: "subscribe", stream: "s" }).ok);
  assert.ok(validatePayload("relay", { op: "subscribe", stream: "s", from: 2, credit: 1024 }).ok);
  assert.ok(!validatePayload("relay", { op: "subscribe", stream: "s", from: -1 }).ok);
  assert.ok(!validatePayload("relay", { op: "subscribe", stream: "s", credit: 1.5 }).ok);
  assert.ok(validatePayload("relay", { op: "credit", credit: 512 }).ok);
  assert.ok(!validatePayload("relay", { op: "credit", credit: -1 }).ok);
  assert.ok(validatePayload("relay", { op: "subscribed", stream: "s", gap: false, nextOffset: 8 }).ok);
  assert.ok(!validatePayload("relay", { op: "subscribed", stream: "s", gap: "no", nextOffset: 8 }).ok);
  assert.ok(!validatePayload("relay", { op: "subscribed", stream: "s", gap: true, nextOffset: -1 }).ok);
});

test("relay rejects an unknown op", () => {
  const bad = validatePayload("relay", { op: "explode", stream: "s" });
  assert.ok(!bad.ok);
  if (!bad.ok) assert.ok(bad.errors.some((e) => e.code === "bad-op"));
});

test("deregister accepts optional string reason and rejects non-string reason", () => {
  assert.ok(validatePayload("deregister", { instance: "w" }).ok);
  assert.ok(validatePayload("deregister", { instance: "w", reason: "shutdown" }).ok);
  const bad = validatePayload("deregister", { instance: "w", reason: 42 });
  assert.ok(!bad.ok);
  if (!bad.ok) assert.ok(bad.errors.some((e) => e.code === "bad-reason"));
});

test("non-object payloads are rejected for every family", () => {
  assert.ok(!validatePayload("heartbeat", null).ok);
  assert.ok(!validatePayload("heartbeat", "w").ok);
  assert.ok(!validatePayload("relay", []).ok);
});
