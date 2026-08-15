#!/usr/bin/env node
// Fail the build if the authored TS source augments the App-manifest shape via
// `declare module "@nanobpm/nano-app-schema"`. That shape is owned by the canonical
// @nanobpm/nano-app-schema package (Magikcraft/nano-bpm spec-app, ADR 0027): a local
// `declare module` lets a field pass editor/type checks while the published JSON Schema
// still rejects it — the exact drift that once hid `models.templates` from Nano Studio.
// Formalize new fields in the schema package and bump the dep, or thread a pending field
// as a runtime-side local type (see the `api` binding / `NetworkConfig` in packages/urban)
// read off the raw manifest object — never by augmenting the schema type.
//
// This guard is the single source of truth for the rule: CI runs it (`npm run
// check:schema`) and so can any developer locally, so the failure surfaces before the
// push instead of only in CI.

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { findSchemaAugmentations } from "./lib/schema-augmentations.mjs";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const packagesDir = join(repoRoot, "packages");

/** Recursively collect `.ts` files under `dir`, skipping `node_modules` and `dist`. */
function collectTsFiles(dir) {
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

const offenders = [];
for (const pkg of readdirSync(packagesDir, { withFileTypes: true })) {
	if (!pkg.isDirectory()) continue;
	const srcDir = join(packagesDir, pkg.name, "src");
	for (const file of collectTsFiles(srcDir)) {
		for (const { line, text } of findSchemaAugmentations(readFileSync(file, "utf8"))) {
			offenders.push({ file: relative(repoRoot, file), line, text });
		}
	}
}

if (offenders.length === 0) {
	console.log("check:schema — no @nanobpm/nano-app-schema augmentations. ✅");
	process.exit(0);
}

for (const { file, line, text } of offenders) {
	console.error(`${file}:${line}: ${text}`);
}
console.error(
	"::error::Do not augment @nanobpm/nano-app-schema types; formalize the field in the " +
		"schema package (spec-app) and bump the dependency, or thread it as a runtime-side local " +
		"type read off the raw manifest (see the `api` binding / NetworkConfig in packages/urban).",
);
process.exit(1);
