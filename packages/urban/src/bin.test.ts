// The `urban` bin (`bin.mjs`) must run the compiled CLI in the SAME Node process (nano-ide#589):
// the gateway spawns `urban data` per data op, and the old spawnSync bootstrap paid two Node
// start-ups for every one. Exercises the real bin against dist/ (CI builds before testing).

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const bin = fileURLToPath(new URL("./bin.mjs", import.meta.url));
const dist = fileURLToPath(new URL("../dist/cli.js", import.meta.url));

function runBin(
  args: string[],
  stdin: string,
  env: NodeJS.ProcessEnv,
): Promise<{ stdout: string; code: number | null }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [bin, ...args], {
      stdio: ["pipe", "pipe", "inherit"],
      env: { ...process.env, ...env },
    });
    const chunks: Buffer[] = [];
    child.stdout.on("data", (c: Buffer) => chunks.push(c));
    child.on("error", reject);
    child.on("close", (code) => resolve({ stdout: Buffer.concat(chunks).toString("utf8"), code }));
    child.stdin.end(stdin);
  });
}

test("bin.mjs runs the CLI in-process: one Node per command, reply + exit code intact", async (t) => {
  if (!existsSync(dist)) {
    t.skip("dist/cli.js not built (run `npm run build`); CI builds before testing");
    return;
  }
  const dir = mkdtempSync(join(tmpdir(), "urban-bin-"));
  try {
    // A preload every Node process runs (NODE_OPTIONS is inherited by child Nodes), recording
    // its pid. The old spawnSync bootstrap would record two.
    const pids = join(dir, "pids.txt");
    const preload = join(dir, "preload.mjs");
    writeFileSync(
      preload,
      `import { appendFileSync } from "node:fs";\nappendFileSync(${JSON.stringify(pids)}, process.pid + "\\n");\n`,
    );
    const env = { NODE_OPTIONS: `--import=${pathToFileURL(preload).href}` };

    // An unreadable request: `urban data` still answers with a parseable envelope and exits 0.
    const { stdout, code } = await runBin(["data", "--root", dir], "not json", env);
    assert.equal(code, 0, `bin exited ${code}, expected 0`);
    const reply: unknown = JSON.parse(stdout);
    assert.ok(reply !== null && typeof reply === "object", "reply is not an object");
    assert.equal(Reflect.get(reply, "ok"), false);
    assert.match(String(Reflect.get(reply, "error")), /^bad request:/);

    const started = readFileSync(pids, "utf8").trim().split("\n").filter(Boolean);
    assert.equal(started.length, 1, `expected 1 Node process, got ${started.length}`);

    // A failing command's non-zero exit code still propagates through the bin.
    const unknown = await runBin(["no-such-command"], "", {});
    assert.equal(unknown.code, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
