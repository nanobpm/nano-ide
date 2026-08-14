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
