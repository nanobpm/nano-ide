// Guard: a freshly scaffolded app must be lint-green under its OWN Biome config,
// out of the box (nano-ide#451). This runs the scaffold's committed `biome.json`
// against everything create-urban-app writes — including the headless/deno
// scaffold-time reserializers and a long app id that stresses Biome's width-based
// inline/expand heuristic — so a template file (or a reserializer) that drifts out
// of tab/80-col compliance fails here instead of in a user's first `npm run lint`.
//
// Scope: this asserts the *pre-gen* scaffold (the files create-urban-app itself
// writes). The compliance of `urban gen` output (nano-generated/*, the worker
// stub, and the wired nano.app.json) is guarded in @nanobpm/urban's own tests.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { promisify } from "node:util";
import { scaffold, type ScaffoldOptions } from "./scaffold.ts";

const execFileAsync = promisify(execFile);
const biomeBin = createRequire(import.meta.url).resolve("@biomejs/biome/bin/biome");

const tempDirs: string[] = [];
after(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

async function biomeCheckIsGreen(dir: string): Promise<{ ok: boolean; output: string }> {
  try {
    // Match the scaffolded `lint` script exactly: `biome check` with no path
    // arg, resolved against the app's own biome.json from its root (cwd=dir).
    const { stdout, stderr } = await execFileAsync(process.execPath, [biomeBin, "check"], {
      cwd: dir,
    });
    return { ok: true, output: stdout + stderr };
  } catch (err) {
    const e: { stdout?: string; stderr?: string } = err ?? {};
    return { ok: false, output: (e.stdout ?? "") + (e.stderr ?? "") };
  }
}

// Every authoring combination create-urban-app can emit. A long id exercises the
// width-sensitive JSON (nano.app.json workers, pages/*.page.json props): the
// scaffolded declarative JSON must be a Biome fixed-point for any id length.
const combos: Array<{ label: string; opts: Omit<ScaffoldOptions, "dir"> }> = [
  { label: "code/full", opts: { name: "Effect Demo", id: "effect-demo", style: "code" } },
  { label: "code/headless", opts: { name: "Effect Demo", id: "effect-demo", style: "code", preset: "headless" } },
  { label: "code/deno", opts: { name: "Effect Demo", id: "effect-demo", style: "code", deno: true } },
  { label: "model/full", opts: { name: "Effect Demo", id: "effect-demo", style: "model" } },
  { label: "model/headless", opts: { name: "Effect Demo", id: "effect-demo", style: "model", preset: "headless" } },
  { label: "model/deno", opts: { name: "Effect Demo", id: "effect-demo", style: "model", deno: true } },
  {
    label: "model/full/long-id",
    opts: {
      name: "My Really Quite Long Effect Agent Demo Application Name Here",
      id: "my-really-quite-long-effect-agent-demo-application-name-here",
      style: "model",
    },
  },
];

for (const { label, opts } of combos) {
  test(`scaffolded app is Biome-green out of the box: ${label}`, async () => {
    const dir = await mkdtemp(join(tmpdir(), "cua-lint-"));
    tempDirs.push(dir);
    await scaffold({ ...opts, dir });
    const { ok, output } = await biomeCheckIsGreen(dir);
    assert.ok(ok, `biome check must be green for ${label}:\n${output}`);
  });
}
