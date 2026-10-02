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

import { performance } from "node:perf_hooks";
import { relative } from "node:path";

/**
 * Build the git pathspec for a workspace's `package.json`, normalized to be
 * relative to `cwd`. `npm query .workspace` yields *absolute* directory paths
 * (see scripts/publish.mjs, which likewise normalizes with
 * `relative(process.cwd(), dir)`). Handing git an absolute pathspec is fragile —
 * it silently fails to match under a linked worktree, a `/var`↔`/private/var`
 * style symlinked checkout (macOS), or when git runs from a different cwd — so
 * `git log` returns nothing, the version age reads as unknown, and the grace
 * window is quietly disabled. A repo-relative pathspec matches reliably.
 * @param {string} dir — the (possibly absolute) workspace directory.
 * @param {string} cwd — the directory git will run from (the repo root).
 * @returns {string} a `<relative-dir>/package.json` pathspec for `git log -- …`.
 */
export function versionPathspec(dir, cwd) {
	const rel = relative(cwd, dir) || ".";
	return `${rel}/package.json`;
}

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
 * Classify a failed `npm view <name> version` from its captured stderr. npm
 * exits non-zero both when a package has genuinely never been published
 * (`E404`) and on transient failures (network outage, rate-limit, auth/OIDC
 * hiccup). Only the former means "unpublished". Treating a transient failure as
 * unpublished would raise a false drift alarm (and open a spurious tracking
 * issue), so the caller must tell the two apart rather than collapse every
 * failure to `null`.
 * @param {string} stderr — captured stderr from the failed `npm view`.
 * @returns {boolean} true only when the failure is a genuine npm 404 (never published).
 */
export function isNpmNotPublishedError(stderr) {
	return /\bE404\b/.test(String(stderr ?? ""));
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

/**
 * {@link findPublishDrift}, but tolerant of npm's read-path propagation lag (#582).
 *
 * A successful `npm publish` is not immediately visible to `npm view`: the registry's read path
 * trails it by up to a couple of minutes. The terminal assertion in release.yml runs seconds after
 * publish, so a single-shot check saw the OLD version and turned a good release red. On drift, this
 * re-polls ONLY the drifted packages with exponential backoff (5s, 10s, 20s … capped at 60s) until
 * they catch up or the `settleMs` budget is spent. A version that genuinely never published still
 * fails — just after the window. `settleMs` 0 is the original single-shot check.
 *
 * The budget is a wall-clock DEADLINE, not a sum of requested sleeps: it is measured on an
 * injectable monotonic clock (`now`, default `performance.now` — the system clock is NOT
 * monotonic, so a host clock correction must not move the deadline), so time spent inside
 * `sleep` and inside the `refetch` calls (slow `npm view` responses) counts against
 * `settleMs`. Once the deadline has passed no further poll is scheduled. Each poll refetches
 * every still-lagging package CONCURRENTLY, and each refetch is handed the remaining budget
 * (`refetch(name, { budgetMs })`) so the caller can bound its subprocess: a configured 300s
 * window cannot stretch well past five minutes just because the registry is slow, no matter
 * how many packages lag. (`budgetMs` only bounds the subprocess the caller spawns — the
 * deadline is still re-checked as soon as the poll's refetches settle, before the next poll.)
 *
 * The one exception is the FINAL poll: when the clamped backoff would consume the rest of the
 * budget, the sleep runs to the deadline and one last poll is taken AT the deadline. Without it a
 * version that propagates during that last partial-backoff gap would be reported as drift even
 * though it landed inside the advertised settle window. The final poll refreshes EVERY lagging
 * package — a release publishes several workspaces, so refreshing only the first would turn a
 * successful multi-package release red — and hands each refetch a small, defined allowance
 * (`FINAL_REFETCH_ALLOWANCE_MS`) instead of the exhausted remaining budget, so the deadline poll
 * can run but a hung `npm view` still cannot block the guard indefinitely.
 *
 * @param {PackageState[]} packages
 * @param {{ graceHours?: number, settleMs: number, refetch: (name: string, opts?: { budgetMs: number }) => Promise<string | null>,
 *           sleep: (ms: number) => Promise<void>, now?: () => number }} opts
 * @returns {Promise<{ ok: boolean, drifted: DriftEntry[] }>}
 */
// How long the FINAL poll's refetches may run past the deadline. The final poll starts AT the
// deadline (remaining budget 0), so it needs a positive allowance to run at all — but bounded,
// so a hung `npm view` during the closing poll cannot stall the release guard indefinitely.
const FINAL_REFETCH_ALLOWANCE_MS = 30_000;

export async function settlePublishDrift(packages, opts) {
	const graceHours = opts.graceHours ?? 0;
	// Default to the MONOTONIC clock: `Date.now` follows host clock corrections, which can move
	// the deadline backward (stretching the settle) or forward (ending it early). Tests inject
	// `opts.now` to drive the deadline deterministically.
	const now = opts.now ?? performance.now.bind(performance);
	const states = packages.map((p) => ({ ...p }));
	let result = findPublishDrift(states, graceHours);
	const deadline = now() + opts.settleMs;
	let delay = 5_000;
	while (!result.ok) {
		const remaining = deadline - now();
		if (remaining <= 0) break;
		// Clamp the sleep to the remaining budget. When the clamped wait consumes the WHOLE
		// remaining budget (`wait === remaining`), this sleep runs to the deadline and the poll
		// that follows is the FINAL one: a version can propagate during that last partial-backoff
		// gap, so skipping the deadline poll would falsely report it as drift even though it
		// landed inside the advertised settle window.
		const wait = Math.min(delay, 60_000, remaining);
		const finalPoll = wait >= remaining;
		await opts.sleep(wait);
		delay *= 2;
		const lagging = new Set(result.drifted.map((d) => d.name));
		// Refetch every lagging package CONCURRENTLY. Serial refetches would let one slow
		// `npm view` consume the remaining budget and then either start the later requests
		// past the deadline (overrunning the window by N npm timeouts) or skip them — and
		// skipping is not an option for the FINAL poll, which must refresh every lagging
		// package or it turns a successful multi-package release red. Starting them all at
		// once bounds the round by the SLOWEST single call, not the SUM.
		const budgetMs = finalPoll
			? // The final poll starts AT the deadline: remaining is 0, so it gets a small,
				// defined allowance — enough for the closing `npm view`, never unbounded.
				FINAL_REFETCH_ALLOWANCE_MS
			: // Mid-window, each refetch may use what is left to the deadline.
				Math.max(0, deadline - now());
		await Promise.all(
			states
				.filter((s) => lagging.has(s.name))
				.map(async (s) => {
					s.npmVersion = await opts.refetch(s.name, { budgetMs });
				}),
		);
		result = findPublishDrift(states, graceHours);
	}
	return result;
}
