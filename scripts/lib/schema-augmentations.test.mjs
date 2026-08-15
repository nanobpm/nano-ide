import assert from "node:assert/strict";
import { test } from "node:test";

import { findSchemaAugmentations, lineAugmentsSchema } from "./schema-augmentations.mjs";

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
