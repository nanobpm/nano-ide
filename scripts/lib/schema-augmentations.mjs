// Pure detection logic for the "no @nanobpm/nano-app-schema augmentation" guard,
// extracted so it can be unit-tested (see schema-augmentations.test.mjs) and reused by
// scripts/check-schema-augmentations.mjs — one source of truth for the rule.
//
// The App-manifest shape is owned by the canonical @nanobpm/nano-app-schema package
// (ADR 0027). A local `declare module "@nanobpm/nano-app-schema"` augmentation lets a
// field pass editor/type checks while the published JSON Schema still rejects it. Pending
// fields must instead be threaded as runtime-side local types read off the raw manifest
// (see the `api` binding / NetworkConfig in packages/urban).

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
