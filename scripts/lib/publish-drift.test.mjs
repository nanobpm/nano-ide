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
import { cmpVersion, findPublishDrift, isAheadOfNpm, isNpmNotPublishedError, settlePublishDrift, versionPathspec } from "./publish-drift.mjs";

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

// #582 — npm's read path lags a successful publish by minutes, so the terminal assertion in
// release.yml (run seconds after publish) saw the OLD version and turned a good release red.
// settlePublishDrift re-polls ONLY the drifted packages, with bounded backoff, before giving up.
const fresh = (npmVersion) => [{ name: "@x/a", version: "0.95.0", private: false, npmVersion, ageHours: 0 }];

test("#582: a version that becomes visible on npm within the settle window is NOT drift", async () => {
	const seen = ["0.94.2", "0.94.2", "0.95.0"]; // stale, stale, then propagated
	const slept = [];
	const r = await settlePublishDrift(fresh("0.94.2"), {
		graceHours: 0,
		settleMs: 300_000,
		refetch: async () => seen.shift(),
		sleep: async (ms) => slept.push(ms),
	});
	assert.equal(r.ok, true);
	assert.equal(slept.length, 3);
});

test("#582: a version that never reaches npm still fails once the window is spent", async () => {
	let t = 0;
	let elapsed = 0;
	let polls = 0;
	const r = await settlePublishDrift(fresh("0.94.2"), {
		graceHours: 0,
		settleMs: 60_000,
		now: () => t,
		refetch: async () => {
			polls++;
			return "0.94.2";
		},
		sleep: async (ms) => {
			elapsed += ms;
			t += ms;
		},
	});
	assert.equal(r.ok, false);
	assert.equal(r.drifted[0].npmVersion, "0.94.2");
	assert.ok(elapsed <= 60_000, `waited ${elapsed}ms, beyond the window`);
	assert.ok(polls >= 2, "re-polled more than once");
});

test("#582: no drift → no waiting; settleMs 0 → today's single-shot behaviour", async () => {
	let slept = 0;
	const sleep = async () => {
		slept++;
	};
	const refetch = async () => {
		throw new Error("must not refetch");
	};
	assert.equal((await settlePublishDrift(fresh("0.95.0"), { graceHours: 0, settleMs: 300_000, refetch, sleep })).ok, true);
	assert.equal((await settlePublishDrift(fresh("0.94.2"), { graceHours: 0, settleMs: 0, refetch, sleep })).ok, false);
	assert.equal(slept, 0);
});

test("#582: only drifted packages are re-polled", async () => {
	const polled = [];
	const pkgs = [
		{ name: "@x/ok", version: "1.0.0", private: false, npmVersion: "1.0.0", ageHours: 0 },
		{ name: "@x/lag", version: "2.0.0", private: false, npmVersion: "1.9.0", ageHours: 0 },
	];
	const r = await settlePublishDrift(pkgs, {
		graceHours: 0,
		settleMs: 30_000,
		refetch: async (name) => {
			polled.push(name);
			return "2.0.0";
		},
		sleep: async () => {},
	});
	assert.equal(r.ok, true);
	assert.deepEqual(polled, ["@x/lag"]);
});

// The settle budget is a wall-clock DEADLINE on an injectable clock, not a sum of requested
// sleeps: time spent inside slow `refetch` calls (and the sleeps themselves) counts against
// `settleMs`, and no new poll is scheduled once the deadline has passed. Otherwise a 300s
// window over slow `npm view` responses stretches well past five minutes.
test("settle budget counts wall-clock refetch time, not just requested sleeps", async () => {
	let t = 0;
	const now = () => t;
	let polls = 0;
	const r = await settlePublishDrift(fresh("0.94.2"), {
		graceHours: 0,
		settleMs: 60_000,
		now,
		refetch: async () => {
			polls++;
			t += 25_000; // a slow `npm view` burns 25s of the window per poll
			return "0.94.2";
		},
		sleep: async (ms) => {
			t += ms;
		},
	});
	assert.equal(r.ok, false);
	// 5s sleep + 25s refetch + 10s sleep + 25s refetch = 60s: the deadline is then spent, so
	// the loop must stop instead of scheduling the next (20s) poll the old sum-of-sleeps
	// budget (which had only "spent" 15s) would have allowed.
	assert.equal(polls, 2);
	assert.ok(t >= 60_000);
});

test("a refetch that returns after the deadline stops the loop immediately", async () => {
	let t = 0;
	const now = () => t;
	let polls = 0;
	const r = await settlePublishDrift(fresh("0.94.2"), {
		graceHours: 0,
		settleMs: 10_000,
		now,
		refetch: async () => {
			polls++;
			t += 120_000; // the very first refetch alone overruns the whole window
			return "0.94.2";
		},
		sleep: async (ms) => {
			t += ms;
		},
	});
	assert.equal(r.ok, false);
	assert.equal(polls, 1);
});

// The deadline is enforced on the whole CONCURRENT round, not per serial refetch: a slow
// `npm view` for one lagging package must not push the NEXT package's refetch past the
// deadline. Starting the round's refetches together bounds it by the slowest single call,
// so N lagging packages cannot overrun the window by N npm timeouts.
test("a lagging refetch that crosses the deadline stops subsequent polling rounds", async () => {
	let t = 0;
	const now = () => t;
	const polled = [];
	const pkgs = [
		{ name: "@x/lag1", version: "2.0.0", private: false, npmVersion: "1.0.0", ageHours: 0 },
		{ name: "@x/lag2", version: "2.0.0", private: false, npmVersion: "1.0.0", ageHours: 0 },
		{ name: "@x/lag3", version: "2.0.0", private: false, npmVersion: "1.0.0", ageHours: 0 },
	];
	const r = await settlePublishDrift(pkgs, {
		graceHours: 0,
		settleMs: 30_000,
		now,
		refetch: async (name) => {
			polled.push(name);
			t += 120_000; // each lagging refetch alone overruns the whole window
			return null;
		},
		sleep: async (ms) => {
			t += ms;
		},
	});
	assert.equal(r.ok, false);
	// All three refetches of the round start TOGETHER at t=5000 (right after the first 5s
	// backoff) — none starts after the previous one's 120s pushed t past the deadline — and
	// once the round settles past the deadline, no further poll is scheduled.
	assert.deepEqual(polled.sort(), ["@x/lag1", "@x/lag2", "@x/lag3"]);
	assert.equal(polled.length, 3, "the deadline stops the NEXT poll; the started round runs out");
});

// The FINAL partial-backoff interval must still end in a poll AT the deadline: a version that
// propagates during that last gap (e.g. visible at 270s of a 300s window) is inside the advertised
// settle window and must NOT be reported as drift. Without the deadline poll the loop sleeps the
// whole final gap and gives up at the deadline having last polled at ~255s.
test("a version propagating during the final partial-backoff gap is caught by the deadline poll", async () => {
	let t = 0;
	const now = () => t;
	const pollTimes = [];
	const r = await settlePublishDrift(fresh("0.94.2"), {
		graceHours: 0,
		settleMs: 300_000,
		now,
		refetch: async () => {
			pollTimes.push(t);
			// Propagates at 270s — after the last mid-window poll (~255s) but before the 300s deadline.
			return t >= 270_000 ? "0.95.0" : "0.94.2";
		},
		sleep: async (ms) => {
			t += ms;
		},
	});
	assert.equal(r.ok, true, "propagation at 270s is within the 300s window and must be detected");
	// The deadline poll happens at t=300000 (the clamped final wait lands exactly on the deadline).
	assert.equal(pollTimes[pollTimes.length - 1], 300_000);
});

// The FINAL poll must refresh EVERY still-lagging package, not just the first: a release publishes
// several workspaces, and if two packages both propagate during the final gap, refreshing only one
// leaves the other's stale `npmVersion` in place and turns a successful multi-package release red.
// The refetches start CONCURRENTLY, so refreshing N packages does not serially accumulate N npm
// timeouts past the deadline either.
test("the final deadline poll refreshes every lagging package, so all final-gap propagations pass", async () => {
	let t = 0;
	const now = () => t;
	const polled = [];
	const pkgs = [
		{ name: "@x/lag1", version: "2.0.0", private: false, npmVersion: "1.0.0", ageHours: 0 },
		{ name: "@x/lag2", version: "2.0.0", private: false, npmVersion: "1.0.0", ageHours: 0 },
		{ name: "@x/lag3", version: "2.0.0", private: false, npmVersion: "1.0.0", ageHours: 0 },
	];
	const r = await settlePublishDrift(pkgs, {
		graceHours: 0,
		settleMs: 5_000,
		now,
		refetch: async (name) => {
			polled.push(name);
			return "2.0.0"; // all three propagated during the final gap
		},
		sleep: async (ms) => {
			t += ms;
		},
	});
	assert.equal(r.ok, true, "all three propagated within the window — the release must go green");
	assert.deepEqual(polled.sort(), ["@x/lag1", "@x/lag2", "@x/lag3"]);
});

// Each poll's refetches start CONCURRENTLY: a slow `npm view` for one lagging package must not
// delay, or push past the deadline, the refetch of the next lagging package in the same round.
// Serial refetches would let N lagging packages overrun the window by N npm timeouts. (The
// injected clock only advances when a refetch RETURNS, so a serial implementation would show
// lag2 starting at 125000 — after lag1's 120s — instead of together at 5000.)
test("a poll's lagging refetches start concurrently, so one slow refetch does not delay the rest", async () => {
	let t = 0;
	const now = () => t;
	const started = [];
	const pkgs = [
		{ name: "@x/lag1", version: "2.0.0", private: false, npmVersion: "1.0.0", ageHours: 0 },
		{ name: "@x/lag2", version: "2.0.0", private: false, npmVersion: "1.0.0", ageHours: 0 },
		{ name: "@x/lag3", version: "2.0.0", private: false, npmVersion: "1.0.0", ageHours: 0 },
	];
	const r = await settlePublishDrift(pkgs, {
		graceHours: 0,
		settleMs: 30_000,
		now,
		refetch: async (name) => {
			started.push({ name, at: t });
			// Yield so the other refetches of this round record their start BEFORE the clock
			// advances — with a synchronous clock, only genuine concurrency starts them all at
			// the same instant.
			await Promise.resolve();
			t += 120_000; // each refetch alone overruns the whole window
			return null;
		},
		sleep: async (ms) => {
			t += ms;
		},
	});
	assert.equal(r.ok, false);
	// All three refetches of the first poll start at the same instant (t=5000, right after the
	// first 5s backoff sleep) — none waits for the previous one's 120s to elapse.
	assert.deepEqual(started, [
		{ name: "@x/lag1", at: 5_000 },
		{ name: "@x/lag2", at: 5_000 },
		{ name: "@x/lag3", at: 5_000 },
	]);
});

// The refetch callback receives the remaining settle budget so the caller can bound its
// subprocess: `npm view` must not hang unboundedly past the deadline. Mid-window the budget is
// the time left to the deadline; the FINAL poll (which starts AT the deadline) gets a small,
// defined allowance instead of 0 — it is the poll that closes the window and must be able to run.
test("refetch receives a bounded budget: remaining time mid-window, a defined allowance at the deadline", async () => {
	let t = 0;
	const now = () => t;
	const budgets = [];
	const r = await settlePublishDrift(fresh("0.94.2"), {
		graceHours: 0,
		settleMs: 10_000,
		now,
		refetch: async (_name, opts) => {
			budgets.push({ at: t, budgetMs: opts?.budgetMs });
			return "0.94.2";
		},
		sleep: async (ms) => {
			t += ms;
		},
	});
	assert.equal(r.ok, false);
	// First poll at t=5000 of a 10s window: 5000ms remain.
	assert.deepEqual(budgets[0], { at: 5_000, budgetMs: 5_000 });
	// The final poll starts AT the deadline (t=10000): remaining is 0, so it gets the defined
	// final-poll allowance instead — bounded, never 0 (a 0 budget would make the deadline poll
	// impossible) and never unbounded.
	const last = budgets[budgets.length - 1];
	assert.equal(last.at, 10_000);
	assert.ok(last.budgetMs > 0, "the deadline poll needs a positive allowance to run at all");
	assert.ok(last.budgetMs <= 30_000, `final-poll allowance ${last.budgetMs}ms must stay small`);
	for (const b of budgets) {
		assert.ok(Number.isFinite(b.budgetMs), `budgetMs must always be finite, got ${b.budgetMs}`);
	}
});

// A NON-final `setTimeout` may wake LATE (event-loop stall, a busy CI runner): the loop then
// finds itself past the deadline with no final poll intended. It must BREAK there — not start
// another refetch round. Otherwise the recomputed remaining budget is 0, which the production
// caller hands to `execFile(..., { timeout: 0 })` — and a 0 timeout DISABLES the subprocess
// bound, so the supposedly bounded guard can hang indefinitely after the settle deadline.
test("an overslept non-final sleep breaks the loop instead of starting an unbounded refetch", async () => {
	let t = 0;
	const now = () => t;
	const budgets = [];
	const r = await settlePublishDrift(fresh("0.94.2"), {
		graceHours: 0,
		settleMs: 10_000,
		now,
		refetch: async (_name, opts) => {
			budgets.push(opts?.budgetMs);
			return "0.94.2";
		},
		sleep: async (ms) => {
			// The first (non-final) 5s sleep wakes 20s late — the deadline (10s) is crossed
			// inside an ORDINARY sleep, with no final poll scheduled for it.
			t += ms + 20_000;
		},
	});
	assert.equal(r.ok, false);
	assert.equal(budgets.length, 0, `no refetch may start after an overslept non-final sleep, got budgets ${JSON.stringify(budgets)}`);
});

// The oversleep guard must not swallow the INTENTIONAL final poll: when the clamped backoff
// sleep is meant to run to the deadline (finalPoll), waking late still takes that one closing
// poll — a version can have propagated during the final gap, and the poll is bounded by the
// final-poll allowance, never by a 0/unbounded budget.
test("an overslept FINAL sleep still takes the bounded deadline poll", async () => {
	let t = 0;
	const now = () => t;
	const budgets = [];
	const r = await settlePublishDrift(fresh("0.94.2"), {
		graceHours: 0,
		settleMs: 5_000,
		now,
		refetch: async (_name, opts) => {
			budgets.push({ at: t, budgetMs: opts?.budgetMs });
			return "0.95.0"; // propagated during the final gap
		},
		sleep: async (ms) => {
			// The clamped final wait IS the whole 5s budget (finalPoll); it wakes 20s late.
			t += ms + 20_000;
		},
	});
	assert.equal(r.ok, true, "the final deadline poll still runs when its sleep oversleeps");
	assert.equal(budgets.length, 1);
	assert.ok(budgets[0].budgetMs > 0 && budgets[0].budgetMs <= 30_000, `final-poll allowance must stay bounded, got ${budgets[0].budgetMs}`);
});
