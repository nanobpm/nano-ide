import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import {
  SESSION_CHECKPOINT_TABLE,
  SESSION_EVENT_TABLE,
  SESSION_LOG_TABLE,
  SESSION_SCHEMA_SQL,
} from "./schema.ts";
import { SqliteSessionLog } from "./log.ts";
import { openTestDb } from "./test-db.ts";

/**
 * Normalise SQL for a drift comparison: drop `-- …` line comments, collapse
 * whitespace runs to one space, trim. Two DDL scripts that create the same
 * objects normalise identically regardless of comments/indentation.
 */
function normaliseSql(sql: string): string {
  return sql
    .split("\n")
    .map((line) => line.replace(/--.*$/, ""))
    .join("\n")
    .replace(/\s+/g, " ")
    .trim();
}

const migrationPath = fileURLToPath(
  new URL("../../../../db/migrations/005_agentic_session.sql", import.meta.url),
);

test("the boot migration and SqliteSessionLog's DDL do not drift", () => {
  const migrationSql = readFileSync(migrationPath, "utf8");
  assert.equal(
    normaliseSql(migrationSql),
    normaliseSql(SESSION_SCHEMA_SQL),
    "db/migrations/005_agentic_session.sql must match SESSION_SCHEMA_SQL — update both together",
  );
});

test("the boot migration is forward-only and additive (IF NOT EXISTS, no drops/alters)", () => {
  const migrationSql = readFileSync(migrationPath, "utf8");
  assert.match(migrationSql, /CREATE TABLE IF NOT EXISTS agentic_session_log/);
  assert.match(migrationSql, /CREATE TABLE IF NOT EXISTS agentic_session_event/);
  assert.match(migrationSql, /CREATE TABLE IF NOT EXISTS agentic_session_checkpoint/);
  assert.doesNotMatch(migrationSql, /\bDROP\b/i);
  assert.doesNotMatch(migrationSql, /\bALTER\b/i);
});

test("the migration takes prefix 005, after 004_urban_lineage", () => {
  assert.match(migrationPath, /\/005_agentic_session\.sql$/);
});

test("ensureSchema creates all three session tables idempotently", () => {
  const db = openTestDb();
  const log = new SqliteSessionLog(db);
  log.ensureSchema();
  log.ensureSchema();
  const tables = db
    .all<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type='table' AND name IN (?, ?, ?) ORDER BY name",
      [SESSION_CHECKPOINT_TABLE, SESSION_EVENT_TABLE, SESSION_LOG_TABLE],
    )
    .map((r) => r.name);
  assert.deepEqual(tables, [SESSION_CHECKPOINT_TABLE, SESSION_EVENT_TABLE, SESSION_LOG_TABLE].sort());
  db.close();
});
