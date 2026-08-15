// Bind-host regression: the node adapter's serveHttp honours an optional `hostname`, so a
// local-first app can keep its server loopback-only. We drive the real adapter (not a stub) and
// assert it serves on the requested interface.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createNodeHost } from "./node.ts";

test("serveHttp binds the requested loopback interface and still serves", async () => {
  const host = createNodeHost();
  // Port 0 -> an ephemeral port; bind loopback-only.
  const server = await host.serveHttp(
    0,
    () => ({ status: 200, headers: { "content-type": "text/plain" }, body: "ok" }),
    { hostname: "127.0.0.1" },
  );
  try {
    assert.ok(server.port > 0, "an ephemeral port was assigned");
    const res = await fetch(`http://127.0.0.1:${server.port}/anything`);
    assert.equal(res.status, 200);
    assert.equal(await res.text(), "ok");
  } finally {
    await server.stop();
  }
});

test("serveHttp with no hostname still serves (host default interface)", async () => {
  const host = createNodeHost();
  const server = await host.serveHttp(0, () => ({ status: 204 }));
  try {
    const res = await fetch(`http://127.0.0.1:${server.port}/`);
    assert.equal(res.status, 204);
  } finally {
    await server.stop();
  }
});

test("serveHttp rejects fast when the bind fails instead of hanging", async () => {
  const host = createNodeHost();
  // Deterministically provoke the underlying `listen` error path with a guaranteed EADDRINUSE:
  // hold a first server on a concrete loopback port, then try to bind a second server to the same
  // host:port. (An unassignable/unsupported hostname is not portable — e.g. hosts with
  // `net.ipv4.ip_nonlocal_bind=1` may still bind it — so a port clash is the reliable trigger.)
  // Without the wired-in `error` handler the startup promise would never settle and hang forever,
  // so guard the failure path with a timeout and assert we reject rather than stall.
  const first = await host.serveHttp(
    0,
    () => ({ status: 200, body: "ok" }),
    { hostname: "127.0.0.1" },
  );
  try {
    const start = host.serveHttp(
      first.port,
      () => ({ status: 200, body: "ok" }),
      { hostname: "127.0.0.1" },
    );
    const timeout = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("serveHttp hung: bind failure did not reject")), 3000),
    );
    await assert.rejects(Promise.race([start, timeout]), (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.doesNotMatch(err.message, /hung/, "rejected via the adapter, not the test timeout");
      return true;
    });
  } finally {
    await first.stop();
  }
});
