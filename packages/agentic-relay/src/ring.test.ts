import assert from "node:assert/strict";
import { test } from "node:test";
import { ReplayRing } from "./ring.ts";

test("append assigns monotonic, gap-free offsets from 0", () => {
  const ring = new ReplayRing({ capacity: 8 });
  assert.equal(ring.nextOffset, 0);
  assert.equal(ring.firstOffset, undefined);
  const a = ring.append("a");
  const b = ring.append("b");
  assert.deepEqual(a, { offset: 0, chunk: "a" });
  assert.deepEqual(b, { offset: 1, chunk: "b" });
  assert.equal(ring.nextOffset, 2);
  assert.equal(ring.firstOffset, 0);
  assert.equal(ring.size, 2);
});

test("bounded: evicts oldest but keeps offsets monotonic across eviction", () => {
  const ring = new ReplayRing({ capacity: 3 });
  for (const c of ["a", "b", "c", "d", "e"]) {
    ring.append(c);
  }
  assert.equal(ring.size, 3);
  assert.equal(ring.firstOffset, 2); // a(0), b(1) evicted
  assert.equal(ring.nextOffset, 5);
  assert.deepEqual(ring.since(0).entries.map((e) => e.offset), [2, 3, 4]);
});

test("since(from) returns the exact suffix when from is retained (resume-from-offset)", () => {
  const ring = new ReplayRing({ capacity: 8 });
  for (const c of ["a", "b", "c", "d"]) {
    ring.append(c);
  }
  const slice = ring.since(2);
  assert.equal(slice.gap, false);
  assert.deepEqual(slice.entries, [
    { offset: 2, chunk: "c" },
    { offset: 3, chunk: "d" },
  ]);
});

test("since(from) flags a gap when from predates the retained window", () => {
  const ring = new ReplayRing({ capacity: 2 });
  for (const c of ["a", "b", "c", "d"]) {
    ring.append(c); // retains offsets 2,3
  }
  const slice = ring.since(0);
  assert.equal(slice.gap, true);
  assert.deepEqual(slice.entries.map((e) => e.offset), [2, 3]);
});

test("since(from) at the head returns empty with no gap", () => {
  const ring = new ReplayRing({ capacity: 4 });
  ring.append("a");
  ring.append("b");
  const slice = ring.since(2); // caller already has everything
  assert.equal(slice.gap, false);
  assert.deepEqual(slice.entries, []);
});

test("since(from) beyond nextOffset returns empty (consumer ahead of stream)", () => {
  const ring = new ReplayRing({ capacity: 4 });
  ring.append("a");
  const slice = ring.since(10);
  assert.equal(slice.gap, false);
  assert.deepEqual(slice.entries, []);
});

test("since on an empty ring returns empty with no gap", () => {
  const ring = new ReplayRing({ capacity: 4 });
  const slice = ring.since(0);
  assert.equal(slice.gap, false);
  assert.deepEqual(slice.entries, []);
});

test("clear drops retained chunks but keeps the offset counter monotonic", () => {
  const ring = new ReplayRing({ capacity: 4 });
  ring.append("a");
  ring.append("b");
  ring.clear();
  assert.equal(ring.size, 0);
  assert.equal(ring.firstOffset, undefined);
  const c = ring.append("c");
  assert.equal(c.offset, 2); // not reset to 0
});

test("rejects a non-positive or non-integer capacity", () => {
  assert.throws(() => new ReplayRing({ capacity: 0 }), RangeError);
  assert.throws(() => new ReplayRing({ capacity: -1 }), RangeError);
  assert.throws(() => new ReplayRing({ capacity: 2.5 }), RangeError);
});

test("rejects a negative or non-integer since(from)", () => {
  const ring = new ReplayRing({ capacity: 4 });
  assert.throws(() => ring.since(-1), RangeError);
  assert.throws(() => ring.since(1.5), RangeError);
});
