import assert from "node:assert/strict";
import { test } from "node:test";
import { BlackboardStore, isUniqueViolation, normalizeKind } from "./store.ts";
import type { Clock } from "./store.ts";
import { openTestDb } from "./test-db.ts";

function fixedClock(start = 1_000): Clock & { set(t: number): void } {
  let t = start;
  return { now: () => t, set: (v: number) => (t = v) };
}

function freshStore(clock?: Clock): BlackboardStore {
  const store = new BlackboardStore(openTestDb(), clock ? { clock } : {});
  store.ensureSchema();
  return store;
}

test("normalizeKind keeps the known kinds and defaults the rest to note", () => {
  for (const k of ["file-claim", "constraint-change", "scope-change", "learning", "note"]) {
    assert.equal(normalizeKind(k), k);
  }
  assert.equal(normalizeKind("bogus"), "note");
  assert.equal(normalizeKind(undefined), "note");
  assert.equal(normalizeKind(42), "note");
});

test("append stores an entry and read returns it in write order", () => {
  const store = freshStore();
  const a = store.append("board-1", { authorTask: "t1", kind: "note", body: "first" });
  const b = store.append("board-1", { authorTask: "t2", kind: "learning", body: "second" });
  assert.deepEqual([a.inserted, b.inserted], [true, true]);
  assert.ok(b.id > a.id);

  const entries = store.read("board-1");
  assert.deepEqual(
    entries.map((e) => [e.authorTask, e.kind, e.body]),
    [
      ["t1", "note", "first"],
      ["t2", "learning", "second"],
    ],
  );
});

test("append defaults author to 'system', normalises unknown kinds, and trims the body", () => {
  const store = freshStore();
  store.append("b", { body: "  padded  ", kind: "weird" });
  const [e] = store.read("b");
  assert.equal(e?.authorTask, "system");
  assert.equal(e?.kind, "note");
  assert.equal(e?.body, "padded");
});

test("append rejects a blank body", () => {
  const store = freshStore();
  assert.throws(() => store.append("b", { body: "   " }), /non-empty body/);
  assert.throws(() => store.append("b", { body: "" }), /non-empty body/);
  assert.equal(store.count("b"), 0);
});

test("dedupeKey makes a repeat append under the same scope a no-op", () => {
  const store = freshStore();
  const first = store.append("b", { body: "claim", dedupeKey: "k1" });
  const again = store.append("b", { body: "claim (retry)", dedupeKey: "k1" });
  assert.equal(first.inserted, true);
  assert.equal(again.inserted, false);
  assert.equal(again.id, first.id);
  assert.equal(store.count("b"), 1);
  // The original body wins — the retry did not overwrite it.
  assert.equal(store.read("b")[0]?.body, "claim");
});

test("the same dedupeKey under a DIFFERENT scope is a distinct entry", () => {
  const store = freshStore();
  const a = store.append("board-a", { body: "x", dedupeKey: "k1" });
  const b = store.append("board-b", { body: "y", dedupeKey: "k1" });
  assert.equal(a.inserted, true);
  assert.equal(b.inserted, true);
  assert.notEqual(a.id, b.id);
  assert.equal(store.count("board-a"), 1);
  assert.equal(store.count("board-b"), 1);
});

test("a dedupe-less note always appends (partial unique index excludes NULL)", () => {
  const store = freshStore();
  store.append("b", { body: "n1" });
  store.append("b", { body: "n2" });
  store.append("b", { body: "n3" });
  assert.equal(store.count("b"), 3);
});

test("readPage returns a cursor at the head even when since filters everything out", () => {
  const store = freshStore();
  store.append("b", { body: "1" });
  const second = store.append("b", { body: "2" });

  const caughtUp = store.readPage("b", { since: second.id });
  assert.deepEqual(caughtUp.entries, []);
  assert.equal(caughtUp.cursor, second.id, "cursor is the true head even with nothing new");

  const empty = store.readPage("missing-board");
  assert.deepEqual(empty.entries, []);
  assert.equal(empty.cursor, 0, "an empty board has cursor 0");
});

test("readPage since returns only entries after the cursor (incremental read)", () => {
  const store = freshStore();
  const a = store.append("b", { body: "1" });
  store.append("b", { body: "2" });
  const page = store.readPage("b", { since: a.id });
  assert.deepEqual(page.entries.map((e) => e.body), ["2"]);
});

test("reads never cross scopes", () => {
  const store = freshStore();
  store.append("board-a", { body: "a-only" });
  store.append("board-b", { body: "b-only" });
  assert.deepEqual(store.read("board-a").map((e) => e.body), ["a-only"]);
  assert.deepEqual(store.read("board-b").map((e) => e.body), ["b-only"]);
});

test("files round-trip as a decoded array, blank/whitespace entries dropped", () => {
  const store = freshStore();
  store.append("b", { kind: "file-claim", files: ["src/a.ts", "  ", "src/b.ts", ""], body: "claim" });
  const [e] = store.read("b");
  assert.deepEqual(e?.files, ["src/a.ts", "src/b.ts"]);
});

test("detectFileClaimConflicts surfaces a prior claim by another author on the same file", () => {
  const store = freshStore();
  const prior = store.append("b", { authorTask: "t1", kind: "file-claim", files: ["state.rs"], body: "t1 claims" });
  // t2 is about to claim the same file — compute conflicts as the endpoint does,
  // AFTER inserting t2's own claim, with beforeId = t2's new id.
  const mine = store.append("b", { authorTask: "t2", kind: "file-claim", files: ["state.rs"], body: "t2 claims" });
  const conflicts = store.detectFileClaimConflicts("b", { authorTask: "t2", files: ["state.rs"], beforeId: mine.id });
  assert.equal(conflicts.length, 1);
  assert.equal(conflicts[0]?.file, "state.rs");
  assert.equal(conflicts[0]?.authorTask, "t1");
  assert.equal(conflicts[0]?.id, prior.id);
});

test("detectFileClaimConflicts never reports a writer's own earlier claim", () => {
  const store = freshStore();
  store.append("b", { authorTask: "t1", kind: "file-claim", files: ["state.rs"], body: "t1 earlier" });
  const mine = store.append("b", { authorTask: "t1", kind: "file-claim", files: ["state.rs"], body: "t1 again" });
  const conflicts = store.detectFileClaimConflicts("b", { authorTask: "t1", files: ["state.rs"], beforeId: mine.id });
  assert.deepEqual(conflicts, []);
});

test("detectFileClaimConflicts ignores non-file-claim kinds and other scopes", () => {
  const store = freshStore();
  store.append("b", { authorTask: "t1", kind: "note", files: ["state.rs"], body: "just a note" });
  store.append("other", { authorTask: "t1", kind: "file-claim", files: ["state.rs"], body: "other board" });
  const conflicts = store.detectFileClaimConflicts("b", { authorTask: "t2", files: ["state.rs"] });
  assert.deepEqual(conflicts, []);
});

test("detectFileClaimConflicts with no files returns nothing", () => {
  const store = freshStore();
  store.append("b", { authorTask: "t1", kind: "file-claim", files: ["a"], body: "claim" });
  assert.deepEqual(store.detectFileClaimConflicts("b", { authorTask: "t2", files: [] }), []);
});

test("created_at comes from the injected clock", () => {
  const clock = fixedClock(0);
  const store = freshStore(clock);
  clock.set(Date.parse("2026-01-01T00:00:00.000Z"));
  store.append("b", { body: "x" });
  assert.equal(store.read("b")[0]?.createdAt, "2026-01-01T00:00:00.000Z");
});

test("isUniqueViolation matches unique/primary-key collisions but not other constraints", () => {
  assert.equal(isUniqueViolation({ code: "SQLITE_CONSTRAINT_UNIQUE" }), true);
  assert.equal(isUniqueViolation({ code: "SQLITE_CONSTRAINT_PRIMARYKEY" }), true);
  assert.equal(isUniqueViolation({ message: "UNIQUE constraint failed: agentic_blackboard.scope" }), true);
  assert.equal(isUniqueViolation({ message: "FOREIGN KEY constraint failed" }), false);
  assert.equal(isUniqueViolation(new Error("some other error")), false);
  assert.equal(isUniqueViolation(null), false);
});
