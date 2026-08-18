// Determinism guard for the `assertThat*` DSL (issue #295, wave 2).
//
// The whole assertion DSL MUST be a pure function of `snapshot()` / the read
// models / an already-resolved response — never of the wall-clock or an entropy
// source. This guard scans every IMPLEMENTATION file under `src/assert/**` (the
// `*.ts` files that are not themselves tests) and fails if any of the forbidden
// non-deterministic APIs appear in real code:
//
//   • `Date.now`            — wall-clock read
//   • `setTimeout` / `setInterval` — real-time scheduling / polling
//   • `Math.random`         — entropy
//   • `performance.now`     — high-resolution wall-clock read
//
// Comments (which legitimately mention these tokens when documenting the
// determinism contract) are stripped before scanning, so only genuine code
// usage turns the guard red. Adding a wall-clock/random dependency to the DSL
// later — in any matcher or shared helper — flips this test to failing, which is
// the whole point: determinism is enforced, not merely documented.
//
// This is a NEW guard file (wave 2); it does not modify any matcher.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** The directory holding the DSL implementation + this guard. Derived from the
 *  module URL via `fileURLToPath`/`dirname` (widely-supported ESM primitives)
 *  rather than the Node-specific `import.meta.dirname`, so it works identically
 *  under `node --test` and `deno test`. */
const ASSERT_DIR = dirname(fileURLToPath(import.meta.url));

/** The forbidden non-deterministic APIs, as they appear in code. Each is matched
 *  literally against comment-stripped source. */
const FORBIDDEN: readonly { readonly token: string; readonly why: string }[] = [
  { token: "Date.now", why: "wall-clock read" },
  { token: "setTimeout", why: "real-time scheduling / polling" },
  { token: "setInterval", why: "real-time scheduling / polling" },
  { token: "Math.random", why: "entropy source" },
  { token: "performance.now", why: "high-resolution wall-clock read" },
];

/** Remove line comments and block comments so a token mentioned only in prose
 *  (e.g. the determinism-contract header every matcher carries) does not trip the
 *  guard. Deliberately simple: the DSL implementation files contain no `//`
 *  sequences inside string literals, so this cannot over-strip real code. */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

/** The implementation files under `src/assert/**`: every `.ts` that is not a
 *  test and not a `.d.ts`. Walks subdirectories recursively so nested helpers
 *  (e.g. `src/assert/utils/*.ts`) added later stay covered by the guard. Paths
 *  are returned relative to `ASSERT_DIR` (top-level files keep their bare name). */
async function implementationFiles(dir: string = ASSERT_DIR, prefix = ""): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const rel = prefix ? join(prefix, entry.name) : entry.name;
    if (entry.isDirectory()) {
      files.push(...(await implementationFiles(join(dir, entry.name), rel)));
    } else if (
      entry.isFile() &&
      entry.name.endsWith(".ts") &&
      !entry.name.endsWith(".test.ts") &&
      !entry.name.endsWith(".d.ts")
    ) {
      files.push(rel);
    }
  }
  return files.sort();
}

test("the assertion DSL implementation scans clean of wall-clock / entropy APIs", async () => {
  const files = await implementationFiles();
  // Sanity: the scan must actually cover the shipped DSL, or a clean result is
  // meaningless. The DSL is selectors + format + the four matcher files.
  assert.ok(files.length >= 6, `expected to scan the DSL implementation files, found ${files.join(", ")}`);
  for (const expected of ["selectors.ts", "format.ts", "instance.ts", "user-task.ts", "db.ts", "response.ts"]) {
    assert.ok(files.includes(expected), `determinism guard must scan ${expected}`);
  }

  const offenders: string[] = [];
  for (const name of files) {
    const source = stripComments(await readFile(join(ASSERT_DIR, name), "utf8"));
    for (const { token, why } of FORBIDDEN) {
      if (source.includes(token)) {
        offenders.push(`${name}: uses \`${token}\` (${why})`);
      }
    }
  }

  assert.deepEqual(
    offenders,
    [],
    `The assertThat* DSL must stay deterministic — no wall-clock or entropy APIs — but found:\n${offenders.join("\n")}`,
  );
});

test("the comment stripper does not mask a real forbidden call", () => {
  // Guards the guard: a token used in CODE (not a comment) must still be caught,
  // even when the same file documents the token in prose.
  const disguised = [
    "// This matcher never calls Date.now or Math.random.",
    "/* setInterval is forbidden here. */",
    "const t = setTimeout(fn, 1000); // schedule",
  ].join("\n");
  const stripped = stripComments(disguised);
  assert.ok(!stripped.includes("Math.random"), "prose mention of Math.random should be stripped");
  assert.ok(stripped.includes("setTimeout"), "a real setTimeout call must survive comment stripping");
});
