import assert from "node:assert/strict";
import { test } from "node:test";
import type { ActivationKey } from "./adapter.ts";
import type { SessionEvent } from "./events.ts";
import { InMemorySessionLog, SessionLogCorruptionError, SqliteSessionLog } from "./log.ts";
import { SESSION_CHECKPOINT_TABLE, SESSION_EVENT_TABLE } from "./schema.ts";
import { openTestDb } from "./test-db.ts";

const KEY: ActivationKey = { processInstanceKey: "pik", elementId: "el" };

function ev(id: string, offset: number): SessionEvent {
  return { type: "user", id, parentId: offset === 0 ? null : `e${offset - 1}`, text: `t${offset}` };
}

test("append rejects a gap (offset beyond next)", () => {
  const log = new InMemorySessionLog();
  log.lease(KEY, 1);
  assert.throws(() => log.append(KEY, 1, 1, ev("e", 1)), RangeError);
});

test("replay honours from/to bounds", () => {
  const log = new InMemorySessionLog();
  log.lease(KEY, 1);
  for (let i = 0; i < 5; i++) log.append(KEY, 1, i, ev(`e${i}`, i));
  assert.deepEqual(log.replay(KEY, 1, 3).map((e) => e.offset), [1, 2]);
  assert.deepEqual(log.replay(KEY, 3).map((e) => e.offset), [3, 4]);
  assert.deepEqual(log.replay(KEY, 0).length, 5);
});

for (const make of [
  { name: "in-memory", open: () => new InMemorySessionLog() },
  {
    name: "sqlite",
    open: () => {
      const log = new SqliteSessionLog(openTestDb());
      log.ensureSchema();
      return log;
    },
  },
]) {
  test(`[${make.name}] replay rejects an invalid 'to' bound just like 'from'`, () => {
    const log = make.open();
    log.lease(KEY, 1);
    for (let i = 0; i < 3; i++) log.append(KEY, 1, i, ev(`e${i}`, i));
    assert.throws(() => log.replay(KEY, 0, -1), RangeError, "negative to");
    assert.throws(() => log.replay(KEY, 0, 1.5), RangeError, "non-integer to");
    assert.throws(() => log.replay(KEY, 2, 1), RangeError, "to < from");
  });
}

test("latestCheckpoint returns the highest-offset checkpoint", () => {
  const log = new InMemorySessionLog();
  log.lease(KEY, 1);
  const at = new Date(0).toISOString();
  log.putCheckpoint(KEY, 1, { id: "c0", offset: 1, commitSha: "s0", effectLedger: [], incarnation: 1, at });
  log.putCheckpoint(KEY, 1, { id: "c1", offset: 4, commitSha: "s1", effectLedger: [], incarnation: 1, at });
  log.putCheckpoint(KEY, 1, { id: "c2", offset: 2, commitSha: "s2", effectLedger: [], incarnation: 1, at });
  assert.equal(log.latestCheckpoint(KEY)?.id, "c1");
  assert.equal(log.getCheckpoint(KEY, "c2")?.offset, 2);
});

test("[sqlite] the offset window (first/next) tracks stored events", () => {
  const db = openTestDb();
  const log = new SqliteSessionLog(db);
  log.ensureSchema();
  log.lease(KEY, 1);
  assert.equal(log.nextOffset(KEY), 0);
  log.append(KEY, 1, 0, ev("e0", 0));
  log.append(KEY, 1, 1, ev("e1", 1));
  assert.equal(log.nextOffset(KEY), 2);
  const row = db.all<{ first_offset: number; next_offset: number }>(
    `SELECT first_offset, next_offset FROM agentic_session_log WHERE process_instance_key = ? AND element_id = ?`,
    [KEY.processInstanceKey, KEY.elementId],
  )[0];
  assert.equal(row?.first_offset, 0);
  assert.equal(row?.next_offset, 2);
  db.close();
});

test("[sqlite] a durable checkpoint round-trips its effect ledger", () => {
  const db = openTestDb();
  const log = new SqliteSessionLog(db);
  log.ensureSchema();
  log.lease(KEY, 1);
  const ledger = [{ id: "e1", kind: "push", detail: { sha: "abc" } }];
  log.putCheckpoint(KEY, 1, {
    id: "c0",
    offset: 0,
    commitSha: "sha",
    effectLedger: ledger,
    incarnation: 1,
    at: new Date(0).toISOString(),
  });
  assert.deepEqual(log.getCheckpoint(KEY, "c0")?.effectLedger, ledger);
  db.close();
});

test("[sqlite] a corrupt effect ledger fails fast on read", () => {
  const db = openTestDb();
  const log = new SqliteSessionLog(db);
  log.ensureSchema();
  log.lease(KEY, 1);
  db.run(
    `INSERT INTO ${SESSION_CHECKPOINT_TABLE}
       (process_instance_key, element_id, checkpoint_id, checkpoint_offset, incarnation, commit_sha, effect_ledger, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [KEY.processInstanceKey, KEY.elementId, "bad", 0, 1, "sha", '{"not":"an-array"}', new Date(0).toISOString()],
  );
  assert.throws(() => log.getCheckpoint(KEY, "bad"), SessionLogCorruptionError);
  db.close();
});

test("[sqlite] resuming into the log deletes the superseded tail rows", () => {
  const db = openTestDb();
  const log = new SqliteSessionLog(db);
  log.ensureSchema();
  log.lease(KEY, 1);
  for (let i = 0; i < 4; i++) log.append(KEY, 1, i, ev(`e${i}`, i));
  // Resume: rewrite from offset 2 under a newer incarnation.
  log.lease(KEY, 2);
  log.append(KEY, 2, 2, ev("e2b", 2));
  const rows = db.all<{ n: number }>(
    `SELECT COUNT(*) AS n FROM ${SESSION_EVENT_TABLE} WHERE process_instance_key = ? AND element_id = ?`,
    [KEY.processInstanceKey, KEY.elementId],
  )[0];
  assert.equal(rows?.n, 3, "offsets 0,1,2 remain; the old 2 and 3 were dropped");
  assert.equal(log.nextOffset(KEY), 3);
  db.close();
});
