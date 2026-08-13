import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { TranscriptLifecycleError, TranscriptStore } from "./store.ts";
import { TRANSCRIPT_STREAM_TABLE } from "./schema.ts";
import { openTestDb, type TestDb } from "./test-db.ts";

/** A hand-driven clock so retention/timestamps are deterministic. */
function fakeClock(start = 1_000): { now(): number; set(t: number): void } {
  let t = start;
  return { now: () => t, set: (v: number) => (t = v) };
}

let db: TestDb;
afterEach(() => db.close());
beforeEach(() => {
  db = openTestDb();
});

function newStore(opts: { retentionMs?: number; clock?: { now(): number } } = {}): TranscriptStore {
  const store = new TranscriptStore(db, {
    ephemeralRetentionMs: opts.retentionMs,
    clock: opts.clock,
  });
  store.ensureSchema();
  return store;
}

const chunks = (n: number, base = 0): { offset: number; chunk: string }[] =>
  Array.from({ length: n }, (_, i) => ({ offset: base + i, chunk: `c${base + i}` }));

test("open is idempotent and first-wins on lifecycle", () => {
  const store = newStore();
  const a = store.open("s", "ephemeral");
  assert.equal(a.lifecycle, "ephemeral");
  assert.equal(a.status, "open");
  assert.equal(a.nextOffset, 0);
  assert.equal(a.firstOffset, undefined);
  // A second open with a different lifecycle must not mutate the first.
  const b = store.open("s", "long-lived");
  assert.equal(b.lifecycle, "ephemeral");
  assert.equal(store.count(), 1);
});

test("record persists chunks and tracks the offset window", () => {
  const store = newStore();
  const written = store.record("s", chunks(3), "long-lived");
  assert.equal(written, 3);
  const meta = store.get("s");
  assert.equal(meta?.firstOffset, 0);
  assert.equal(meta?.nextOffset, 3);
  assert.deepEqual(
    store.read("s").map((c) => c.chunk),
    ["c0", "c1", "c2"],
  );
});

test("record is idempotent by (stream, offset) — re-recording writes nothing", () => {
  const store = newStore();
  store.record("s", chunks(3));
  const again = store.record("s", chunks(3));
  assert.equal(again, 0);
  assert.equal(store.read("s").length, 3);
  // Overlapping resume: offsets 2,3,4 — only 3,4 are new.
  const overlap = store.record("s", chunks(3, 2));
  assert.equal(overlap, 2);
  assert.equal(store.get("s")?.nextOffset, 5);
});

test("record rejects a non-integer / negative offset", () => {
  const store = newStore();
  assert.throws(() => store.record("s", [{ offset: -1, chunk: "x" }]), RangeError);
  assert.throws(() => store.record("s", [{ offset: 1.5, chunk: "x" }]), RangeError);
});

test("record rejects an offset at MAX_SAFE_INTEGER (nextOffset would overflow safe range)", () => {
  const store = newStore();
  assert.throws(
    () => store.record("s", [{ offset: Number.MAX_SAFE_INTEGER, chunk: "x" }]),
    RangeError,
  );
  // The rejection is before any write — the stream stays empty.
  assert.equal(store.read("s").length, 0);
});

test("record is atomic — an invalid offset after a valid one persists nothing", () => {
  const store = newStore();
  // A later invalid entry must roll back the whole batch (SAVEPOINT), so the
  // earlier valid chunk is never partially persisted and the offset window
  // metadata (first/next-offset) stays pristine.
  assert.throws(
    () =>
      store.record("s", [
        { offset: 0, chunk: "c0" },
        { offset: Number.MAX_SAFE_INTEGER, chunk: "bad" },
      ]),
    RangeError,
  );
  assert.equal(store.read("s").length, 0, "no chunk persisted from a batch that later throws");
  const meta = store.get("s");
  assert.equal(meta?.firstOffset, undefined);
  assert.equal(meta?.nextOffset, 0);
});

test("record atomicity holds on an already-populated stream", () => {
  const store = newStore();
  store.record("s", chunks(2)); // offsets 0,1
  assert.throws(
    () =>
      store.record("s", [
        { offset: 2, chunk: "c2" },
        { offset: -1, chunk: "bad" },
      ]),
    RangeError,
  );
  // The new valid chunk (offset 2) is rolled back with the failed batch; the
  // stream is left exactly as it was before the call.
  assert.deepEqual(
    store.read("s").map((c) => c.offset),
    [0, 1],
  );
  assert.equal(store.get("s")?.nextOffset, 2);
});

test("constructor rejects a non-finite / negative ephemeralRetentionMs", () => {
  assert.throws(() => new TranscriptStore(db, { ephemeralRetentionMs: Number.NaN }), RangeError);
  assert.throws(
    () => new TranscriptStore(db, { ephemeralRetentionMs: Number.POSITIVE_INFINITY }),
    RangeError,
  );
  assert.throws(() => new TranscriptStore(db, { ephemeralRetentionMs: -1 }), RangeError);
});

test("record refuses a lifecycle that mismatches an already-open stream, before writing", () => {
  const store = newStore();
  store.record("s", chunks(2), "long-lived");
  // A mismatched lifecycle must fail fast and persist nothing new.
  assert.throws(
    () => store.record("s", chunks(2, 2), "ephemeral"),
    TranscriptLifecycleError,
  );
  assert.equal(store.read("s").length, 2, "no chunks written on lifecycle mismatch");
  assert.equal(store.get("s")?.lifecycle, "long-lived");
});

test("reading a stream row with a corrupt lifecycle/status fails fast", () => {
  const store = newStore();
  db.run(
    `INSERT INTO ${TRANSCRIPT_STREAM_TABLE} (stream, lifecycle, status, created_at, next_offset)
     VALUES (?, ?, ?, ?, 0)`,
    ["bad", "bogus-lifecycle", "open", "2020-01-01T00:00:00.000Z"],
  );
  assert.throws(() => store.get("bad"), /lifecycle/);
  db.run(
    `INSERT INTO ${TRANSCRIPT_STREAM_TABLE} (stream, lifecycle, status, created_at, next_offset)
     VALUES (?, ?, ?, ?, 0)`,
    ["bad2", "ephemeral", "bogus-status", "2020-01-01T00:00:00.000Z"],
  );
  assert.throws(() => store.get("bad2"), /status/);
});

test("since reattaches from an offset with the live nextOffset", () => {
  const store = newStore();
  store.record("s", chunks(5), "long-lived");
  const slice = store.since("s", 2);
  assert.deepEqual(
    slice.entries.map((e) => e.offset),
    [2, 3, 4],
  );
  assert.equal(slice.gap, false);
  assert.equal(slice.nextOffset, 5);
});

test("since on an unknown stream is empty and gap-free", () => {
  const store = newStore();
  const slice = store.since("nope", 0);
  assert.deepEqual(slice.entries, []);
  assert.equal(slice.gap, false);
  assert.equal(slice.nextOffset, 0);
});

test("since past the head is empty (consumer already has everything), no gap", () => {
  const store = newStore();
  store.record("s", chunks(3));
  const slice = store.since("s", 3);
  assert.deepEqual(slice.entries, []);
  assert.equal(slice.gap, false);
  assert.equal(slice.nextOffset, 3);
});

test("truncateBefore drops the head and a reattach before it reports a gap", () => {
  const store = newStore();
  store.record("s", chunks(6), "long-lived");
  const dropped = store.truncateBefore("s", 3);
  assert.equal(dropped, 3);
  const meta = store.get("s");
  assert.equal(meta?.firstOffset, 3);
  assert.equal(meta?.nextOffset, 6, "nextOffset is a monotonic high-water mark, unaffected by head truncation");
  // Reattach from an evicted offset: best-effort tail + gap.
  const slice = store.since("s", 1);
  assert.equal(slice.gap, true);
  assert.deepEqual(
    slice.entries.map((e) => e.offset),
    [3, 4, 5],
  );
  // Reattach from a still-retained offset: no gap.
  assert.equal(store.since("s", 4).gap, false);
});

test("truncateBefore refuses to touch an ephemeral transcript", () => {
  const store = newStore();
  store.record("s", chunks(3), "ephemeral");
  assert.throws(() => store.truncateBefore("s", 1), TranscriptLifecycleError);
  assert.equal(store.read("s").length, 3, "ephemeral transcript is left whole");
});

test("sweep retires completed ephemeral transcripts past the retention window, keeps long-lived", () => {
  const clock = fakeClock(10_000);
  const store = newStore({ retentionMs: 1_000, clock });
  // An ephemeral run: record + complete via flush.
  store.record("eph", chunks(2), "ephemeral");
  store.flush("eph", { since: () => ({ entries: [] }), nextOffset: 2 }, "ephemeral");
  assert.equal(store.get("eph")?.status, "completed");
  // A long-lived stream: open, never completes.
  store.record("live", chunks(2), "long-lived");

  // Not yet expired (completed_at == 10_000, cutoff = now - 1_000).
  clock.set(10_500);
  assert.deepEqual(store.sweep(), []);
  assert.equal(store.count(), 2);

  // Past the window: the ephemeral transcript is retired, the long-lived one stays.
  clock.set(11_001);
  assert.deepEqual(store.sweep(), ["eph"]);
  assert.equal(store.get("eph"), undefined);
  assert.equal(store.read("eph").length, 0);
  assert.equal(store.get("live")?.lifecycle, "long-lived");
});

test("sweep is atomic — a mid-sweep delete failure rolls the whole sweep back", () => {
  const clock = fakeClock(10_000);
  // Two ephemeral streams both eligible for the sweep.
  const base = newStore({ retentionMs: 0, clock });
  base.flush("a", { since: () => ({ entries: chunks(2) }), nextOffset: 2 }, "ephemeral");
  base.flush("b", { since: () => ({ entries: chunks(2) }), nextOffset: 2 }, "ephemeral");
  assert.equal(base.count(), 2);

  // Wrap the shared connection so the stream-table DELETE throws once (a
  // simulated mid-sweep failure). Everything else delegates to the real db, so
  // the SAVEPOINT still runs against the same underlying connection.
  let boom = true;
  const faulting: TestDb = {
    exec: (sql) => db.exec(sql),
    run: (sql, params) => {
      if (boom && sql.includes(`DELETE FROM ${TRANSCRIPT_STREAM_TABLE}`)) {
        boom = false;
        throw new Error("injected mid-sweep delete failure");
      }
      return db.run(sql, params);
    },
    all: <T>(sql: string, params?: unknown[]): T[] => db.all<T>(sql, params),
    close: () => db.close(),
  };
  const store = new TranscriptStore(faulting, { ephemeralRetentionMs: 0, clock });

  clock.set(10_001);
  assert.throws(() => store.sweep(), /injected mid-sweep delete failure/);

  // Nothing was swept: both streams and all their chunks survive intact, so the
  // returned list can never claim a deletion that did not actually happen.
  const check = newStore({ retentionMs: 0, clock });
  assert.equal(check.count(), 2);
  assert.equal(check.read("a").length, 2);
  assert.equal(check.read("b").length, 2);
});

test("a fully-swept reattach is empty and gap-free (nothing was lost)", () => {
  const clock = fakeClock(0);
  const store = newStore({ retentionMs: 0, clock });
  store.flush("eph", { since: () => ({ entries: chunks(2) }), nextOffset: 2 }, "ephemeral");
  clock.set(1);
  store.sweep();
  const slice = store.since("eph", 0);
  assert.deepEqual(slice.entries, []);
  assert.equal(slice.gap, false);
});
