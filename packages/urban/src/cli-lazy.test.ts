// Module-load laziness guard for nanobpm/nano-ide#592: the CLI used to import the whole
// toolkit (`create-urban-app`, `./toolkit/index.ts`) and the runtime barrel at the top of
// cli.ts, so EVERY command — including the per-data-op `urban data` gateway — paid the full
// load before dispatching. On small hosts that load is ~90% of a command's cost (measured:
// ~2s CPU on a 4-core Atom vs ~0.1s bare Node start-up). The fix keeps only argument parsing
// and stdio/guard helpers at the top level and dynamically imports each command's modules
// inside its handler.
//
// These tests pin the laziness per command: they spawn the real CLI entrypoint with a
// `--import` preload that registers a module-resolution hook recording every resolved URL,
// then assert which module trees the command did NOT load.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isRecord } from "./runtime/core/guards.ts";

const cli = fileURLToPath(new URL("./cli.ts", import.meta.url));

// Spawning with --experimental-strip-types runs the TypeScript source directly, so the test
// exercises the authored cli.ts (no build step needed) — same as the >64 KB stdout test above.
// bin.mjs is Node-only, so skip under Deno (`test:deno`), whose process.execPath is not Node.
const runtimeIsNode = !("Deno" in globalThis);

interface RunResult {
  stdout: string;
  stderr: string;
  code: number | null;
  resolved: string[];
}

/**
 * Spawn `cli.ts <args>` with a preload that records every module URL the process resolves.
 * The preload registers a resolve hook (via `module.register`) on a loader thread that
 * appends each resolved URL to a file; the parent then reads that file.
 */
async function runCliRecordingModules(
  dir: string,
  args: string[],
  stdin: string,
): Promise<RunResult> {
  const resolvedFile = join(dir, "resolved.txt");
  await writeFile(resolvedFile, "");
  const hooks = join(dir, "hooks.mjs");
  await writeFile(
    hooks,
    [
      'import { appendFileSync } from "node:fs";',
      `const file = ${JSON.stringify(resolvedFile)};`,
      "export async function resolve(specifier, context, nextResolve) {",
      "  const result = await nextResolve(specifier, context);",
      "  try { appendFileSync(file, result.url + \"\\n\"); } catch {}",
      "  return result;",
      "}",
      "",
    ].join("\n"),
  );
  const preload = join(dir, "preload.mjs");
  await writeFile(
    preload,
    [
      'import { register } from "node:module";',
      `register(${JSON.stringify(pathToFileURL(hooks).href)});`,
      "",
    ].join("\n"),
  );

  const { stdout, stderr, code } = await new Promise<{
    stdout: Buffer;
    stderr: Buffer;
    code: number | null;
  }>((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["--experimental-strip-types", `--import=${pathToFileURL(preload).href}`, cli, ...args],
      { stdio: ["pipe", "pipe", "pipe"] },
    );
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on("data", (c: Buffer) => out.push(c));
    child.stderr.on("data", (c: Buffer) => err.push(c));
    child.on("error", reject);
    child.on("close", (code) =>
      resolve({ stdout: Buffer.concat(out), stderr: Buffer.concat(err), code }),
    );
    child.stdin.end(stdin);
  });

  const { readFile } = await import("node:fs/promises");
  const resolved = (await readFile(resolvedFile, "utf8")).split("\n").filter((l) => l.length > 0);
  return { stdout: stdout.toString("utf8"), stderr: stderr.toString("utf8"), code, resolved };
}

/** Resolved URLs under the given package path fragments (the heavy module trees of #592). */
function heavyLoads(resolved: string[]): string[] {
  return resolved.filter(
    (u) =>
      // Node resolves a workspace package's node_modules symlink to its real target, so in a
      // monorepo checkout `create-urban-app` resolves under `packages/create-urban-app/` — match
      // both the installed and the workspace-real shape or a scaffold regression slips through.
      u.includes("/node_modules/create-urban-app/") ||
      u.includes("/packages/create-urban-app/") ||
      u.includes("/dist/toolkit/") ||
      u.includes("/src/toolkit/"),
  );
}

test("urban data does not load the toolkit, scaffold or gen modules", {
  skip: runtimeIsNode ? false : "Node-only: spawns cli.ts via process.execPath (Deno's execPath is not Node)",
}, async () => {
  const dir = await mkdtemp(join(tmpdir(), "urban-cli-lazy-data-"));
  try {
    // A parseable request, so cmdData gets past JSON.parse and actually runs the command-specific
    // dynamic imports (host detector + data-op runner) — malformed JSON would return from the
    // parse-error branch first and prove nothing about the data path's module graph. The root has
    // no manifest, so the op still fails; the CLI answers with its parseable envelope and exits 0.
    const { stdout, stderr, code, resolved } = await runCliRecordingModules(
      dir,
      ["data", "--root", dir],
      JSON.stringify({ op: "sources" }),
    );
    assert.equal(code, 0, `CLI exited ${code}, expected 0. stderr:\n${stderr}`);
    const reply: unknown = JSON.parse(stdout);
    assert.ok(isRecord(reply));
    assert.equal(reply.ok, false);

    const heavy = heavyLoads(resolved);
    assert.deepEqual(
      heavy,
      [],
      `urban data eagerly loaded toolkit/scaffold modules:\n${heavy.join("\n")}`,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("urban --version loads neither the toolkit nor the runtime modules", {
  skip: runtimeIsNode ? false : "Node-only: spawns cli.ts via process.execPath (Deno's execPath is not Node)",
}, async () => {
  const dir = await mkdtemp(join(tmpdir(), "urban-cli-lazy-version-"));
  try {
    const { stdout, stderr, code, resolved } = await runCliRecordingModules(dir, ["--version"], "");
    assert.equal(code, 0, `CLI exited ${code}, expected 0. stderr:\n${stderr}`);
    assert.match(stdout, /^\d+\.\d+\.\d+/);

    // The only runtime-tree modules the CLI itself may touch eagerly are its two tiny
    // stdio/guard helpers — everything else under runtime/ (the barrel, run.ts, the data-op
    // modules, the engine adapters, …) must stay unloaded until a command needs it.
    const allowed = new Set(["/src/runtime/adapters/globals.ts", "/src/runtime/core/guards.ts"]);
    const heavy = resolved.filter(
      (u) =>
        u.includes("/node_modules/create-urban-app/") ||
        u.includes("/packages/create-urban-app/") ||
        u.includes("/dist/toolkit/") ||
        u.includes("/src/toolkit/") ||
        ((u.includes("/dist/runtime/") || u.includes("/src/runtime/")) &&
          ![...allowed].some((a) => u.endsWith(a))),
    );
    assert.deepEqual(
      heavy,
      [],
      `urban --version eagerly loaded toolkit/runtime modules:\n${heavy.join("\n")}`,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
