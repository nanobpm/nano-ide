// Pure logic for the publish-drift guard (scripts/check-publish-drift.mjs) and
// the shared numeric version comparison scripts/publish.mjs also uses.
//
// The defect this guards: when a package fix merges to `main`, release-please
// bumps its version, but the actual `npm publish` in release.yml can silently
// fail (a missing Trusted Publisher 404, an OIDC/auth/network hiccup, a brand-new
// package). The version on `main` then sits ahead of npm and consumers stay
// frozen on the old, broken version with no signal — the only symptom a
// downstream runtime error days later (issue #423, triggered by #421). A red run
// on release.yml is necessary-but-not-sufficient: nobody watches a workflow that
// "usually" fails partway and still publishes most packages.
//
// This module is the single source of truth for "is `main`'s version ahead of
// npm?": both scripts/publish.mjs (its idempotent skip logic) and the drift
// guard derive their npm-vs-local comparison from `cmpVersion` here, so the two
// can never disagree about which versions are missing from npm (no drift
// surface — AGENTS.md §"Derivation Over Duplication").

/**
 * Compare two dotted numeric version strings (`major.minor.patch`). Returns a
 * negative number when `a < b`, zero when equal, positive when `a > b`. Missing
 * trailing components count as 0, so `1.2` == `1.2.0`.
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
export function cmpVersion(a, b) {
	const pa = a.split(".").map(Number);
	const pb = b.split(".").map(Number);
	for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
		const d = (pa[i] ?? 0) - (pb[i] ?? 0);
		if (d !== 0) return d;
	}
	return 0;
}

/**
 * True when `main`'s intended version is strictly ahead of what is on npm — i.e.
 * a merged version that npm has not caught up to. A `null` `npmVersion` means the
 * package name has never been published (npm 404), which is the strongest form
 * of "ahead". npm being equal or ahead is normal (a local checkout may lag) and
 * is never drift.
 * @param {string} localVersion — the `package.json` version on `main`.
 * @param {string | null} npmVersion — the latest version on npm, or `null` when unpublished.
 * @returns {boolean}
 */
export function isAheadOfNpm(localVersion, npmVersion) {
	if (npmVersion === null || npmVersion === "") return true;
	return cmpVersion(localVersion, npmVersion) > 0;
}

/**
 * @typedef {Object} PackageState
 * @property {string} name — the npm package name.
 * @property {string} version — the `package.json` version on `main`.
 * @property {boolean} [private] — a private package is never published; skipped.
 * @property {string | null} npmVersion — latest version on npm, or `null` when unpublished.
 * @property {number | null} [ageHours] — hours since this version landed on `main`
 *   (the age of the commit that introduced the current version literal), or `null`
 *   when unknown. Used only to tolerate an in-flight release via the grace window.
 */

/**
 * @typedef {Object} DriftEntry
 * @property {string} name
 * @property {string} version — the version `main` intends to ship.
 * @property {string | null} npmVersion — latest version actually on npm.
 * @property {number | null} ageHours
 */

/**
 * Find public workspace packages whose `main` version has not reached npm.
 *
 * A package is flagged when its `main` version is strictly ahead of npm AND
 * (either no grace window is configured, or its version is known to have landed
 * on `main` longer ago than the grace window). The grace window tolerates a
 * release that is legitimately still in flight; an unknown age (`ageHours` null)
 * is treated conservatively as "old enough to flag" so a drift is never hidden
 * by missing git history.
 *
 * @param {PackageState[]} packages
 * @param {number} [graceHours=0] — tolerate a version < this many hours old.
 * @returns {{ ok: boolean, drifted: DriftEntry[] }}
 */
export function findPublishDrift(packages, graceHours = 0) {
	const drifted = [];
	for (const p of packages) {
		if (p.private) continue;
		if (!isAheadOfNpm(p.version, p.npmVersion)) continue;
		const age = p.ageHours ?? null;
		// Only a *known* age below the grace window earns tolerance; an unknown
		// age is not an excuse to hide a real drift.
		if (graceHours > 0 && age !== null && age < graceHours) continue;
		drifted.push({
			name: p.name,
			version: p.version,
			npmVersion: p.npmVersion ?? null,
			ageHours: age,
		});
	}
	return { ok: drifted.length === 0, drifted };
}
