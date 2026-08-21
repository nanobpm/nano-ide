// Unit tests for the publish-drift guard's pure logic (scripts/lib/publish-drift.mjs).
// Run: node --test "scripts/lib/**/*.test.mjs"
//
// Guards issue #423: a package version bumped on `main` (release-please) whose
// `npm publish` silently failed sits ahead of npm, freezing consumers on the old
// version with no signal. The guard must flag exactly the "main ahead of npm"
// case, tolerate an in-flight release via a grace window, and never flag when npm
// is equal or ahead (a normal lagging local checkout).
import assert from "node:assert/strict";
import { test } from "node:test";
import { cmpVersion, findPublishDrift, isAheadOfNpm } from "./publish-drift.mjs";

test("cmpVersion orders dotted numeric versions", () => {
	assert.ok(cmpVersion("0.4.0", "0.1.0") > 0);
	assert.ok(cmpVersion("0.1.0", "0.4.0") < 0);
	assert.equal(cmpVersion("1.2.3", "1.2.3"), 0);
});

test("cmpVersion treats missing trailing components as zero", () => {
	assert.equal(cmpVersion("1.2", "1.2.0"), 0);
	assert.ok(cmpVersion("1.2.1", "1.2") > 0);
});

test("isAheadOfNpm is true when main is strictly ahead", () => {
	assert.equal(isAheadOfNpm("0.4.0", "0.1.0"), true);
});

test("isAheadOfNpm is true when the package was never published", () => {
	assert.equal(isAheadOfNpm("1.0.0", null), true);
	assert.equal(isAheadOfNpm("1.0.0", ""), true);
});

test("isAheadOfNpm is false when npm is equal or ahead", () => {
	assert.equal(isAheadOfNpm("0.1.0", "0.1.0"), false);
	assert.equal(isAheadOfNpm("0.1.0", "0.4.0"), false); // local checkout lags — normal
});

test("flags a package whose main version is ahead of npm", () => {
	const { ok, drifted } = findPublishDrift([
		{ name: "@nanobpm/agentic", version: "0.4.0", npmVersion: "0.1.0", ageHours: 48 },
	]);
	assert.equal(ok, false);
	assert.deepEqual(drifted, [
		{ name: "@nanobpm/agentic", version: "0.4.0", npmVersion: "0.1.0", ageHours: 48 },
	]);
});

test("flags a public package that was never published (npm 404)", () => {
	const { ok, drifted } = findPublishDrift([
		{ name: "@nanobpm/new-pkg", version: "1.0.0", npmVersion: null, ageHours: 10 },
	]);
	assert.equal(ok, false);
	assert.equal(drifted[0].name, "@nanobpm/new-pkg");
	assert.equal(drifted[0].npmVersion, null);
});

test("does not flag when npm is equal", () => {
	const { ok } = findPublishDrift([
		{ name: "a", version: "1.0.0", npmVersion: "1.0.0", ageHours: 100 },
	]);
	assert.equal(ok, true);
});

test("does not flag when npm is ahead of the local checkout", () => {
	const { ok } = findPublishDrift([
		{ name: "a", version: "1.0.0", npmVersion: "1.1.0", ageHours: 100 },
	]);
	assert.equal(ok, true);
});

test("skips private packages entirely", () => {
	const { ok } = findPublishDrift([
		{ name: "internal", version: "9.9.9", private: true, npmVersion: null, ageHours: 999 },
	]);
	assert.equal(ok, true);
});

test("tolerates a drift newer than the grace window (in-flight release)", () => {
	const { ok } = findPublishDrift(
		[{ name: "a", version: "0.4.0", npmVersion: "0.1.0", ageHours: 2 }],
		6,
	);
	assert.equal(ok, true);
});

test("flags a drift older than the grace window", () => {
	const { ok, drifted } = findPublishDrift(
		[{ name: "a", version: "0.4.0", npmVersion: "0.1.0", ageHours: 12 }],
		6,
	);
	assert.equal(ok, false);
	assert.equal(drifted.length, 1);
});

test("an unknown age is not hidden by the grace window", () => {
	// ageHours null (e.g. shallow history) must be flagged, not silently tolerated.
	const { ok } = findPublishDrift(
		[{ name: "a", version: "0.4.0", npmVersion: "0.1.0", ageHours: null }],
		6,
	);
	assert.equal(ok, false);
});

test("grace window of 0 never tolerates (terminal release.yml assertion)", () => {
	const { ok } = findPublishDrift(
		[{ name: "a", version: "0.4.0", npmVersion: "0.1.0", ageHours: 0.01 }],
		0,
	);
	assert.equal(ok, false);
});

test("reports only the drifted packages in a mixed set", () => {
	const { ok, drifted } = findPublishDrift([
		{ name: "ok-equal", version: "1.0.0", npmVersion: "1.0.0", ageHours: 50 },
		{ name: "behind", version: "2.0.0", npmVersion: "1.0.0", ageHours: 50 },
		{ name: "priv", version: "3.0.0", private: true, npmVersion: null, ageHours: 50 },
		{ name: "unpublished", version: "0.1.0", npmVersion: null, ageHours: 50 },
	]);
	assert.equal(ok, false);
	assert.deepEqual(
		drifted.map((d) => d.name).sort(),
		["behind", "unpublished"],
	);
});

test("an empty package set is fine", () => {
	assert.equal(findPublishDrift([]).ok, true);
});
