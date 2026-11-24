import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { cmdData, cmdDataServe } from "./cli.ts";
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
    serve: false,
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
    const expectedBytes = Buffer.byteLength(expected);
    assert.ok(
      expectedBytes > 65536,
      `fixture too small (${expectedBytes} bytes) to exercise the pipe-buffer boundary`,
    );

    const cli = fileURLToPath(new URL("./cli.ts", import.meta.url));
    const { stdout, code, signal } = await new Promise<{
      stdout: Buffer;
      code: number | null;
      signal: NodeJS.Signals | null;
    }>((resolve, reject) => {
      const child = spawn(
        process.execPath,
        ["--experimental-strip-types", cli, "data", "--root", dir],
        { stdio: ["pipe", "pipe", "inherit"] },
      );
      const chunks: Buffer[] = [];
      child.stdout.on("data", (c: Buffer) => chunks.push(c));
      child.on("error", reject);
      child.on("close", (code, signal) => resolve({ stdout: Buffer.concat(chunks), code, signal }));
      child.stdin.end(JSON.stringify(query));
    });

    assert.equal(signal, null, `CLI killed by signal ${signal}`);
    assert.equal(code, 0, `CLI exited ${code}, expected 0`);
    assert.equal(
      stdout.byteLength,
      expectedBytes,
      `stdout truncated: got ${stdout.byteLength} bytes, expected ${expectedBytes}`,
    );
    const reply: unknown = JSON.parse(stdout.toString("utf8"));
    assert.ok(isRecord(reply));
    assert.equal(reply.ok, true);
    assert.deepEqual(reply, { ok: true, ...result });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// `urban data --serve` (nano-bpm#1836): a long-lived NDJSON gateway — one request per stdin line
// carrying an `id`, one response per stdout line echoing it; bad lines become error responses
// (never a crash); the worker exits 0 on stdin EOF.
async function serveFixture(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "urban-data-serve-"));
  await mkdir(join(dir, "db", "migrations"), { recursive: true });
  await writeFile(
    join(dir, "nano.app.json"),
    JSON.stringify({
      schemaVersion: 1,
      id: "srv",
      name: "Srv",
      data: {
        default: "app",
        sources: { app: { driver: "sqlite", url: "file:./db/app.db", migrations: "db/migrations" } },
      },
    }),
  );
  await writeFile(join(dir, "db", "migrations", "001_t.sql"), "CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT);");
  return dir;
}

function serveFlags(root: string): Parameters<typeof cmdDataServe>[0] {
  return {
    root,
    manifest: "nano.app.json",
    check: false,
    deno: false,
    models: true,
    stdout: false,
    install: true,
    serve: true,
    help: false,
    version: false,
    _: ["data"],
  };
}

test("urban data --serve answers each line in order, echoing ids, and survives bad requests", async () => {
  const dir = await serveFixture();
  try {
    // Chunk boundaries deliberately split lines mid-request, and CRLF/blank lines are tolerated.
    const input = [
      '{"id":1,"op":"migrate"}\n{"id":"two","op":"ex',
      'ec","sql":"INSERT INTO t (v) VALUES (\'a\')"}\r\n',
      "\n",
      "not json\n",
      "[1,2]\n",
      '{"id":3,"op":"bogus-op"}\n',
      '{"id":"no-op","sql":"SELECT 1"}\n',
      '{"id":4,"op":"query","sql":"SELECT v FROM t"}', // final unterminated line
    ];
    const out: unknown[] = [];
    const code = await cmdDataServe(
      serveFlags(dir),
      (async function* () {
        yield* input;
      })(),
      async (line) => {
        assert.ok(!line.includes("\n"), "each response must be a single line");
        out.push(JSON.parse(line));
      },
    );
    assert.equal(code, 0);
    assert.equal(out.length, 7);
    const [r1, r2, r3, r4, r5, rNoOp, r6] = out.map((r) => {
      assert.ok(isRecord(r));
      return r;
    });
    assert.equal(r1.id, 1);
    assert.equal(r1.ok, true);
    assert.equal(r2.id, "two");
    assert.equal(r2.ok, true);
    assert.equal(r3.id, null);
    assert.equal(r3.ok, false);
    assert.match(String(r3.error), /^bad request: /);
    assert.equal(r4.id, null);
    assert.equal(r4.ok, false);
    assert.equal(r5.id, 3);
    assert.equal(r5.ok, false);
    assert.equal(typeof r5.error, "string");
    assert.equal(rNoOp.id, "no-op");
    assert.equal(rNoOp.ok, false);
    assert.match(String(rNoOp.error), /^bad request: /);
    assert.equal(r6.id, 4);
    assert.equal(r6.ok, true);
    assert.match(JSON.stringify(r6), /"a"/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("urban data --serve as a real process: replies per line and exits 0 on stdin EOF", { skip: "Deno" in globalThis }, async () => {
  const dir = await serveFixture();
  try {
    const cli = fileURLToPath(new URL("./cli.ts", import.meta.url));
    const child = spawn(process.execPath, ["--experimental-strip-types", cli, "data", "--serve", "--root", dir], {
      stdio: ["pipe", "pipe", "inherit"],
    });
    let buf = "";
    const waiters: Array<(line: string) => void> = [];
    const lines: string[] = [];
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (c: string) => {
      buf += c;
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        const w = waiters.shift();
        if (w) w(line);
        else lines.push(line);
      }
    });
    const next = () =>
      new Promise<string>((resolve) => {
        const l = lines.shift();
        if (l !== undefined) resolve(l);
        else waiters.push(resolve);
      });
    const closed = new Promise<number | null>((resolve) => child.on("close", (code) => resolve(code)));

    // Interactive: the worker answers a request before stdin closes (it is long-lived).
    child.stdin.write('{"id":"a","op":"migrate"}\n');
    const a: unknown = JSON.parse(await next());
    assert.ok(isRecord(a));
    assert.equal(a.id, "a");
    assert.equal(a.ok, true);
    child.stdin.write("garbage\n");
    const b: unknown = JSON.parse(await next());
    assert.ok(isRecord(b));
    assert.equal(b.ok, false);
    child.stdin.write('{"id":"c","op":"sources"}\n');
    const c: unknown = JSON.parse(await next());
    assert.ok(isRecord(c));
    assert.equal(c.id, "c");
    assert.equal(c.ok, true);
    child.stdin.end();
    assert.equal(await closed, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
