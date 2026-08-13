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

/**
 * `all()` must return the driver's row objects verbatim, exactly like the host
 * `wrapNodeSqlite`. A JSON clone would mangle `Uint8Array` blobs into plain
 * objects (and throw outright on `bigint`), so guard that blobs round-trip as
 * real `Uint8Array` instances.
 */
test("openTestDb.all returns Uint8Array blobs intact, like the host adapter", () => {
  const db = openTestDb();
  try {
    db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, blob BLOB)");
    db.run("INSERT INTO t (id, blob) VALUES (?, ?)", [1, new Uint8Array([1, 2, 3])]);
    const rows = db.all<{ blob: Uint8Array }>("SELECT blob FROM t WHERE id = ?", [1]);
    assert.ok(rows[0]?.blob instanceof Uint8Array);
    assert.deepEqual([...(rows[0]?.blob ?? [])], [1, 2, 3]);
  } finally {
    db.close();
  }
});
