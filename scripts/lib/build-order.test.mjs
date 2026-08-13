// Unit tests for the workspace topological build order (scripts/lib/build-order.mjs).
// Run: node --test "scripts/lib/**/*.test.mjs"
//
// Guards the defect class this fix targets: npm's `--workspaces` build runs in
// directory-name order, so a package that depends on another workspace (e.g.
// agentic-blackboard -> agentic-channel, where "blackboard" sorts first) is
// built before its dependency's dist exists (TS2307). The order must be derived
// from declared deps, not names.
import { test } from "node:test";
import assert from "node:assert/strict";
import { topologicalBuildOrder } from "./build-order.mjs";

/** Assert `before` precedes `after` in the ordering. */
function precedes(order, before, after) {
	const i = order.indexOf(before);
	const j = order.indexOf(after);
	assert.ok(i !== -1, `${before} present`);
	assert.ok(j !== -1, `${after} present`);
	assert.ok(i < j, `${before} should build before ${after} (got ${order.join(", ")})`);
}

test("dependency builds before its dependent even when it sorts later by name", () => {
	// "blackboard" < "channel" alphabetically, but blackboard depends on channel.
	const order = topologicalBuildOrder([
		{ name: "agentic-protocol", hasBuild: true, deps: [] },
		{ name: "agentic-channel", hasBuild: true, deps: ["agentic-protocol"] },
		{
			name: "agentic-blackboard",
			hasBuild: true,
			deps: ["agentic-channel", "agentic-protocol"],
		},
	]);
	precedes(order, "agentic-protocol", "agentic-channel");
	precedes(order, "agentic-channel", "agentic-blackboard");
	precedes(order, "agentic-protocol", "agentic-blackboard");
});

test("transitive dependencies are ordered before dependents", () => {
	const order = topologicalBuildOrder([
		{ name: "protocol", hasBuild: true, deps: [] },
		{ name: "channel", hasBuild: true, deps: ["protocol"] },
		{ name: "relay", hasBuild: true, deps: ["channel"] },
		{ name: "transcript", hasBuild: true, deps: ["relay"] },
	]);
	assert.deepEqual(order, ["protocol", "channel", "relay", "transcript"]);
});

test("packages without a build script are excluded but still constrain order", () => {
	const order = topologicalBuildOrder([
		{ name: "base", hasBuild: false, deps: [] },
		{ name: "leaf", hasBuild: true, deps: ["base"] },
	]);
	assert.deepEqual(order, ["leaf"]);
});

test("external (non-workspace) dependencies are ignored", () => {
	const order = topologicalBuildOrder([
		{ name: "a", hasBuild: true, deps: ["typescript", "b"] },
		{ name: "b", hasBuild: true, deps: ["node:fs"] },
	]);
	precedes(order, "b", "a");
});

test("ordering is deterministic across independent nodes", () => {
	const pkgs = [
		{ name: "z", hasBuild: true, deps: [] },
		{ name: "a", hasBuild: true, deps: [] },
		{ name: "m", hasBuild: true, deps: [] },
	];
	assert.deepEqual(topologicalBuildOrder(pkgs), ["a", "m", "z"]);
	// Same input in a different array order yields the same result.
	assert.deepEqual(topologicalBuildOrder([...pkgs].reverse()), ["a", "m", "z"]);
});

test("a dependency cycle is reported, not silently mis-ordered", () => {
	assert.throws(
		() =>
			topologicalBuildOrder([
				{ name: "a", hasBuild: true, deps: ["b"] },
				{ name: "b", hasBuild: true, deps: ["a"] },
			]),
		/cycle/i,
	);
});
