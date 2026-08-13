#!/usr/bin/env node
// Fail the build if `db/migrations/` has two migrations sharing a numeric prefix
// (a duplicate-prefix merge collision) or a file that does not follow the
// `NNN_description.sql` convention. See scripts/lib/migration-order.mjs for why
// this class of mistake is invisible to any single PR's CI.

import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { checkMigrationFilenames } from "./lib/migration-order.mjs";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const migrationsDir = join(repoRoot, "db", "migrations");

let filenames = [];
try {
	filenames = readdirSync(migrationsDir);
} catch (err) {
	if (err && err.code === "ENOENT") {
		// No migrations directory yet — nothing to check.
		console.log("check:migrations — no db/migrations directory; nothing to check.");
		process.exit(0);
	}
	throw err;
}

const { ok, duplicates, malformed } = checkMigrationFilenames(filenames);

if (ok) {
	const count = filenames.filter((f) => f.endsWith(".sql")).length;
	console.log(`check:migrations — ${count} migration(s), prefixes unique and well-formed. ✅`);
	process.exit(0);
}

for (const { prefix, files } of duplicates) {
	console.error(
		`::error::Duplicate migration prefix ${prefix}: ${files.join(", ")}. ` +
			"Migrations are applied in filename order; two files sharing a prefix collide on merge. " +
			"Renumber the later one after the current highest prefix.",
	);
}
for (const name of malformed) {
	console.error(
		`::error::Malformed migration filename "${name}". ` +
			"Use the NNN_description.sql convention (e.g. 004_add_widgets.sql).",
	);
}
process.exit(1);
