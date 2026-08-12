import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
// Import the real S5 relay ring from source so this package's tests need no
// prebuilt relay dist. The store flushes exactly this resume-from-offset source.
import { ReplayRing } from "@nanobpm/agentic-relay/source";
import { TranscriptStore } from "./store.ts";
import { openTestDb, type TestDb } from "./test-db.ts";

let db: TestDb;
afterEach(() => db.close());
beforeEach(() => {
  db = openTestDb();
});

test("acceptance: an ephemeral run flushes the S5 ring to a durable, readable transcript on completion", () => {
  const store = new TranscriptStore(db);
  store.ensureSchema();

  // A short ephemeral run produces terminal output into an S5 replay ring.
  const ring = new ReplayRing({ capacity: 1024 });
  const produced = ["$ npm test\n", "ok 1 - boots\n", "ok 2 - flushes\n", "# pass 2\n"];
  for (const line of produced) ring.append(line);

  // On job completion the ring is flushed to a durable transcript.
  const flushed = store.flush("run-42", ring, "ephemeral");
  assert.equal(flushed, produced.length);

  const meta = store.get("run-42");
  assert.equal(meta?.lifecycle, "ephemeral");
  assert.equal(meta?.status, "completed", "an ephemeral flush completes the transcript");
  assert.equal(meta?.nextOffset, ring.nextOffset);

  // The transcript is durable and readable: full, in order, reconstructable.
  assert.deepEqual(
    store.read("run-42").map((c) => c.chunk),
    produced,
  );
  // Durability across a fresh store handle over the same DB (no in-memory state).
  const reopened = new TranscriptStore(db);
  assert.deepEqual(
    reopened.read("run-42").map((c) => c.chunk).join(""),
    produced.join(""),
  );
});

test("acceptance: a long-lived stream reattaches from offset across a consumer reconnect", () => {
  const store = new TranscriptStore(db);
  store.ensureSchema();

  const ring = new ReplayRing({ capacity: 1024 });
  const emit = (chunk: string) => {
    const entry = ring.append(chunk);
    // Long-lived: persist incrementally as the live stream advances.
    store.record("session-1", [{ offset: entry.offset, chunk: entry.chunk }], "long-lived");
  };

  emit("line-0\n");
  emit("line-1\n");
  emit("line-2\n");

  // A consumer that saw through offset 1 reconnects and reattaches from offset 2.
  const resume = store.since("session-1", 2);
  assert.equal(resume.gap, false);
  assert.deepEqual(
    resume.entries.map((e) => e.chunk),
    ["line-2\n"],
  );
  assert.equal(resume.nextOffset, 3);

  // The stream keeps advancing after the reattach; a from-0 reattach still works.
  emit("line-3\n");
  const full = store.since("session-1", 0);
  assert.equal(full.gap, false);
  assert.deepEqual(
    full.entries.map((e) => e.offset),
    [0, 1, 2, 3],
  );
  assert.equal(full.nextOffset, 4);
});

test("flush advances nextOffset to the ring's high-water mark even when early chunks were evicted", () => {
  const store = new TranscriptStore(db);
  store.ensureSchema();

  // A small ring evicts its head: 5 produced, capacity 3 → only offsets 2,3,4 retained.
  const ring = new ReplayRing({ capacity: 3 });
  for (let i = 0; i < 5; i++) ring.append(`chunk-${i}`);
  assert.equal(ring.nextOffset, 5);
  assert.equal(ring.firstOffset, 2);

  const flushed = store.flush("run-evict", ring, "ephemeral");
  assert.equal(flushed, 3);

  const meta = store.get("run-evict");
  // The durable window is exactly what the ring still retained…
  assert.equal(meta?.firstOffset, 2);
  // …but nextOffset reflects everything ever produced, so reattach gap accounting
  // downstream stays correct.
  assert.equal(meta?.nextOffset, 5);

  // A reattach from an evicted offset reports a gap (retention lost those chunks).
  const slice = store.since("run-evict", 0);
  assert.equal(slice.gap, true);
  assert.deepEqual(
    slice.entries.map((e) => e.offset),
    [2, 3, 4],
  );
});
