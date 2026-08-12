import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { test } from "node:test";
import { encodeFrame } from "@nanobpm/agentic-protocol";
import type { Frame } from "@nanobpm/agentic-protocol";
import { WebSocket } from "ws";
import { AUTH_UNAUTHORIZED, sharedSecretAuthenticator } from "./auth.ts";
import { AgenticHub } from "./hub.ts";
import type { HubConnection } from "./hub.ts";
import { WebSocketChannelTransport } from "./ws-transport.ts";

const SECRET = "s3cret";

function registerBytes(instance: string): Uint8Array {
  const frame: Frame = {
    lane: "control",
    family: "register",
    seq: 1,
    payload: { instance, capability: { cognition: "opus" } },
  };
  return encodeFrame(frame);
}

test("a client connects, authenticates, is tracked, and its frame routes to a family handler", async (t) => {
  const transport = new WebSocketChannelTransport({ port: 0 });
  const hub = new AgenticHub({
    transport,
    authenticator: sharedSecretAuthenticator({ secret: SECRET }),
    sweepIntervalMs: 0,
  });
  t.after(() => hub.close());

  let resolveRouted: (conn: HubConnection) => void = () => {};
  const routed = new Promise<HubConnection>((resolve) => {
    resolveRouted = resolve;
  });
  hub.registerFamilyHandler("register", (_frame, ctx) => {
    ctx.registry.setPresence(ctx.id, { instance: "w-1" });
    resolveRouted(ctx);
  });

  await transport.ready();
  const port = transport.address?.port;
  assert.ok(port !== undefined && port > 0);

  const client = new WebSocket(`ws://127.0.0.1:${port}/agentic?token=${SECRET}&capability=cap-1`);
  client.on("error", () => {});
  t.after(() => client.close());
  await once(client, "open");
  client.send(registerBytes("w-1"), { binary: true });

  const ctx = await routed;
  assert.ok(ctx.identity.length > 0); // resolved from the peer's remote address
  assert.equal(hub.connectionCount, 1);
  assert.equal(hub.registry.get(ctx.id)?.presence.instance, "w-1");
});

test("a client may present its capability credential via a mixed-case header", async (t) => {
  const transport = new WebSocketChannelTransport({ port: 0 });
  const hub = new AgenticHub({
    transport,
    authenticator: sharedSecretAuthenticator({ secret: SECRET }),
    sweepIntervalMs: 0,
  });
  t.after(() => hub.close());

  let resolveRouted: (conn: HubConnection) => void = () => {};
  const routed = new Promise<HubConnection>((resolve) => {
    resolveRouted = resolve;
  });
  hub.registerFamilyHandler("register", (_frame, ctx) => resolveRouted(ctx));

  await transport.ready();
  const port = transport.address?.port;
  assert.ok(port !== undefined && port > 0);

  // Credential arrives only in a mixed-case header (no `capability` query param);
  // header lookup must be case-insensitive for the handshake to grant.
  const client = new WebSocket(`ws://127.0.0.1:${port}/agentic?token=${SECRET}`, {
    headers: { "X-Capability-Credential": "cap-1" },
  });
  client.on("error", () => {});
  t.after(() => client.close());
  await once(client, "open");
  client.send(registerBytes("w-1"), { binary: true });

  const ctx = await routed;
  // Reaching the family handler proves the required credential was found via the
  // header (a case-sensitive lookup would have rejected with AUTH_FORBIDDEN).
  assert.ok(ctx.identity.length > 0);
  assert.equal(hub.connectionCount, 1);
});

test("an unauthenticated client is closed with the unauthorized code and never tracked", async (t) => {
  const transport = new WebSocketChannelTransport({ port: 0 });
  const hub = new AgenticHub({
    transport,
    authenticator: sharedSecretAuthenticator({ secret: SECRET }),
    sweepIntervalMs: 0,
  });
  t.after(() => hub.close());

  await transport.ready();
  const port = transport.address?.port;
  const client = new WebSocket(`ws://127.0.0.1:${port}/agentic?token=wrong&capability=cap-1`);
  client.on("error", () => {});

  const [code] = await once(client, "close");
  assert.equal(code, AUTH_UNAUTHORIZED);
  assert.equal(hub.connectionCount, 0);
});

test("the hub replies on the same connection", async (t) => {
  const transport = new WebSocketChannelTransport({ port: 0 });
  const hub = new AgenticHub({
    transport,
    authenticator: sharedSecretAuthenticator({ secret: SECRET }),
    sweepIntervalMs: 0,
  });
  t.after(() => hub.close());

  hub.registerFamilyHandler("register", (_frame, ctx) => {
    ctx.send({ lane: "control", family: "serve", seq: 1, payload: { instance: "w-1", tokens: [] } });
  });

  await transport.ready();
  const port = transport.address?.port;
  const client = new WebSocket(`ws://127.0.0.1:${port}/agentic?token=${SECRET}&capability=cap-1`);
  client.on("error", () => {});
  t.after(() => client.close());
  await once(client, "open");
  client.send(registerBytes("w-1"), { binary: true });

  const [data] = await once(client, "message");
  assert.ok(data instanceof Buffer);
  assert.ok(data.length > 0);
});

test("a text frame is rejected with 1003 and never reaches the codec", async (t) => {
  // The protocol is binary-only. Pre-fix, `onMessage` called `toBytes` on the
  // string payload of a text frame — which throws (no `.buffer`) and breaks the
  // connection handler. The transport must instead close the socket with 1003.
  const transport = new WebSocketChannelTransport({ port: 0 });
  const hub = new AgenticHub({
    transport,
    authenticator: sharedSecretAuthenticator({ secret: SECRET }),
    sweepIntervalMs: 0,
  });
  t.after(() => hub.close());

  let sawFrame = false;
  hub.registerFamilyHandler("register", () => {
    sawFrame = true;
  });

  await transport.ready();
  const port = transport.address?.port;
  const client = new WebSocket(`ws://127.0.0.1:${port}/agentic?token=${SECRET}&capability=cap-1`);
  client.on("error", () => {});
  t.after(() => client.close());
  await once(client, "open");

  // Send a TEXT frame (binary:false) — the transport must reject it.
  client.send("not-a-binary-frame", { binary: false });

  const [code] = await once(client, "close");
  assert.equal(code, 1003);
  assert.equal(sawFrame, false); // no text payload ever reached a family handler
});

test("ready() resolves in shared-port mode when attached to an app HTTP server", async (t) => {
  // `ws` never emits `listening` on the WebSocketServer when it shares an
  // existing HTTP server, so ready() must observe the HTTP server instead —
  // otherwise it hangs forever. This test would time out without that fix.
  const server = createServer();
  const transport = new WebSocketChannelTransport({ server });
  const hub = new AgenticHub({
    transport,
    authenticator: sharedSecretAuthenticator({ secret: SECRET }),
    sweepIntervalMs: 0,
  });
  t.after(() => hub.close());
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));

  server.listen(0, "127.0.0.1");
  await once(server, "listening");

  // ready() must resolve now that the shared HTTP server is listening.
  await transport.ready();

  const addr = server.address();
  assert.ok(addr !== null && typeof addr === "object");
  const port = addr.port;

  hub.registerFamilyHandler("register", (_frame, ctx) => {
    ctx.send({ lane: "control", family: "serve", seq: 1, payload: { instance: "w-1", tokens: [] } });
  });

  const client = new WebSocket(`ws://127.0.0.1:${port}/agentic?token=${SECRET}&capability=cap-1`);
  client.on("error", () => {});
  t.after(() => client.close());
  await once(client, "open");
  client.send(registerBytes("w-1"), { binary: true });

  const [data] = await once(client, "message");
  assert.ok(data instanceof Buffer);
  assert.ok(data.length > 0);
});
test("close() shuts a connected peer down with a clean close handshake, not an abnormal 1006", async (t) => {
  // terminate() aborts without a handshake, so peers observe 1006 (abnormal) and
  // lose any application close code/reason. A graceful close lets them observe a
  // normal closure during shutdown.
  const transport = new WebSocketChannelTransport({ port: 0 });
  const hub = new AgenticHub({
    transport,
    authenticator: sharedSecretAuthenticator({ secret: SECRET }),
    sweepIntervalMs: 0,
  });

  await transport.ready();
  const port = transport.address?.port;
  assert.ok(port !== undefined && port > 0);

  const client = new WebSocket(`ws://127.0.0.1:${port}/agentic?token=${SECRET}&capability=cap-1`);
  client.on("error", () => {});
  t.after(() => client.close());
  await once(client, "open");

  const closed = once(client, "close");
  await transport.close();
  const [code] = await closed;
  assert.notEqual(code, 1006); // not an abnormal closure
});
