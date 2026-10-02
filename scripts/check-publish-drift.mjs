#!/usr/bin/env node
// Fail visibly when a public workspace package's version on `main` has not
// reached npm — a merged version that was never published (issue #423).
//
// When a fix merges to `main`, release-please bumps the package version, but the
// `npm publish` in release.yml can silently fail (a missing Trusted Publisher
// 404, an OIDC/auth/network hiccup, a brand-new package). The version then sits
// ahead of npm and consumers stay frozen on the old, broken version with no
// signal — exactly what happened when `@nanobpm/agentic` and
// `@nanobpm/urban-agent-client` sat at npm 0.1.0 for an extended period (#421).
//
// This runs two ways (see .github/workflows/publish-drift.yml and release.yml):
//   - On a daily schedule, so a stuck publish is caught even with no new pushes
//     (the case that bit us: the fix merged, then nothing pushed for a while).
//   - As a terminal assertion at the end of release.yml (with --grace-hours 0),
//     so a partial-failure publish turns the run red loudly instead of
//     "completing" with a buried error.
//
// The npm-vs-local comparison is shared with scripts/publish.mjs via
// scripts/lib/publish-drift.mjs — one source of truth, no duplicated version diff.
//
// Usage:
//   node scripts/check-publish-drift.mjs [--grace-hours N] [--settle-seconds N] [--open-issue]
//
//   --grace-hours N  Tolerate a version that landed on `main` < N hours ago (an
//                    in-flight release). Default 6. Use 0 for the terminal
//                    assertion in release.yml (publish has just run — no grace).
//   --settle-seconds N  On drift, keep re-polling the drifted packages for up to N seconds
//                    before failing — npm's read path lags a fresh publish by minutes (#582).
//                    Default 0 (single shot). release.yml's terminal assertion uses 300.
//   --open-issue     On drift, open or update a tracking issue via `gh` (needs
//                    GH_TOKEN). Always still prints ::error:: and exits non-zero.

import { execFile, execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { promisify } from "node:util";
import { isNpmNotPublishedError, settlePublishDrift, versionPathspec } from "./lib/publish-drift.mjs";

const execFileAsync = promisify(execFile);

// Upper bound for a single `npm view` subprocess. Without it a hung registry/process would
// block the guard indefinitely — the settle loop's wall-clock deadline would then not actually
// bound the release assertion. Generous enough for a cold npm on a slow runner; the settle
// re-polls tighten it further to the remaining settle budget (see `refetch` below) — but NEVER
// above this cap: the settle budget is the whole remaining window (~295s of a 300s window on the
// first retry), and handing it to one subprocess raw would let a single hung query spend almost
// the entire window instead of being killed promptly and retried.
const NPM_VIEW_TIMEOUT_MS = 120_000;

/** Parse the small flag set this script accepts. */
function parseArgs(argv) {
	const opts = { graceHours: 6, settleSeconds: 0, openIssue: false };
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === "--grace-hours") {
			const n = Number(argv[++i]);
			if (!Number.isFinite(n) || n < 0) {
				console.error(`::error::--grace-hours needs a non-negative number, got "${argv[i]}"`);
				process.exit(2);
			}
			opts.graceHours = n;
		} else if (a === "--settle-seconds") {
			const n = Number(argv[++i]);
			if (!Number.isFinite(n) || n < 0) {
				console.error(`::error::--settle-seconds needs a non-negative number, got "${argv[i]}"`);
				process.exit(2);
			}
			opts.settleSeconds = n;
		} else if (a === "--open-issue") {
			opts.openIssue = true;
		} else {
			console.error(`::error::unknown argument "${a}"`);
			process.exit(2);
		}
	}
	return opts;
}

/** Run a command, returning trimmed stdout, or `null` on any failure. */
function tryOut(cmd, args, cwd) {
	try {
		return execFileSync(cmd, args, { encoding: "utf8", cwd, stdio: ["ignore", "pipe", "ignore"] }).trim();
	} catch {
		return null;
	}
}

/** Absolute directory paths of every workspace, via npm's own resolver. */
function workspaceDirs() {
	const out = tryOut("npm", ["query", ".workspace"]);
	if (out === null) {
		console.error("::error::`npm query .workspace` failed — cannot enumerate workspaces.");
		process.exit(2);
	}
	return JSON.parse(out)
		.map((w) => w.path)
		.filter(Boolean);
}

/** Latest version published on npm for `name`, or `null` only when the package
 *  has genuinely never been published (npm `E404`). Any *other* `npm view`
 *  failure (a transient outage, rate-limit, auth/OIDC/network hiccup) is NOT
 *  evidence of "unpublished": collapsing it to `null` would misreport a
 *  published package as drifted and open a false tracking issue. So we fail the
 *  whole guard loudly (exit 3) on a non-E404 error instead of returning a
 *  misleading `null`.
 *
 *  The subprocess is ALWAYS time-bounded: without an explicit `timeout` a hung
 *  registry/process would block the guard indefinitely, and the settle loop's
 *  wall-clock deadline would not actually bound the release assertion. During
 *  settle re-polling the caller hands us the remaining settle budget
 *  (`budgetMs`, from the settle loop); a subprocess killed by that bound throws
 *  ETIMEDOUT, which is a transient failure (NOT an E404) and fails loudly.
 *
 *  Genuinely ASYNCHRONOUS (promise-based `execFile`, not `execFileSync`): the
 *  settle loop refetches every lagging package with `Promise.all`, and a
 *  synchronous spawn would block the event loop until each subprocess exits —
 *  starting N "concurrent" queries strictly serially and stretching a round to
 *  N × timeout. Spawning async starts every subprocess of the round up front,
 *  so the round is bounded by the SLOWEST single query, not the SUM. */
async function npmVersionOf(name, { timeoutMs } = {}) {
	const bound = timeoutMs ?? NPM_VIEW_TIMEOUT_MS;
	try {
		const { stdout } = await execFileAsync("npm", ["view", name, "version"], {
			encoding: "utf8",
			timeout: bound,
			killSignal: "SIGTERM",
		});
		return stdout.trim();
	} catch (err) {
		const stderr = String(err?.stderr ?? "");
		if (isNpmNotPublishedError(stderr)) return null;
		const timedOut = err?.code === "ETIMEDOUT" || err?.signal === "SIGTERM" || err?.killed === true;
		console.error(
			`::error::\`npm view ${name} version\` ${timedOut ? `did not answer within ${bound}ms` : "failed"} and it is NOT an npm E404 — ` +
				`refusing to treat this as "never published", which would raise a false ` +
				`drift alarm. Fix the transient/auth failure and re-run. Underlying error:\n` +
				`${stderr.trim() || err?.message || "unknown error"}`,
		);
		process.exit(3);
	}
}

/** Hours since the commit that introduced `version` into `dir/package.json`, or
 *  `null` when git history is unavailable (e.g. a shallow checkout). The `-S`
 *  pickaxe finds the commit that changed the count of the exact version literal;
 *  `-1` (newest first) is when the current version was set. Needs full history
 *  (release.yml / the schedule check out with fetch-depth 0). The pathspec is
 *  normalized to be repo-relative (via versionPathspec) because `npm query`
 *  hands us absolute dirs, and git silently fails to match an absolute pathspec
 *  under a worktree/symlinked checkout — which would disable the grace window. */
function versionAgeHours(dir, version) {
	const iso = tryOut("git", [
		"log",
		"-1",
		"--format=%cI",
		`-S"version": "${version}"`,
		"--",
		versionPathspec(dir, process.cwd()),
	]);
	if (!iso) return null;
	const then = Date.parse(iso);
	if (Number.isNaN(then)) return null;
	return (Date.now() - then) / 3_600_000;
}

/** Build the `PackageState[]` the pure guard consumes. The per-package npm
 *  probes run CONCURRENTLY (npmVersionOf is genuinely async): with N public
 *  workspaces a serial sweep would cost up to N × NPM_VIEW_TIMEOUT_MS before the
 *  guard even starts, while a concurrent sweep is bounded by the slowest single
 *  probe. */
async function collectPackageStates(dirs) {
	const probed = await Promise.all(
		dirs.map(async (dir) => {
			let pkg;
			try {
				pkg = JSON.parse(readFileSync(`${dir}/package.json`, "utf8"));
			} catch {
				return null;
			}
			if (pkg.private) return null;
			return {
				name: pkg.name,
				version: pkg.version,
				private: false,
				npmVersion: await npmVersionOf(pkg.name),
				ageHours: versionAgeHours(dir, pkg.version),
			};
		}),
	);
	return probed.filter((s) => s !== null);
}

/** Human-readable one-liner per drifted package. */
function describe(d) {
	const npm = d.npmVersion ?? "(never published)";
	const age = d.ageHours === null ? "unknown age" : `${d.ageHours.toFixed(1)}h on main`;
	return `${d.name}: main ${d.version} → npm ${npm} (${age})`;
}

/** Open or update a tracking issue so the freeze is visible outside CI logs.
 *  Best-effort: a `gh` failure never changes the exit code (the ::error:: and
 *  non-zero exit already make the run red). Idempotent — reuses the one open
 *  issue carrying the marker instead of opening a new one every run, and edits
 *  that issue's body in place (rather than appending a comment each run) so a
 *  persistent drift keeps a single up-to-date issue instead of accreting a pile
 *  of duplicate payload comments. */
function openTrackingIssue(drifted) {
	const MARKER = "<!-- publish-drift-guard -->";
	const repo = process.env.GITHUB_REPOSITORY;
	const list = drifted.map((d) => `- \`${describe(d)}\``).join("\n");
	const runUrl =
		process.env.GITHUB_SERVER_URL && process.env.GITHUB_RUN_ID
			? `${process.env.GITHUB_SERVER_URL}/${repo}/actions/runs/${process.env.GITHUB_RUN_ID}`
			: null;
	const body =
		`${MARKER}\n` +
		`A public workspace package's version on \`main\` has not reached npm — a merged ` +
		`version was never published, freezing consumers on the old version (issue #423).\n\n` +
		`## Packages behind npm\n${list}\n\n` +
		(runUrl ? `Detected by [this run](${runUrl}).\n\n` : "") +
		`Re-run the Release workflow (or fix its publish auth/Trusted Publisher) so npm ` +
		`catches up to \`main\`. This issue auto-updates while the drift persists.`;

	// Find an existing open issue carrying the marker.
	const found = tryOut("gh", [
		"issue",
		"list",
		"--state",
		"open",
		"--search",
		`in:body ${MARKER}`,
		"--json",
		"number",
		"--limit",
		"1",
	]);
	let number = null;
	if (found) {
		try {
			number = JSON.parse(found)[0]?.number ?? null;
		} catch {
			number = null;
		}
	}

	if (number) {
		// Edit the existing issue's body in place so it stays current instead of
		// accumulating a duplicate comment on every run of a persistent drift.
		if (tryOut("gh", ["issue", "edit", String(number), "--body", body]) !== null) {
			console.log(`updated tracking issue #${number}`);
		}
	} else {
		const url = tryOut("gh", [
			"issue",
			"create",
			"--title",
			"🚨 Publish drift: a merged package version is not on npm",
			"--body",
			body,
		]);
		if (url) console.log(`opened tracking issue ${url}`);
	}
}

const opts = parseArgs(process.argv.slice(2));
const states = await collectPackageStates(workspaceDirs());
const { ok, drifted } = await settlePublishDrift(states, {
	graceHours: opts.graceHours,
	settleMs: opts.settleSeconds * 1000,
	// The settle loop hands each re-poll the remaining settle budget (`budgetMs`) — the time
	// left to the deadline mid-window, or a small defined allowance for the final poll at the
	// deadline — so a slow/hung `npm view` is killed instead of blocking the guard past the
	// advertised window. The budget is CAPPED at NPM_VIEW_TIMEOUT_MS: mid-window it is the
	// whole remaining window (~295s of a 300s window on the first retry), and passing that raw
	// would let one hung query spend almost the entire window instead of being killed promptly
	// and retried. A killed call fails loudly (exit 3), never a false "unpublished".
	refetch: async (name, { budgetMs } = {}) => {
		const timeoutMs = Math.min(budgetMs ?? NPM_VIEW_TIMEOUT_MS, NPM_VIEW_TIMEOUT_MS);
		const v = await npmVersionOf(name, { timeoutMs });
		console.log(`check:publish-drift — re-polled ${name}: npm ${v ?? "(never published)"}`);
		return v;
	},
	sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
});

if (ok) {
	console.log(
		`check:publish-drift — ${states.length} public package(s), all versions on npm ` +
			`(grace ${opts.graceHours}h, settle ${opts.settleSeconds}s). ✅`,
	);
	process.exit(0);
}

for (const d of drifted) {
	console.error(
		`::error::Publish drift — ${describe(d)}. This version merged to \`main\` but never ` +
			`reached npm; consumers are frozen on the old version. Re-run Release / fix its ` +
			`publish auth (Trusted Publisher).`,
	);
}
console.error(`\ncheck:publish-drift — ${drifted.length} package(s) ahead of npm.`);

if (opts.openIssue) openTrackingIssue(drifted);

process.exit(1);
