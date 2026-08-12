// Derive a topological build order for workspace packages from the intra-repo
// dependencies each package declares. See scripts/build-workspaces.mjs.
//
// npm's `--workspaces` runner visits packages in directory-name order, not
// dependency order, so a dependent can be built before its dependency's dist
// exists (TS2307). This derives the order from the single source of truth
// (package.json deps) instead of a hand-maintained prebuild prefix.

/**
 * @typedef {{ name: string, hasBuild?: boolean, deps?: string[] }} PkgNode
 */

/**
 * Return the names of packages with a build script, ordered so every package
 * appears after all of its intra-repo dependencies. Deterministic: nodes and
 * edges are visited in sorted order so the output is stable across runs.
 *
 * @param {PkgNode[]} packages
 * @returns {string[]}
 * @throws {Error} on a dependency cycle among the given packages
 */
export function topologicalBuildOrder(packages) {
	const byName = new Map(packages.map((p) => [p.name, p]));
	const names = [...byName.keys()].sort();
	const edges = new Map(
		names.map((n) => [
			n,
			(byName.get(n)?.deps ?? []).filter((d) => byName.has(d)).sort(),
		]),
	);

	/** @type {string[]} */
	const order = [];
	const state = new Map();

	/** @param {string} name @param {string[]} stack */
	function visit(name, stack) {
		const s = state.get(name);
		if (s === "done") return;
		if (s === "visiting") {
			throw new Error(
				`Dependency cycle among workspace packages: ${[...stack, name].join(" -> ")}`,
			);
		}
		state.set(name, "visiting");
		for (const dep of edges.get(name) ?? []) visit(dep, [...stack, name]);
		state.set(name, "done");
		order.push(name);
	}

	for (const name of names) visit(name, []);
	return order.filter((n) => byName.get(n)?.hasBuild);
}
