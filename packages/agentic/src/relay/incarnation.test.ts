import assert from "node:assert/strict";
import { test } from "node:test";
import { IncarnationFence } from "./incarnation.ts";

test("admits the first producer and records its incarnation", () => {
  const fence = new IncarnationFence();
  assert.equal(fence.current("s"), undefined);
  assert.equal(fence.admit("s", 3), true);
  assert.equal(fence.current("s"), 3);
});

test("admits the same incarnation repeatedly", () => {
  const fence = new IncarnationFence();
  fence.admit("s", 5);
  assert.equal(fence.admit("s", 5), true);
  assert.equal(fence.current("s"), 5);
});

test("a strictly higher incarnation takes over (advances the mark)", () => {
  const fence = new IncarnationFence();
  fence.admit("s", 1);
  assert.equal(fence.admit("s", 2), true);
  assert.equal(fence.current("s"), 2);
});

test("a stale (lower) incarnation is fenced and does not move the mark", () => {
  const fence = new IncarnationFence();
  fence.admit("s", 5);
  assert.equal(fence.admit("s", 4), false);
  assert.equal(fence.current("s"), 5);
});

test("fencing is per-stream", () => {
  const fence = new IncarnationFence();
  fence.admit("a", 9);
  assert.equal(fence.admit("b", 1), true);
  assert.equal(fence.current("a"), 9);
  assert.equal(fence.current("b"), 1);
});

test("forget clears a stream's mark", () => {
  const fence = new IncarnationFence();
  fence.admit("s", 7);
  fence.forget("s");
  assert.equal(fence.current("s"), undefined);
  assert.equal(fence.admit("s", 1), true); // a fresh start is admitted
});

test("rejects a negative or non-integer incarnation", () => {
  const fence = new IncarnationFence();
  assert.throws(() => fence.admit("s", -1), RangeError);
  assert.throws(() => fence.admit("s", 1.5), RangeError);
});
