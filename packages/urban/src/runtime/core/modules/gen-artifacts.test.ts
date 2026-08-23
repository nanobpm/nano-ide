// Drift gate for the generated browser-runtime artifacts, enforced INSIDE the test
// suite (which CI already runs) rather than in a workflow step. The browser runtime
// and the shared form-js renderer are authored as real, type-checked/linted/tested
// source (runtime.browser.js, formjs.browser.js) and emitted to committed string
// artifacts (runtime.gen.ts, formjs.gen.ts) by scripts/gen-runtime.mjs. If either
// checked-in artifact drifts from a fresh generation, the served bundle no longer
// matches its source and a stale renderer could ship — so we regenerate-and-compare
// here and fail on any drift, the same guarantee `npm run check:runtime` gives.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// Resolve the generator relative to THIS file (cwd varies: `npm test` runs from the
// package root, but a runner may invoke us from elsewhere).
const GEN_SCRIPT = fileURLToPath(new URL("../../../../scripts/gen-runtime.mjs", import.meta.url));

function hasStderr(e: unknown): e is { stderr?: unknown; stdout?: unknown } {
  return typeof e === "object" && e !== null && ("stderr" in e || "stdout" in e);
}

test("the committed runtime + formjs artifacts are byte-identical to a fresh generation (no drift)", () => {
  // `--check` regenerates both artifacts in-memory and diffs them against the
  // committed files, exiting non-zero (with a diagnostic) on any drift. Spawn the real
  // `node` binary explicitly: under `deno test`, `process.execPath` is the `deno`
  // binary, which cannot run this Node script — mirrors the pages.test.ts node --check
  // guard. Regenerate + commit locally with `npm run gen:runtime -w packages/urban`.
  let ok = true;
  let diagnostic = "";
  try {
    execFileSync("node", [GEN_SCRIPT, "--check"], { stdio: "pipe" });
  } catch (err) {
    ok = false;
    diagnostic = hasStderr(err) ? `${String(err.stdout ?? "")}${String(err.stderr ?? "")}` : String(err);
  }
  assert.ok(
    ok,
    `a committed generated artifact is stale — run \`npm run gen:runtime -w packages/urban\` and commit the result.\n${diagnostic}`,
  );
});
