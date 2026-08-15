import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
	collectPackageSchemaAugmentations,
	collectTsFiles,
	findSchemaAugmentations,
	lineAugmentsSchema,
} from "./schema-augmentations.mjs";

test("flags a single-quoted declare module augmentation", () => {
	assert.equal(lineAugmentsSchema("declare module '@nanobpm/nano-app-schema' {"), true);
});

test("flags a double-quoted declare module augmentation", () => {
	assert.equal(lineAugmentsSchema('declare module "@nanobpm/nano-app-schema" {'), true);
});

test("flags irregular whitespace between tokens", () => {
	assert.equal(lineAugmentsSchema('declare   module\t"@nanobpm/nano-app-schema"{'), true);
});

test("does not flag a type-only import from the schema package", () => {
	assert.equal(
		lineAugmentsSchema('import type { AppManifest } from "@nanobpm/nano-app-schema";'),
		false,
	);
});

test("does not flag declaring an unrelated module", () => {
	assert.equal(lineAugmentsSchema('declare module "@nanobpm/nano-sdk" {'), false);
});

test("findSchemaAugmentations reports 1-based line numbers and trimmed text", () => {
	const src = [
		"import type { AppManifest } from \"@nanobpm/nano-app-schema\";",
		"",
		'  declare module "@nanobpm/nano-app-schema" {',
		"    interface AppManifest { network?: NetworkConfig }",
		"  }",
	].join("\n");
	const hits = findSchemaAugmentations(src);
	assert.deepEqual(hits, [{ line: 3, text: 'declare module "@nanobpm/nano-app-schema" {' }]);
});

test("findSchemaAugmentations returns [] for clean source", () => {
	const src = 'import type { AppManifest } from "@nanobpm/nano-app-schema";\nexport const x = 1;';
	assert.deepEqual(findSchemaAugmentations(src), []);
});

test("collectPackageSchemaAugmentations catches augmentations in .d.ts files outside src/", () => {
	const root = mkdtempSync(join(tmpdir(), "schema-aug-"));
	try {
		const packagesDir = join(root, "packages");
		// A declaration file in a sibling `types/` folder — not under `src/` — must still
		// be scanned; this is the drift surface a src-only walk would miss (issue #235 review).
		const typesDir = join(packagesDir, "connector-x", "types");
		mkdirSync(typesDir, { recursive: true });
		writeFileSync(
			join(typesDir, "augment.d.ts"),
			'declare module "@nanobpm/nano-app-schema" {\n\tinterface AppManifest { sneaky?: true }\n}\n',
		);
		// A clean file under src/ that must not be reported.
		const srcDir = join(packagesDir, "connector-x", "src");
		mkdirSync(srcDir, { recursive: true });
		writeFileSync(join(srcDir, "index.ts"), "export const ok = 1;\n");

		const offenders = collectPackageSchemaAugmentations(packagesDir, root);
		assert.equal(offenders.length, 1);
		assert.match(offenders[0].file, /connector-x[/\\]types[/\\]augment\.d\.ts$/);
		assert.equal(offenders[0].line, 1);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("collectTsFiles skips node_modules and dist and returns [] for a missing dir", () => {
	const root = mkdtempSync(join(tmpdir(), "schema-aug-walk-"));
	try {
		mkdirSync(join(root, "node_modules"), { recursive: true });
		mkdirSync(join(root, "dist"), { recursive: true });
		mkdirSync(join(root, "types"), { recursive: true });
		writeFileSync(join(root, "node_modules", "a.ts"), "export const a = 1;\n");
		writeFileSync(join(root, "dist", "b.ts"), "export const b = 1;\n");
		writeFileSync(join(root, "types", "c.d.ts"), "export const c = 1;\n");

		const files = collectTsFiles(root);
		assert.equal(files.length, 1);
		assert.match(files[0], /types[/\\]c\.d\.ts$/);
		assert.deepEqual(collectTsFiles(join(root, "does-not-exist")), []);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
