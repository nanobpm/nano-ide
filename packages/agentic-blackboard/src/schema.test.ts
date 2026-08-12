import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { BLACKBOARD_SCHEMA_SQL, BLACKBOARD_TABLE } from "./schema.ts";
import { BlackboardStore } from "./store.ts";
import { openTestDb } from "./test-db.ts";

/**
 * Normalise SQL for a drift comparison: drop `-- …` line comments, collapse all
 * runs of whitespace to a single space, and trim. Two DDL scripts that create the
 * same objects with the same columns normalise identically regardless of
 * comments/indentation.
 */
function normaliseSql(sql: string): string {
  return sql
    .split("\n")
    .map((line) => line.replace(/--.*$/, ""))
    .join("\n")
    .replace(/\s+/g, " ")
    .trim();
}

const migrationPath = fileURLToPath(new URL("../../../db/migrations/003_agentic_blackboard.sql", import.meta.url));

test("the boot migration and BlackboardStore's DDL do not drift", () => {
  const migrationSql = readFileSync(migrationPath, "utf8");
  assert.equal(
    normaliseSql(migrationSql),
    normaliseSql(BLACKBOARD_SCHEMA_SQL),
    "db/migrations/003_agentic_blackboard.sql must match BLACKBOARD_SCHEMA_SQL — update both together",
  );
});

test("the boot migration is forward-only and additive (IF NOT EXISTS, no drops/alters)", () => {
  const migrationSql = readFileSync(migrationPath, "utf8");
  assert.match(migrationSql, /CREATE TABLE IF NOT EXISTS agentic_blackboard/);
  assert.doesNotMatch(migrationSql, /\bDROP\b/i);
  assert.doesNotMatch(migrationSql, /\bALTER\b/i);
});

test("the migration takes prefix 003, after S2's 001 and S6's 002", () => {
  // Numbering is a shared epic surface (see migration header). Guard the prefix so
  // a rebase that renumbers is caught here rather than at merge time.
  assert.match(migrationPath, /\/003_agentic_blackboard\.sql$/);
});

test("ensureSchema creates the blackboard table idempotently", () => {
  const db = openTestDb();
  const store = new BlackboardStore(db);
  store.ensureSchema();
  store.ensureSchema();
  const tables = db.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type='table' AND name = ?", [
    BLACKBOARD_TABLE,
  ]);
  assert.equal(tables.length, 1);
  db.close();
});
