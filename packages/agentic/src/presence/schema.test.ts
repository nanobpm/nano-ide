import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { PRESENCE_SCHEMA_SQL, PRESENCE_TABLE } from "./schema.ts";
import { PresenceStore } from "./store.ts";
import { openTestDb } from "./test-db.ts";

/**
 * Normalise SQL for a drift comparison: drop `-- …` line comments, collapse all
 * runs of whitespace to a single space, and trim. Two DDL scripts that create
 * the same objects with the same columns normalise identically regardless of
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

const migrationPath = fileURLToPath(new URL("../../../../db/migrations/001_agentic_presence.sql", import.meta.url));

test("the boot migration and PresenceStore's DDL do not drift", () => {
  const migrationSql = readFileSync(migrationPath, "utf8");
  assert.equal(
    normaliseSql(migrationSql),
    normaliseSql(PRESENCE_SCHEMA_SQL),
    "db/migrations/001_agentic_presence.sql must match PRESENCE_SCHEMA_SQL — update both together",
  );
});

test("the boot migration is forward-only and additive (IF NOT EXISTS, no drops)", () => {
  const migrationSql = readFileSync(migrationPath, "utf8");
  assert.match(migrationSql, /CREATE TABLE IF NOT EXISTS agentic_presence/);
  assert.doesNotMatch(migrationSql, /\bDROP\b/i);
  assert.doesNotMatch(migrationSql, /\bALTER\b/i);
});

test("ensureSchema creates the presence table idempotently", () => {
  const db = openTestDb();
  const store = new PresenceStore(db);
  store.ensureSchema();
  store.ensureSchema();
  const tables = db.all<{ name: string }>(
    "SELECT name FROM sqlite_master WHERE type='table' AND name = ?",
    [PRESENCE_TABLE],
  );
  assert.equal(tables.length, 1);
  db.close();
});
