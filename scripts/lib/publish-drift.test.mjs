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
import { cmpVersion, findPublishDrift, isAheadOfNpm, isNpmNotPublishedError, versionPathspec } from "./publish-drift.mjs";

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

test("isNpmNotPublishedError recognises a genuine npm 404 (never published)", () => {
	// npm prints the E404 code on both modern (`npm error code E404`) and older
	// (`npm ERR! code E404`) CLIs — only this case means "unpublished".
	assert.equal(isNpmNotPublishedError("npm error code E404\nnpm error 404 Not Found"), true);
	assert.equal(isNpmNotPublishedError("npm ERR! code E404"), true);
});

test("isNpmNotPublishedError does NOT treat a transient failure as unpublished", () => {
	// The failure mode being guarded (issue #423): a network/rate-limit/auth hiccup
	// must never be misread as "never published" — that would raise a false drift
	// alarm and open a spurious tracking issue for a package that IS on npm.
	assert.equal(isNpmNotPublishedError("npm error code E429\nToo Many Requests"), false);
	assert.equal(isNpmNotPublishedError("npm error network request to https://registry.npmjs.org failed"), false);
	assert.equal(isNpmNotPublishedError("npm error code ETIMEDOUT"), false);
	assert.equal(isNpmNotPublishedError("npm error code E401\nUnable to authenticate"), false);
	assert.equal(isNpmNotPublishedError(""), false);
	assert.equal(isNpmNotPublishedError(null), false);
});

test("versionPathspec normalizes an absolute workspace dir to a repo-relative pathspec", () => {
	// The failure mode being guarded: `npm query .workspace` yields ABSOLUTE dirs,
	// and git silently fails to match an absolute pathspec under a worktree or
	// symlinked checkout — versionAgeHours then reads null and the grace window is
	// quietly disabled. The pathspec must be relative to the repo root git runs in.
	assert.equal(
		versionPathspec("/repo/packages/agentic", "/repo"),
		"packages/agentic/package.json",
	);
	assert.ok(!versionPathspec("/repo/packages/agentic", "/repo").startsWith("/"));
});

test("versionPathspec targets the repo-root package.json when dir is the cwd", () => {
	assert.equal(versionPathspec("/repo", "/repo"), "./package.json");
});
