#!/usr/bin/env node
// Build every workspace package that declares a `build` script, in dependency
// order derived from each package's own package.json.
//
// npm's `--workspaces` runner visits packages in directory-name order, NOT
// topological order, so a package that depends on another workspace can be
// built before its dependency's `dist/` exists (TS2307). Rather than maintain a
// hand-ordered prebuild prefix in the root `build` script — a drift surface that
// silently breaks whenever a new package sorts before a dependency — we derive
// the order from the single source of truth: the intra-repo dependencies each
// package already declares (see scripts/lib/build-order.mjs).

import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { topologicalBuildOrder } from "./lib/build-order.mjs";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const packagesDir = join(repoRoot, "packages");

const packages = [];
for (const entry of readdirSync(packagesDir, { withFileTypes: true })) {
	if (!entry.isDirectory()) continue;
	let pkg;
	try {
		pkg = JSON.parse(
			readFileSync(join(packagesDir, entry.name, "package.json"), "utf8"),
		);
	} catch {
		continue;
	}
	if (!pkg.name) continue;
	packages.push({
		name: pkg.name,
		hasBuild: Boolean(pkg.scripts?.build),
		deps: Object.keys({ ...pkg.dependencies, ...pkg.devDependencies }),
	});
}

const order = topologicalBuildOrder(packages);
console.log(`Building ${order.length} workspace(s) in dependency order:`);
for (const name of order) console.log(`  - ${name}`);

for (const name of order) {
	execFileSync("npm", ["run", "build", "-w", name], {
		cwd: repoRoot,
		stdio: "inherit",
	});
}
