import { test } from "node:test";
import assert from "node:assert/strict";
import * as http from "node:http";
import { createNodeHost } from "./node.ts";
import type { HttpServer } from "../core/host.ts";

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
