import assert from "node:assert/strict";
import { test } from "node:test";
import { type ActivationKey, StaleIncarnationError } from "./adapter.ts";
import type { SessionEvent } from "./events.ts";
import { InMemorySessionLog, type SessionLog, SqliteSessionLog } from "./log.ts";
import { SessionBackend } from "./backend.ts";
import { openTestDb } from "./test-db.ts";

const KEY: ActivationKey = { processInstanceKey: "pik-1", elementId: "implement-task" };
const LEDGER = [{ id: "eff-1", kind: "git-push", detail: { ref: "feat/x" } }];

function seqIds(prefix: string): () => string {
  let n = 0;
  return () => `${prefix}-${n++}`;
}

function msg(id: string, parentId: string | null, text: string): SessionEvent {
  return { type: "assistant", id, parentId, text };
}

interface Harness {
  readonly name: string;
  /** A fresh shared log (persists across incarnations of the same activation). */
  makeLog(): SessionLog;
}

const HARNESSES: readonly Harness[] = [
  { name: "in-memory", makeLog: () => new InMemorySessionLog() },
  {
    name: "sqlite",
    makeLog: () => {
      const log = new SqliteSessionLog(openTestDb());
      log.ensureSchema();
      return log;
    },
  },
];

for (const h of HARNESSES) {
  test(`[${h.name}] emit* → checkpoint → restore reproduces the seed at the checkpoint offset`, () => {
    const log = h.makeLog();
    const backend = new SessionBackend(log, KEY, 1, { newCheckpointId: seqIds("cp") });

    const e0 = backend.emit(msg("e0", null, "a"));
    const e1 = backend.emit(msg("e1", "e0", "b"));
    const e2 = backend.emit(msg("e2", "e1", "c"));
    assert.deepEqual([e0.offset, e1.offset, e2.offset], [0, 1, 2]);

    const cp = backend.checkpoint("sha-abc", LEDGER);
    assert.equal(cp.offset, 3, "checkpoint pins the current next offset");
    assert.equal(cp.incarnation, 1);
    assert.deepEqual(cp.effectLedger, LEDGER);

    // A dead-tail event emitted after the checkpoint must NOT appear in the seed.
    backend.emit(msg("e3", "e2", "d"));

    const seed = backend.restore();
    assert.deepEqual(seed.checkpoint, cp);
    assert.equal(seed.nextOffset, 3);
    assert.deepEqual(seed.events, [e0, e1, e2], "seed is exactly the log up to the checkpoint offset");
  });

  test(`[${h.name}] restore repositions the cursor so a resume overwrites the uncommitted tail`, () => {
    const log = h.makeLog();
    const backend = new SessionBackend(log, KEY, 1, { newCheckpointId: seqIds("cp") });
    backend.emit(msg("e0", null, "a"));
    backend.emit(msg("e1", "e0", "b"));
    backend.checkpoint("sha", LEDGER); // offset 2
    backend.emit(msg("e2-dead", "e1", "dead")); // uncommitted tail at offset 2

    backend.restore(); // cursor back to 2
    const replacement = backend.emit(msg("e2-live", "e1", "live"));
    assert.equal(replacement.offset, 2);

    // The authoritative log now holds the live event, not the dead one.
    const all = log.replay(KEY, 0);
    assert.deepEqual(all.map((e) => e.id), ["e0", "e1", "e2-live"]);
    assert.equal(log.nextOffset(KEY), 3);
  });

  test(`[${h.name}] restore of a session with no checkpoint yields a fresh seed`, () => {
    const log = h.makeLog();
    const backend = new SessionBackend(log, KEY, 1);
    backend.emit(msg("e0", null, "a"));
    const seed = backend.restore();
    assert.deepEqual(seed, { checkpoint: null, events: [], nextOffset: 0 });
  });

  test(`[${h.name}] restore(id) resolves a specific earlier checkpoint`, () => {
    const log = h.makeLog();
    const backend = new SessionBackend(log, KEY, 1, { newCheckpointId: seqIds("cp") });
    backend.emit(msg("e0", null, "a"));
    const cp0 = backend.checkpoint("sha0", LEDGER); // offset 1
    backend.emit(msg("e1", "e0", "b"));
    const cp1 = backend.checkpoint("sha1", LEDGER); // offset 2

    assert.deepEqual(backend.restore().checkpoint, cp1, "no arg → latest");
    assert.deepEqual(backend.restore(cp0.id).checkpoint, cp0, "id → that checkpoint");
    assert.equal(backend.restore(cp0.id).events.length, 1);
  });

  test(`[${h.name}] the incarnation fence rejects a stale writer`, () => {
    const log = h.makeLog();
    const inc1 = new SessionBackend(log, KEY, 1);
    inc1.emit(msg("e0", null, "a"));

    // A re-lease at a higher incarnation fences the prior one.
    const inc2 = new SessionBackend(log, KEY, 2);
    assert.throws(() => inc1.emit(msg("stale", "e0", "x")), StaleIncarnationError);
    assert.throws(() => inc1.checkpoint("sha", LEDGER), StaleIncarnationError);

    // The current incarnation still writes fine.
    const ok = inc2.emit(msg("e1", "e0", "b"));
    assert.equal(ok.incarnation, 2);
  });

  test(`[${h.name}] constructing a stale incarnation throws at lease time`, () => {
    const log = h.makeLog();
    void new SessionBackend(log, KEY, 5);
    assert.throws(() => new SessionBackend(log, KEY, 3), StaleIncarnationError);
  });
}

test("[sqlite] the fence high-water is durable across a fresh store (restart)", () => {
  const db = openTestDb();
  const first = new SqliteSessionLog(db);
  first.ensureSchema();
  const inc1 = new SessionBackend(first, KEY, 1);
  inc1.emit(msg("e0", null, "a"));

  // A brand-new store over the same DB (a process restart) leases at inc 2.
  const revived = new SqliteSessionLog(db);
  const inc2 = new SessionBackend(revived, KEY, 2);
  inc2.emit(msg("e1", "e0", "b"));

  // The original in-process writer is now fenced by the persisted high-water.
  assert.throws(() => inc1.emit(msg("zombie", "e0", "z")), StaleIncarnationError);
  db.close();
});

test("[sqlite] a resumed incarnation replays the durable seed across a restart", () => {
  const db = openTestDb();
  const first = new SqliteSessionLog(db);
  first.ensureSchema();
  const inc1 = new SessionBackend(first, KEY, 1, { newCheckpointId: seqIds("cp") });
  const a = inc1.emit(msg("e0", null, "a"));
  const b = inc1.emit(msg("e1", "e0", "b"));
  inc1.checkpoint("sha", LEDGER); // offset 2

  const revived = new SqliteSessionLog(db);
  const inc2 = new SessionBackend(revived, KEY, 2);
  const seed = inc2.restore();
  assert.deepEqual(seed.events, [a, b]);
  assert.equal(seed.nextOffset, 2);
});
