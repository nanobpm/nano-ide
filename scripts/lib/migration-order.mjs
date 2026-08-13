// Pure helpers for validating the ordering of `db/migrations/*.sql`.
//
// Migrations are forward-only and applied in lexical filename order (the
// DataLayer runner lists `*.sql` and `.sort()`s them — see
// packages/urban/src/runtime/core/modules/dataops.ts). The numeric prefix is
// therefore load-bearing: it decides the apply order and is the file's identity
// on the shared `_urban_migrations` ledger.
//
// The failure mode this guards against: two branches that fork off the same
// state each pick "the next free prefix N" independently and both emit
// `N_*.sql`. Each PR is green in isolation, but once both land the repo has two
// migrations sharing prefix N — a non-deterministic apply order and a semantic
// collision that no single PR's CI exercises. (This is exactly the wave-2
// collision flagged for epic #124: S2/S6/S7 had to be hand-sequenced 001/002/003
// to avoid it.) A machine can catch the class up front — so it should.

const MIGRATION_NAME = /^(\d+)_.+\.sql$/;

/**
 * Extract the numeric prefix of a migration filename, or `null` when the name
 * does not match the `NNN_description.sql` convention.
 * @param {string} filename
 * @returns {string | null}
 */
export function migrationPrefix(filename) {
	const m = MIGRATION_NAME.exec(filename);
	return m ? m[1] : null;
}

/**
 * Validate a set of migration filenames.
 * @param {string[]} filenames — bare filenames (not paths).
 * @returns {{
 *   ok: boolean,
 *   duplicates: { prefix: string, files: string[] }[],
 *   malformed: string[],
 * }}
 */
export function checkMigrationFilenames(filenames) {
	const byPrefix = new Map();
	const malformed = [];

	for (const name of filenames) {
		if (!name.endsWith(".sql")) continue; // ignore non-SQL siblings (README, etc.)
		const prefix = migrationPrefix(name);
		if (prefix === null) {
			malformed.push(name);
			continue;
		}
		// Normalise so `01` and `001` collide (both sort as the "first" migration).
		const key = String(Number(prefix));
		const group = byPrefix.get(key) ?? [];
		group.push(name);
		byPrefix.set(key, group);
	}

	const duplicates = [];
	for (const [key, files] of byPrefix) {
		if (files.length > 1) {
			duplicates.push({ prefix: key, files: files.slice().sort() });
		}
	}
	duplicates.sort((a, b) => Number(a.prefix) - Number(b.prefix));
	malformed.sort();

	return { ok: duplicates.length === 0 && malformed.length === 0, duplicates, malformed };
}
