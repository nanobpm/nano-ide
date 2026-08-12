import assert from "node:assert/strict";
import { test } from "node:test";
import { openTestDb } from "./test-db.ts";

/**
 * The in-memory test adapter must mirror the Node host adapter's `wrapNodeSqlite`
 * exactly: it rejects unsupported SQLite parameter types (including `undefined`)
 * instead of silently coercing them, so a test can never pass on a parameter
 * production would throw on.
 */
test("openTestDb rejects unsupported SQLite parameter types like the host adapter", () => {
  const db = openTestDb();
  try {
    db.exec("CREATE TABLE t (v)");
    assert.throws(() => db.run("INSERT INTO t (v) VALUES (?)", [{}]), TypeError);
    assert.throws(() => db.run("INSERT INTO t (v) VALUES (?)", [undefined]), TypeError);
    assert.throws(() => db.run("INSERT INTO t (v) VALUES (?)", [Symbol("x")]), TypeError);
  } finally {
    db.close();
  }
});

test("openTestDb accepts the SQLite-native parameter types", () => {
  const db = openTestDb();
  try {
    db.exec("CREATE TABLE t (v)");
    db.run("INSERT INTO t (v) VALUES (?)", ["s"]);
    db.run("INSERT INTO t (v) VALUES (?)", [1]);
    db.run("INSERT INTO t (v) VALUES (?)", [10n]);
    db.run("INSERT INTO t (v) VALUES (?)", [null]);
    db.run("INSERT INTO t (v) VALUES (?)", [true]);
    db.run("INSERT INTO t (v) VALUES (?)", [new Uint8Array([1, 2])]);
    const rows = db.all<{ n: number }>("SELECT COUNT(*) AS n FROM t");
    assert.equal(rows[0]?.n, 6);
  } finally {
    db.close();
  }
});
