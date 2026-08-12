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

test("relay requires stream, non-negative integer offset, and string chunk", () => {
  assert.ok(validatePayload("relay", { stream: "s", offset: 0, chunk: "" }).ok);
  assert.ok(!validatePayload("relay", { stream: "s", offset: -1, chunk: "" }).ok);
  assert.ok(!validatePayload("relay", { stream: "s", offset: 1.5, chunk: "" }).ok);
  assert.ok(!validatePayload("relay", { stream: "", offset: 0, chunk: "" }).ok);
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
