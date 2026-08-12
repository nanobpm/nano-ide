import assert from "node:assert/strict";
import { test } from "node:test";
import { checkMigrationFilenames, migrationPrefix } from "./migration-order.mjs";

test("migrationPrefix extracts the numeric prefix", () => {
	assert.equal(migrationPrefix("001_agentic_presence.sql"), "001");
	assert.equal(migrationPrefix("42_thing.sql"), "42");
});

test("migrationPrefix rejects names without a numeric prefix", () => {
	assert.equal(migrationPrefix("agentic_presence.sql"), null);
	assert.equal(migrationPrefix("001-agentic.sql"), null); // must be `_`-separated
	assert.equal(migrationPrefix("001_.sql"), null); // needs a description
});

test("a well-ordered set passes", () => {
	const result = checkMigrationFilenames([
		"001_agentic_presence.sql",
		"002_agentic_transcript.sql",
		"003_agentic_blackboard.sql",
	]);
	assert.equal(result.ok, true);
	assert.deepEqual(result.duplicates, []);
	assert.deepEqual(result.malformed, []);
});

test("two migrations sharing a prefix are flagged as a collision", () => {
	const result = checkMigrationFilenames([
		"001_agentic_presence.sql",
		"002_agentic_transcript.sql",
		"002_agentic_blackboard.sql", // the wave-2 collision
	]);
	assert.equal(result.ok, false);
	assert.deepEqual(result.duplicates, [
		{ prefix: "2", files: ["002_agentic_blackboard.sql", "002_agentic_transcript.sql"] },
	]);
});

test("zero-padding differences still collide (01 vs 001)", () => {
	const result = checkMigrationFilenames(["001_a.sql", "01_b.sql"]);
	assert.equal(result.ok, false);
	assert.equal(result.duplicates.length, 1);
	assert.deepEqual(result.duplicates[0].files, ["001_a.sql", "01_b.sql"]);
});

test("malformed migration names are reported", () => {
	const result = checkMigrationFilenames(["001_ok.sql", "oops.sql"]);
	assert.equal(result.ok, false);
	assert.deepEqual(result.malformed, ["oops.sql"]);
});

test("non-sql siblings are ignored", () => {
	const result = checkMigrationFilenames(["001_ok.sql", "README.md", ".gitkeep"]);
	assert.equal(result.ok, true);
});

test("an empty migrations set is fine", () => {
	assert.equal(checkMigrationFilenames([]).ok, true);
});
