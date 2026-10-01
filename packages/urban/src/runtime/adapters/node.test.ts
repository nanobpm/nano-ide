import { test } from "node:test";
import assert from "node:assert/strict";
import * as http from "node:http";
import { mkdtemp, writeFile, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createNodeHost } from "./node.ts";
import type { HttpServer } from "../core/host.ts";

const execFileAsync = promisify(execFile);

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
test("statFile classifies a FIFO as non-regular without blocking (does not hang)", { skip: !hasMkfifo }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "urban-fifo-"));
  try {
    const fifo = join(dir, "app.css");
    await execFileAsync("mkfifo", [fifo]);
    const host = createNodeHost({ cwd: dir, log: () => {} });
    // Race the probe against a timeout so a regression (blocking open) FAILS fast instead of
    // hanging the whole suite until the runner's wall-clock kill.
    const verdict = await Promise.race([
      host.statFile!("app.css"),
      new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 2000)),
    ]);
    assert.notEqual(verdict, "timeout", "statFile must not block on a FIFO");
    assert.ok(
      verdict === null || (verdict !== "timeout" && verdict.isFile === false),
      `a FIFO must not be reported as a regular file (got ${JSON.stringify(verdict)})`,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

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
