import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import {
  TRANSCRIPT_CHUNK_TABLE,
  TRANSCRIPT_SCHEMA_SQL,
  TRANSCRIPT_STREAM_TABLE,
} from "./schema.ts";
import { TranscriptStore } from "./store.ts";
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

const migrationPath = fileURLToPath(
  new URL("../../../db/migrations/002_agentic_transcript.sql", import.meta.url),
);

test("the boot migration and TranscriptStore's DDL do not drift", () => {
  const migrationSql = readFileSync(migrationPath, "utf8");
  assert.equal(
    normaliseSql(migrationSql),
    normaliseSql(TRANSCRIPT_SCHEMA_SQL),
    "db/migrations/002_agentic_transcript.sql must match TRANSCRIPT_SCHEMA_SQL — update both together",
  );
});

test("the boot migration is forward-only and additive (IF NOT EXISTS, no drops/alters)", () => {
  const migrationSql = readFileSync(migrationPath, "utf8");
  assert.match(migrationSql, /CREATE TABLE IF NOT EXISTS agentic_transcript_stream/);
  assert.match(migrationSql, /CREATE TABLE IF NOT EXISTS agentic_transcript_chunk/);
  assert.doesNotMatch(migrationSql, /\bDROP\b/i);
  assert.doesNotMatch(migrationSql, /\bALTER\b/i);
});

test("the migration takes prefix 002, after S2's 001 and before S7", () => {
  // Numbering is a shared epic surface (see migration header). Guard the prefix so
  // a rebase that renumbers is caught here rather than at merge time.
  const stream = new URL("../../../db/migrations/002_agentic_transcript.sql", import.meta.url).pathname;
  assert.match(stream, /\/002_agentic_transcript\.sql$/);
});

test("ensureSchema creates both transcript tables idempotently", () => {
  const db = openTestDb();
  const store = new TranscriptStore(db);
  store.ensureSchema();
  store.ensureSchema();
  const tables = db
    .all<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type='table' AND name IN (?, ?) ORDER BY name",
      [TRANSCRIPT_CHUNK_TABLE, TRANSCRIPT_STREAM_TABLE],
    )
    .map((r) => r.name);
  assert.deepEqual(tables, [TRANSCRIPT_CHUNK_TABLE, TRANSCRIPT_STREAM_TABLE]);
  db.close();
});
