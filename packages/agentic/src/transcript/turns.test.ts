import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { TRANSCRIPT_TURN_TABLE } from "./schema.ts";
import {
  TranscriptCorruptionError,
  TranscriptLifecycleError,
  TranscriptStore,
  type TranscriptTurn,
} from "./store.ts";
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

test("recordTurns enforces the typed content-block payload invariant", () => {
  const store = newStore();
  // A TEXT block that also carries a documentReference payload — impossible per the
  // typed-content contract. Build the runtime-invalid fixture via JSON.parse (not a
  // type assertion) so a caller passing junk through an untyped boundary is exercised.
  const twoPayloads: TranscriptTurn = JSON.parse(
    '{"sequence":0,"loopIteration":0,"role":"USER","content":[{"contentType":"TEXT","text":"hi","documentReference":"d"}],"toolCalls":[]}',
  );
  assert.throws(() => store.recordTurns("job:bad", [twoPayloads], "ephemeral"), TranscriptCorruptionError);

  // A DOCUMENT block missing its documentReference payload is equally invalid.
  const missingPayload: TranscriptTurn = JSON.parse(
    '{"sequence":0,"loopIteration":0,"role":"USER","content":[{"contentType":"DOCUMENT"}],"toolCalls":[]}',
  );
  assert.throws(() => store.recordTurns("job:bad2", [missingPayload], "ephemeral"), TranscriptCorruptionError);

  // Nothing was persisted for either rejected batch.
  assert.equal(store.readTurns("job:bad").length, 0);
  assert.equal(store.readTurns("job:bad2").length, 0);
});

/** Insert a raw (possibly corrupt) turn row straight into the table, bypassing recordTurns. */
function insertRawTurn(
  store: TranscriptStore,
  db: TestDb,
  row: {
    stream: string;
    turn_sequence: number;
    loop_iteration: number;
    role: string;
    content: string;
    tool_calls: string;
    metrics: string | null;
    produced_at: number | null;
  },
): void {
  store.ensureSchema();
  db.run(
    `INSERT INTO ${TRANSCRIPT_TURN_TABLE}
       (stream, turn_sequence, loop_iteration, role, content, tool_calls, metrics, produced_at, recorded_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      row.stream,
      row.turn_sequence,
      row.loop_iteration,
      row.role,
      row.content,
      row.tool_calls,
      row.metrics,
      row.produced_at,
      "2026-01-01T00:00:00.000Z",
    ],
  );
}

const rawTurn = {
  stream: "job:corrupt",
  turn_sequence: 0,
  loop_iteration: 0,
  role: "USER",
  content: "[]",
  tool_calls: "[]",
  metrics: null,
  produced_at: null,
};

test("readTurns fails fast on a corrupt role", () => {
  const store = new TranscriptStore(db);
  insertRawTurn(store, db, { ...rawTurn, role: "WIZARD" });
  assert.throws(() => store.readTurns("job:corrupt"), TranscriptCorruptionError);
});

test("readTurns fails fast on a corrupt turn_sequence", () => {
  const store = new TranscriptStore(db);
  insertRawTurn(store, db, { ...rawTurn, turn_sequence: -1 });
  assert.throws(() => store.readTurns("job:corrupt"), TranscriptCorruptionError);
});

test("readTurns fails fast on a corrupt produced_at", () => {
  const store = new TranscriptStore(db);
  insertRawTurn(store, db, { ...rawTurn, produced_at: -5 });
  assert.throws(() => store.readTurns("job:corrupt"), TranscriptCorruptionError);
});

test("readTurns fails fast on corrupt (non-numeric) metrics", () => {
  const store = new TranscriptStore(db);
  insertRawTurn(store, db, { ...rawTurn, metrics: JSON.stringify({ inputTokens: "lots" }) });
  assert.throws(() => store.readTurns("job:corrupt"), TranscriptCorruptionError);
});

test("readTurns fails fast on a corrupt content-block payload", () => {
  const store = new TranscriptStore(db);
  insertRawTurn(store, db, {
    ...rawTurn,
    content: JSON.stringify([{ contentType: "TEXT", documentReference: "d" }]),
  });
  assert.throws(() => store.readTurns("job:corrupt"), TranscriptCorruptionError);
});

test("readTurns fails fast on a negative / fractional metric (not just non-numeric)", () => {
  const store = new TranscriptStore(db);
  const metrics = {
    inputTokens: -1,
    outputTokens: 0,
    reasoningTokenCount: 0,
    cacheCreationTokenCount: 0,
    cacheReadTokenCount: 0,
    durationMs: 0,
  };
  insertRawTurn(store, db, { ...rawTurn, metrics: JSON.stringify(metrics) });
  assert.throws(() => store.readTurns("job:corrupt"), TranscriptCorruptionError);
});

test("readTurns re-raises malformed JSON as a corruption error, not a SyntaxError", () => {
  const store = new TranscriptStore(db);
  insertRawTurn(store, db, { ...rawTurn, content: "{not json" });
  assert.throws(() => store.readTurns("job:corrupt"), TranscriptCorruptionError);
});

test("recordTurns rejects a non-array content / toolCalls at the untyped boundary", () => {
  const store = newStore();
  // A caller passing runtime-invalid data through an untyped boundary: content is not an
  // array. Build the fixture via JSON.parse (not a type assertion) and expect a clear
  // corruption error, never a raw TypeError from `.map`.
  const badContent: TranscriptTurn = JSON.parse(
    '{"sequence":0,"loopIteration":0,"role":"USER","content":{},"toolCalls":[]}',
  );
  assert.throws(() => store.recordTurns("job:bad3", [badContent], "ephemeral"), TranscriptCorruptionError);

  const badToolCalls: TranscriptTurn = JSON.parse(
    '{"sequence":0,"loopIteration":0,"role":"USER","content":[],"toolCalls":"nope"}',
  );
  assert.throws(() => store.recordTurns("job:bad4", [badToolCalls], "ephemeral"), TranscriptCorruptionError);

  assert.equal(store.readTurns("job:bad3").length, 0);
  assert.equal(store.readTurns("job:bad4").length, 0);
});

test("recordTurns re-raises a non-JSON-serialisable payload (bigint) as a corruption error", () => {
  const store = newStore();
  // `bigint` is assignable to an OBJECT block's `unknown` payload but makes JSON.stringify
  // throw a raw TypeError. The store must re-raise it inside its own error taxonomy and
  // leave nothing persisted.
  const turn: TranscriptTurn = {
    sequence: 0,
    loopIteration: 0,
    role: "ASSISTANT",
    content: [{ contentType: "OBJECT", object: 10n }],
    toolCalls: [],
  };
  assert.throws(() => store.recordTurns("job:bigint", [turn], "ephemeral"), TranscriptCorruptionError);
  assert.equal(store.readTurns("job:bigint").length, 0);
});

test("recordTurns rejects a non-plain (class-instance-like) object at the untyped boundary", () => {
  const store = newStore();
  // A value that is an object but not a plain/null-prototype one (here, one whose prototype
  // is another object — the same shape a `Date`/`Map` instance presents). Left unchecked it
  // would serialise into a non-object and make the stored turn unreadable, so recordTurns
  // must reject it up front. `Object.create` returns `any`, so no type assertion is needed.
  const inheritedProto: Record<string, unknown> = { inherited: true };
  const nonPlainArgs: Record<string, unknown> = Object.create(inheritedProto);
  nonPlainArgs.path = "report.pdf";
  const turn: TranscriptTurn = {
    sequence: 0,
    loopIteration: 0,
    role: "ASSISTANT",
    content: [],
    toolCalls: [{ toolCallId: "call-1", toolName: "read", arguments: nonPlainArgs }],
  };
  assert.throws(() => store.recordTurns("job:nonplain", [turn], "ephemeral"), TranscriptCorruptionError);
  assert.equal(store.readTurns("job:nonplain").length, 0);
});
