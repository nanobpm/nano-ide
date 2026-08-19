import assert from "node:assert/strict";
import { test } from "node:test";
import type { TestContext } from "node:test";
import type { ActivationKey } from "./adapter.ts";
import type { SessionEvent } from "./events.ts";
import { StaleIncarnationError } from "./adapter.ts";
import type { SessionCheckpoint } from "./adapter.ts";
import { InMemorySessionLog, SessionLogCorruptionError, type SqliteDb, SqliteSessionLog } from "./log.ts";
import { SESSION_CHECKPOINT_TABLE, SESSION_EVENT_TABLE, SESSION_LOG_TABLE } from "./schema.ts";
import { openTestDb } from "./test-db.ts";

const KEY: ActivationKey = { processInstanceKey: "pik", elementId: "el" };

function ev(id: string, offset: number): SessionEvent {
  return { type: "user", id, parentId: offset === 0 ? null : `e${offset - 1}`, text: `t${offset}` };
}

function checkpoint(overrides: Partial<SessionCheckpoint> = {}): SessionCheckpoint {
  return {
    id: "c0",
    offset: 0,
    commitSha: "sha",
    effectLedger: [],
    incarnation: 1,
    at: new Date(0).toISOString(),
    ...overrides,
  };
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
  { name: "in-memory", open: (_t: TestContext) => new InMemorySessionLog() },
  {
    name: "sqlite",
    open: (t: TestContext) => {
      const log = new SqliteSessionLog(openTestDb(t));
      log.ensureSchema();
      return log;
    },
  },
]) {
  test(`[${make.name}] replay rejects an invalid 'to' bound just like 'from'`, (t) => {
    const log = make.open(t);
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

test("[sqlite] the offset window (first/next) tracks stored events", (t) => {
  const db = openTestDb(t);
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
});

test("[sqlite] a durable checkpoint round-trips its effect ledger", (t) => {
  const db = openTestDb(t);
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
});

test("[sqlite] a corrupt effect ledger fails fast on read", (t) => {
  const db = openTestDb(t);
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
});

test("[sqlite] resuming into the log deletes the superseded tail rows", (t) => {
  const db = openTestDb(t);
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
});

test("[sqlite] a concurrent first-lease race fences out the stale writer", (t) => {
  // Simulate the TOCTOU window: a competing writer commits the activation row at a
  // higher incarnation just before our INSERT lands. A plain ON CONFLICT DO NOTHING
  // would let the stale lease proceed unfenced; #admit must reject it instead.
  const base = openTestDb(t);
  new SqliteSessionLog(base).ensureSchema();
  const winner = new SqliteSessionLog(base);
  let raced = false;
  const racingDb: SqliteDb = {
    exec: (sql) => base.exec(sql),
    all: (sql, params) => base.all(sql, params),
    run: (sql, params) => {
      if (!raced && /^\s*INSERT\s+INTO\s+agentic_session_log\b/i.test(sql)) {
        raced = true;
        winner.lease(KEY, 5); // a newer incarnation grabs the lease first
      }
      return base.run(sql, params);
    },
  };
  const stale = new SqliteSessionLog(racingDb);
  assert.throws(() => stale.lease(KEY, 3), StaleIncarnationError);
  assert.equal(new SqliteSessionLog(base).currentIncarnation(KEY), 5);
});

for (const make of [
  { name: "in-memory", open: (_t: TestContext) => new InMemorySessionLog() },
  {
    name: "sqlite",
    open: (t: TestContext) => {
      const log = new SqliteSessionLog(openTestDb(t));
      log.ensureSchema();
      return log;
    },
  },
]) {
  test(`[${make.name}] putCheckpoint rejects a checkpoint whose incarnation differs from the lease`, (t) => {
    const log = make.open(t);
    log.lease(KEY, 2);
    assert.throws(() => log.putCheckpoint(KEY, 2, checkpoint({ incarnation: 1 })), RangeError);
  });

  test(`[${make.name}] putCheckpoint is idempotent on checkpoint id (first-wins)`, (t) => {
    const log = make.open(t);
    log.lease(KEY, 1);
    log.putCheckpoint(KEY, 1, checkpoint({ id: "c0", offset: 1 }));
    log.putCheckpoint(KEY, 1, checkpoint({ id: "c0", offset: 2 }));
    assert.equal(log.getCheckpoint(KEY, "c0")?.offset, 1, "the first write wins; a retry never duplicates");
    assert.equal(log.latestCheckpoint(KEY)?.offset, 1);
  });
}
