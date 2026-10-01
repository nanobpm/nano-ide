import { test } from "node:test";
import assert from "node:assert/strict";
import * as http from "node:http";
import { mkdtemp, writeFile, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile, fork } from "node:child_process";
import { promisify } from "node:util";
import { createNodeHost } from "./node.ts";
import type { HttpServer } from "../core/host.ts";

const execFileAsync = promisify(execFile);
const nodeImportsTs = Number(process.versions.node.split(".")[0]) >= 22;

// Issue #235: the node adapter must bind the interface it is handed so the manifest's
// `network.bind` setting actually controls off-box reachability. We assert the *listen host*
// the socket bound to for each setting by reading the native server's address.
function boundAddress(server: HttpServer): string {
  const native = server.native;
  assert.ok(native instanceof http.Server, "adapter exposes a node http.Server as native");
  const addr = native.address();
  assert.ok(addr && typeof addr === "object", "server has a bound AddressInfo");
  return addr.address;
}

test("serveHttp binds loopback when handed 127.0.0.1 (refuses off-box)", async () => {
  const host = createNodeHost({ log: () => {} });
  const server = await host.serveHttp(0, () => ({ status: 200 }), "127.0.0.1");
  try {
    assert.equal(boundAddress(server), "127.0.0.1");
  } finally {
    await server.stop();
  }
});

test("serveHttp binds all interfaces when handed 0.0.0.0 (reachable on the LAN)", async () => {
  const host = createNodeHost({ log: () => {} });
  const server = await host.serveHttp(0, () => ({ status: 200 }), "0.0.0.0");
  try {
    assert.equal(boundAddress(server), "0.0.0.0");
  } finally {
    await server.stop();
  }
});

// Issue #235 (fail closed): omitting the bind host must NOT inherit Node's bind-all default —
// a caller that forgets to resolve one should still get loopback, never off-box exposure.
test("serveHttp fails closed to loopback when no bind host is given", async () => {
  const host = createNodeHost({ log: () => {} });
  const server = await host.serveHttp(0, () => ({ status: 200 }));
  try {
    assert.equal(boundAddress(server), "127.0.0.1");
  } finally {
    await server.stop();
  }
});

// A bind failure (EADDRINUSE) must reject the serveHttp promise instead of hanging forever
// waiting for a `listening` event that never fires.
test("serveHttp rejects when the port is already in use (does not hang)", async () => {
  const host = createNodeHost({ log: () => {} });
  const first = await host.serveHttp(0, () => ({ status: 200 }), "127.0.0.1");
  const taken = first.native;
  assert.ok(taken instanceof http.Server);
  const addr = taken.address();
  assert.ok(addr && typeof addr === "object");
  try {
    await assert.rejects(
      () => host.serveHttp(addr.port, () => ({ status: 200 }), "127.0.0.1"),
      (err: NodeJS.ErrnoException) => err.code === "EADDRINUSE",
    );
  } finally {
    await first.stop();
  }
});

// PR #579: `statFile` is the shell's readable-regular-file probe for app assets (pages/app.css,
// pages/app.js). It MUST classify the entry's type with a non-blocking `stat` BEFORE opening the
// path for reading: a POSIX read-only open of a FIFO waits forever for a writer, so probing a FIFO
// at the asset path would hang every shell request. This guards that a special-file entry returns
// a non-regular verdict promptly instead of blocking. (POSIX-only: `mkfifo` isn't on Windows.)
const hasMkfifo = process.platform !== "win32";
// A blocked read-only `open` of a FIFO sits in libuv and CANNOT be cancelled from within the
// process: `Promise.race` against a timeout would leave the losing probe running, and unlinking
// the FIFO does not release it — the suite process would never exit, so the regression would not
// actually fail fast. Run the probe in a killable CHILD process instead: the parent races the
// child's verdict message against a timeout and SIGKILLs the child on timeout, so a blocking-open
// regression fails this test fast (child startup + a ~2s probe budget) instead of wedging the runner.
//
// Two separate budgets, deliberately: the child first strip-types `node.ts` and its transitive
// imports on a cold `--experimental-strip-types` start, which is HUNDREDS of ms and — crucially —
// load-sensitive (observed >2s under the full parallel suite, #579). If a single timeout covered
// both startup AND the `statFile` call, that cold-start cost would contaminate the probe budget and
// the test would fail spuriously under load. So the child emits a `ready` message AFTER its imports
// resolve; the parent only arms the (short) probe timeout once ready. Startup gets its own generous,
// load-insensitive guard, and the probe budget then measures ONLY `statFile` — the blocking-open
// regression (which manifests inside `statFile`, after `ready`) still fails fast.
const PROBE_STARTUP_TIMEOUT_MS = 30_000;
type FifoReadyMsg = { ready: true };
type FifoVerdictMsg = { verdict: { isFile: boolean } | null };
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
function isFifoReadyMsg(value: unknown): value is FifoReadyMsg {
  return isRecord(value) && value.ready === true;
}
function isFifoVerdictMsg(value: unknown): value is FifoVerdictMsg {
  if (!isRecord(value) || !("verdict" in value)) return false;
  const verdict = value.verdict;
  if (verdict === null) return true;
  return isRecord(verdict) && typeof verdict.isFile === "boolean";
}
function probeInChild(cwd: string, asset: string, probeTimeoutMs: number): Promise<FifoVerdictMsg | "timeout"> {
  // `node --eval` places the first user argument at process.argv[1] (argv[0] is the node
  // binary), so cwd is argv[1] and the asset path is argv[2] — NOT [2]/[3]. `ready` is sent once
  // the host module is imported and built, BEFORE the (possibly blocking) `statFile` probe.
  const source = `import { createNodeHost } from ${JSON.stringify(new URL("./node.ts", import.meta.url).href)};
const host = createNodeHost({ cwd: process.argv[1], log: () => {} });
process.send({ ready: true });
const verdict = await host.statFile(process.argv[2]);
process.send({ verdict });
process.exit(0);`;
  return new Promise((resolve, reject) => {
    const child = fork(
      "--input-type=module",
      ["--experimental-strip-types", "--no-warnings", "--eval", source, cwd, asset],
      { stdio: ["ignore", "ignore", "inherit", "ipc"] },
    );
    let probeTimer: ReturnType<typeof setTimeout> | undefined;
    // Generous, load-insensitive guard: the child must finish importing and emit `ready` within
    // this. A startup slower than 30s means a genuine hang in module load, not the FIFO probe.
    const startupTimer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("probe child did not become ready (startup) in time"));
    }, PROBE_STARTUP_TIMEOUT_MS);
    const clearTimers = () => {
      clearTimeout(startupTimer);
      if (probeTimer !== undefined) clearTimeout(probeTimer);
    };
    child.on("message", (msg: unknown) => {
      if (isFifoReadyMsg(msg)) {
        // Startup done — now time ONLY the statFile call. A blocking-open regression blocks here
        // and this short budget SIGKILLs the child, failing the test fast.
        clearTimeout(startupTimer);
        probeTimer = setTimeout(() => {
          child.kill("SIGKILL");
          resolve("timeout");
        }, probeTimeoutMs);
        return;
      }
      clearTimers();
      child.disconnect();
      if (isFifoVerdictMsg(msg)) resolve(msg);
      else reject(new Error(`unexpected probe message: ${JSON.stringify(msg)}`));
    });
    child.once("error", (err) => {
      clearTimers();
      reject(err);
    });
  });
}
test(
  "statFile classifies a FIFO as non-regular without blocking (does not hang)",
  { skip: !hasMkfifo || !nodeImportsTs },
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "urban-fifo-"));
    try {
      const fifo = join(dir, "app.css");
      await execFileAsync("mkfifo", [fifo]);
      const msg = await probeInChild(dir, "app.css", 2000);
      assert.notEqual(msg, "timeout", "statFile must not block on a FIFO");
      // Require a POSITIVE non-regular verdict. Accepting `null` (the probe-error path) would
      // let the test pass vacuously without ever probing the FIFO — e.g. if the child crashed
      // or read the wrong argv index and statFile swallowed the resulting path error.
      assert.ok(
        msg !== "timeout" && msg.verdict !== null && msg.verdict.isFile === false,
        `a FIFO must positively probe as a non-regular file (got ${JSON.stringify(msg)})`,
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
);

// Companion to the FIFO guard: a real regular file still probes as `isFile: true`, and a directory
// at the asset path probes as non-regular — the two verdicts `mountPages` relies on to link only
// genuinely servable assets.
test("statFile reports a regular file as isFile and a directory as non-regular", async () => {
  const dir = await mkdtemp(join(tmpdir(), "urban-stat-"));
  try {
    await writeFile(join(dir, "app.js"), "export {};");
    await mkdir(join(dir, "app.css"), { recursive: true });
    const host = createNodeHost({ cwd: dir, log: () => {} });
    assert.deepEqual(await host.statFile!("app.js"), { isFile: true });
    assert.deepEqual(await host.statFile!("app.css"), { isFile: false });
    assert.equal(await host.statFile!("missing.css"), null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
