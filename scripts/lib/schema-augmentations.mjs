// Pure detection logic for the "no @nanobpm/nano-app-schema augmentation" guard,
// extracted so it can be unit-tested (see schema-augmentations.test.mjs) and reused by
// scripts/check-schema-augmentations.mjs — one source of truth for the rule.
//
// The App-manifest shape is owned by the canonical @nanobpm/nano-app-schema package
// (ADR 0027). A local `declare module "@nanobpm/nano-app-schema"` augmentation lets a
// field pass editor/type checks while the published JSON Schema still rejects it. Pending
// fields must instead be threaded as runtime-side local types read off the raw manifest
// (see the `api` binding / NetworkConfig in packages/urban).

import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

// Matches `declare module '@nanobpm/nano-app-schema'` and the double-quoted form, with any
// run of whitespace between tokens.
const AUGMENTATION_RE = /declare\s+module\s+['"]@nanobpm\/nano-app-schema['"]/;

/** True when a single line augments the schema module. */
export function lineAugmentsSchema(line) {
	return AUGMENTATION_RE.test(line);
}

/**
 * Scan a source file's text and return the 1-based line numbers (with trimmed text) that
 * augment `@nanobpm/nano-app-schema`. Empty array ⇒ clean.
 */
export function findSchemaAugmentations(source) {
	const offenders = [];
	source.split("\n").forEach((line, i) => {
		if (lineAugmentsSchema(line)) {
			offenders.push({ line: i + 1, text: line.trim() });
		}
	});
	return offenders;
}

/**
 * Recursively collect authored `.ts` files (including `.d.ts`) under `dir`, skipping
 * `node_modules` and `dist`. Returns absolute paths. A missing `dir` yields `[]`.
 */
export function collectTsFiles(dir) {
	const out = [];
	let entries = [];
	try {
		entries = readdirSync(dir, { withFileTypes: true });
	} catch (err) {
		if (err && err.code === "ENOENT") return out;
		throw err;
	}
	for (const entry of entries) {
		if (entry.name === "node_modules" || entry.name === "dist") continue;
		const full = join(dir, entry.name);
		if (entry.isDirectory()) {
			out.push(...collectTsFiles(full));
		} else if (entry.isFile() && entry.name.endsWith(".ts")) {
			out.push(full);
		}
	}
	return out;
}

/**
 * Walk every package under `packagesDir` and report schema-augmentation offenders across
 * all authored TS — not just `packages/*​/src`, since authored `.d.ts` files also live in
 * sibling folders (e.g. `packages/*​/types`). Offender paths are relative to `repoRoot`.
 */
export function collectPackageSchemaAugmentations(packagesDir, repoRoot) {
	const offenders = [];
	for (const pkg of readdirSync(packagesDir, { withFileTypes: true })) {
		if (!pkg.isDirectory()) continue;
		const pkgDir = join(packagesDir, pkg.name);
		for (const file of collectTsFiles(pkgDir)) {
			for (const { line, text } of findSchemaAugmentations(readFileSync(file, "utf8"))) {
				offenders.push({ file: relative(repoRoot, file), line, text });
			}
		}
	}
	return offenders;
}
