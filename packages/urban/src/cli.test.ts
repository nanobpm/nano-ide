import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { cmdData } from "./cli.ts";
import { isRecord } from "./runtime/core/guards.ts";
import { createNodeHost } from "./runtime/adapters/node.ts";
import { runDataOp } from "./runtime/core/modules/dataops.ts";

// The `urban data` gateway's contract (see cmdData's docstring): *every* reply — including an
// unreadable request — is a parseable `{ ok: false, error }` envelope on stdout AND the process
// exits 0, so the Nano console can always parse the reply off stdout and never mistakes a
// malformed request for a subprocess crash. This guards the unreadable-request path, which used
// to exit non-zero and could make a caller that keys off the exit code discard the (parseable)
// error payload.
test("urban data exits 0 with a parseable envelope on an unreadable request", async () => {
  const flags: Parameters<typeof cmdData>[0] = {
    root: ".",
    manifest: "nano.app.json",
    check: false,
    deno: false,
    models: true,
    stdout: false,
    install: true,
    help: false,
    version: false,
    _: ["data"],
  };
  const lines: string[] = [];
  const orig = console.log;
  console.log = (...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  };
  let code: number;
  try {
    code = await cmdData(flags, async () => "this is not json {");
  } finally {
    console.log = orig;
  }
  assert.equal(code, 0);
  assert.equal(lines.length, 1);
  const reply: unknown = JSON.parse(lines[0]);
  assert.ok(isRecord(reply));
  assert.equal(reply.ok, false);
  if (typeof reply.error !== "string") throw new TypeError("expected string error");
  assert.match(reply.error, /^bad request: /);
});

// Regression guard for nanobpm/nano-ide#549: `urban data`'s success path prints the full reply
// with `console.log`, then the top-level runner calls `process.exit(code)`. In Node, stdout
// connected to a *pipe* is asynchronous — an immediate `process.exit` abandons anything still
// buffered, truncating the reply at the OS pipe-buffer boundary (65536 bytes on Linux) so the
// console host fails to `JSON.parse` it ("EOF … column 65536"). The fix drains stdout before the
// explicit exit. This test spawns the real CLI on a datasource whose query result serialises to
// well over 64 KB, reads the piped stdout, and asserts the parent parses a complete envelope whose
// byte length matches the untruncated JSON. It FAILS before the fix (truncated at 65536) and
// passes after.
test("urban data streams a > 64 KB reply without truncation through an explicit process.exit", async () => {
  const dir = await mkdtemp(join(tmpdir(), "urban-data-large-"));
  try {
    await mkdir(join(dir, "db", "migrations"), { recursive: true });
    await writeFile(
      join(dir, "nano.app.json"),
      JSON.stringify({
        schemaVersion: 1,
        id: "big",
        name: "Big",
        data: {
          default: "app",
          sources: { app: { driver: "sqlite", url: "file:./db/app.db", migrations: "db/migrations" } },
        },
      }),
    );
    await writeFile(
      join(dir, "db", "migrations", "001_big.sql"),
      "CREATE TABLE big (id INTEGER PRIMARY KEY, payload TEXT NOT NULL);",
    );
    // 2000 rows × ~128-char payload → a query reply of roughly 300 KB, comfortably past the 64 KB
    // pipe boundary. A single recursive-CTE INSERT (no inner `;`) so the migration splitter keeps
    // it as one statement.
    await writeFile(
      join(dir, "db", "migrations", "002_seed.sql"),
      "INSERT INTO big (id, payload) WITH RECURSIVE seq(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM seq WHERE n < 2000) SELECT n, printf('%0128d', n) FROM seq;",
    );

    const host = createNodeHost({ cwd: dir });
    await runDataOp(host, ".", "nano.app.json", { op: "migrate" });
    const query = { op: "query", sql: "SELECT * FROM big ORDER BY id" } as const;
    const result = await runDataOp(host, ".", "nano.app.json", query);
    const expected = `${JSON.stringify({ ok: true, ...result })}\n`;
    assert.ok(
      expected.length > 65536,
      `fixture too small (${expected.length} bytes) to exercise the pipe-buffer boundary`,
    );

    const cli = fileURLToPath(new URL("./cli.ts", import.meta.url));
    const stdout = await new Promise<string>((resolve, reject) => {
      const child = spawn(
        process.execPath,
        ["--experimental-strip-types", cli, "data", "--root", dir],
        { stdio: ["pipe", "pipe", "inherit"] },
      );
      const chunks: Buffer[] = [];
      child.stdout.on("data", (c: Buffer) => chunks.push(c));
      child.on("error", reject);
      child.on("close", () => resolve(Buffer.concat(chunks).toString("utf8")));
      child.stdin.end(JSON.stringify(query));
    });

    assert.equal(
      stdout.length,
      expected.length,
      `stdout truncated: got ${stdout.length} bytes, expected ${expected.length}`,
    );
    const reply: unknown = JSON.parse(stdout);
    assert.ok(isRecord(reply));
    assert.equal(reply.ok, true);
    assert.deepEqual(reply, { ok: true, ...result });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
