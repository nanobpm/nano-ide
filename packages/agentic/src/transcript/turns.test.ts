import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { TranscriptLifecycleError, TranscriptStore, type TranscriptTurn } from "./store.ts";
import { openTestDb, type TestDb } from "./test-db.ts";

let db: TestDb;
afterEach(() => db.close());
beforeEach(() => {
  db = openTestDb();
});

function newStore(): TranscriptStore {
  const store = new TranscriptStore(db);
  store.ensureSchema();
  return store;
}

/**
 * A representative multi-turn agent run mirroring Camunda's AgentHistoryRecordValue:
 * a USER turn, an ASSISTANT turn that dispatches a tool call (with per-turn metrics),
 * and a TOOL_RESULT turn — with typed content blocks across TEXT/DOCUMENT/OBJECT and
 * two role-split turns sharing loopIteration 1.
 */
const turns: readonly TranscriptTurn[] = [
  {
    sequence: 0,
    loopIteration: 0,
    role: "USER",
    content: [{ contentType: "TEXT", text: "Summarise the attached report and return JSON." }],
    toolCalls: [],
    producedAt: 1_000,
  },
  {
    sequence: 1,
    loopIteration: 1,
    role: "ASSISTANT",
    content: [
      { contentType: "TEXT", text: "I'll fetch the report first." },
      { contentType: "DOCUMENT", documentReference: "documents/report-2026-08.pdf" },
    ],
    toolCalls: [
      {
        toolCallId: "call-abc",
        toolName: "fetchDocument",
        elementId: "Activity_fetchDoc",
        arguments: { path: "documents/report-2026-08.pdf", pages: [1, 2, 3] },
      },
    ],
    metrics: {
      inputTokens: 1200,
      outputTokens: 64,
      reasoningTokenCount: 32,
      cacheCreationTokenCount: 128,
      cacheReadTokenCount: 900,
      durationMs: 742,
    },
    producedAt: 2_000,
  },
  {
    sequence: 2,
    loopIteration: 1,
    role: "TOOL_RESULT",
    content: [{ contentType: "OBJECT", object: { pages: 3, words: 5123, sections: ["intro", "body"] } }],
    toolCalls: [],
    producedAt: 3_000,
  },
];

test("a multi-turn transcript round-trips its turn/role/tool-call/metrics structure", () => {
  const store = newStore();

  const written = store.recordTurns("job:475", turns, "ephemeral");
  assert.equal(written, turns.length);

  const read = store.readTurns("job:475");
  // The whole turn structure — loopIteration, role, typed content blocks, tool
  // calls and per-turn metrics — round-trips faithfully and in sequence order.
  assert.deepEqual(read, turns);

  // Durable across a fresh handle over the same DB (no in-memory state).
  const reopened = new TranscriptStore(db);
  assert.deepEqual(reopened.readTurns("job:475"), turns);
});

test("recordTurns is idempotent on (stream, sequence)", () => {
  const store = newStore();
  store.recordTurns("job:475", turns, "ephemeral");
  // Re-recording the same turns (a retry / overlapping reattach) persists nothing new…
  const again = store.recordTurns("job:475", turns, "ephemeral");
  assert.equal(again, 0);
  // …and never duplicates.
  assert.equal(store.readTurns("job:475").length, turns.length);
});

test("the turn view is additive — recording turns leaves the raw chunk stream intact", () => {
  const store = newStore();
  // A raw chunk reader keeps working unchanged when turns are layered on.
  store.record("job:475", [{ offset: 0, chunk: "hello\n" }], "ephemeral");
  store.recordTurns("job:475", turns, "ephemeral");

  assert.deepEqual(
    store.read("job:475").map((c) => c.chunk),
    ["hello\n"],
  );
  assert.equal(store.readTurns("job:475").length, turns.length);
  // The chunk-stream offset window is untouched by turn recording.
  assert.equal(store.get("job:475")?.nextOffset, 1);
});

test("recordTurns enforces the stream's first-wins lifecycle", () => {
  const store = newStore();
  store.recordTurns("job:475", [turns[0]], "long-lived");
  assert.throws(
    () => store.recordTurns("job:475", [turns[1]], "ephemeral"),
    TranscriptLifecycleError,
  );
});

test("recordTurns rejects an invalid sequence and rolls the whole batch back", () => {
  const store = newStore();
  const bad: TranscriptTurn = { ...turns[1], sequence: -1 };
  assert.throws(() => store.recordTurns("job:475", [turns[0], bad], "ephemeral"), RangeError);
  // Atomic: the first (valid) turn must not have been persisted.
  assert.equal(store.readTurns("job:475").length, 0);
});

test("sweep drops a completed ephemeral stream's turns along with its chunks", () => {
  const clock = { now: () => 10_000 };
  const store = new TranscriptStore(db, { ephemeralRetentionMs: 0, clock });
  store.ensureSchema();
  store.record("job:475", [{ offset: 0, chunk: "x" }], "ephemeral");
  store.recordTurns("job:475", turns, "ephemeral");
  // Complete the ephemeral stream so it becomes sweep-eligible.
  store.flush("job:475", { since: () => ({ entries: [] }), nextOffset: 1 }, "ephemeral");

  const removed = store.sweep(20_000);
  assert.deepEqual(removed, ["job:475"]);
  assert.equal(store.readTurns("job:475").length, 0);
  assert.equal(store.read("job:475").length, 0);
});
