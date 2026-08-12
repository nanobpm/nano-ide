import assert from "node:assert/strict";
import { setImmediate as tick } from "node:timers/promises";
import { test } from "node:test";
import { encodeFrame } from "../protocol/index.ts";
import type { Frame } from "../protocol/index.ts";
import { sharedSecretAuthenticator } from "./auth.ts";
import type { AuthResult } from "./auth.ts";
import type { Clock } from "./clock.ts";
import type { ChannelConnection, ChannelTransport, CloseCode, HandshakeRequest } from "./connection.ts";
import { AgenticHub, LIVENESS_TIMEOUT } from "./hub.ts";
import { ConnectionRegistry } from "./registry.ts";

/** An in-memory connection the test drives directly — no sockets, no timers. */
class FakeConnection implements ChannelConnection {
  readonly id: string;
  readonly handshake: HandshakeRequest;
  readonly sent: Uint8Array[] = [];
  closed: { code?: CloseCode; reason?: string } | null = null;
  #onMessage: ((bytes: Uint8Array) => void) | undefined;
  #onClose: ((code?: CloseCode, reason?: string) => void) | undefined;
  #onPong: (() => void) | undefined;
  #onPing: (() => void) | undefined;

  constructor(id: string, handshake: HandshakeRequest) {
    this.id = id;
    this.handshake = handshake;
  }

  send(bytes: Uint8Array): void {
    this.sent.push(bytes);
  }
  close(code?: CloseCode, reason?: string): void {
    this.closed = { code, reason };
    this.#onClose?.(code, reason);
  }
  onMessage(listener: (bytes: Uint8Array) => void): void {
    this.#onMessage = listener;
  }
  onClose(listener: (code?: CloseCode, reason?: string) => void): void {
    this.#onClose = listener;
  }
  onPong(listener: () => void): void {
    this.#onPong = listener;
  }
  onPing(listener: () => void): void {
    this.#onPing = listener;
  }

  // Test drivers:
  receive(bytes: Uint8Array): void {
    this.#onMessage?.(bytes);
  }
  pong(): void {
    this.#onPong?.();
  }
  ping(): void {
    this.#onPing?.();
  }
}

class FakeTransport implements ChannelTransport {
  readonly address = { port: 0 };
  #onConnection: ((conn: ChannelConnection) => void) | undefined;

  onConnection(listener: (conn: ChannelConnection) => void): void {
    this.#onConnection = listener;
  }
  close(): Promise<void> {
    return Promise.resolve();
  }
  accept(conn: ChannelConnection): void {
    this.#onConnection?.(conn);
  }
}

function fakeClock(start = 1000): Clock & { set(t: number): void } {
  let t = start;
  return { now: () => t, set: (v: number) => (t = v) };
}

function registerFrame(instance: string): Uint8Array {
  const frame: Frame = {
    lane: "control",
    family: "register",
    seq: 1,
    payload: { instance, capability: { cognition: "opus", family: "anthropic" } },
  };
  return encodeFrame(frame);
}

const goodAuth = sharedSecretAuthenticator({ secret: "s3cret" });

test("authenticates a connection and tracks it with liveness", async () => {
  const transport = new FakeTransport();
  const hub = new AgenticHub({ transport, authenticator: goodAuth, sweepIntervalMs: 0 });

  const conn = new FakeConnection("c1", { token: "s3cret", credential: "cap-1", remote: "peer-a" });
  transport.accept(conn);
  await tick();

  assert.equal(hub.connectionCount, 1);
  const entry = hub.registry.get("c1");
  assert.equal(entry?.identity, "peer-a");
  assert.equal(conn.closed, null);
  await hub.close();
});

test("rejects an unauthenticated connection without tracking it", async () => {
  const transport = new FakeTransport();
  const hub = new AgenticHub({ transport, authenticator: goodAuth, sweepIntervalMs: 0 });

  const conn = new FakeConnection("bad", { token: "wrong", credential: "cap-1" });
  transport.accept(conn);
  await tick();

  assert.equal(hub.connectionCount, 0);
  assert.equal(conn.closed?.code, 4401);
  await hub.close();
});

test("routes an inbound frame to the registered family handler", async () => {
  const transport = new FakeTransport();
  const hub = new AgenticHub({ transport, authenticator: goodAuth, sweepIntervalMs: 0 });

  const received: string[] = [];
  hub.registerFamilyHandler("register", (frame, ctx) => {
    const payload = frame.payload;
    const instance = typeof payload === "object" && payload !== null && "instance" in payload ? payload.instance : "?";
    ctx.registry.setPresence(ctx.id, { instance: String(instance) });
    received.push(`register:${ctx.id}`);
  });

  const conn = new FakeConnection("c1", { token: "s3cret", credential: "cap-1", remote: "peer-a" });
  transport.accept(conn);
  await tick();
  conn.receive(registerFrame("w-1"));
  await tick();

  assert.deepEqual(received, ["register:c1"]);
  assert.equal(hub.registry.get("c1")?.presence.instance, "w-1");
  await hub.close();
});

test("keeps the connection alive on a malformed frame but reports the error", async () => {
  const transport = new FakeTransport();
  const errors: unknown[] = [];
  const hub = new AgenticHub({
    transport,
    authenticator: goodAuth,
    sweepIntervalMs: 0,
    onError: (err) => errors.push(err),
  });

  const conn = new FakeConnection("c1", { token: "s3cret", credential: "cap-1", remote: "peer-a" });
  transport.accept(conn);
  await tick();
  conn.receive(new Uint8Array([0, 1, 2, 3])); // not a valid frame
  await tick();

  assert.equal(errors.length, 1);
  assert.equal(hub.connectionCount, 1); // still tracked
  assert.equal(conn.closed, null);
  await hub.close();
});

test("liveness: a malformed frame still refreshes lastSeen so an active peer is not swept", async () => {
  // A peer actively sending bytes is alive at the transport level even when the
  // bytes fail to decode; sweeping it as "silent" would drop a live connection.
  const clock = fakeClock(1000);
  const transport = new FakeTransport();
  const hub = new AgenticHub({ transport, authenticator: goodAuth, clock, sweepIntervalMs: 0 });

  const conn = new FakeConnection("c1", { token: "s3cret", credential: "cap-1", remote: "peer-a" });
  transport.accept(conn);
  await tick();

  clock.set(1000 + 20_000);
  conn.receive(new Uint8Array([0, 1, 2, 3])); // malformed, but proof of life
  await tick();

  clock.set(1000 + 40_000); // 40s since connect, but only 20s since last frame
  hub.sweepNow();
  assert.equal(hub.connectionCount, 1);
  assert.equal(conn.closed, null);
  await hub.close();
});

test("liveness: an inbound frame refreshes lastSeen so a live peer is not swept", async () => {
  const clock = fakeClock(1000);
  const transport = new FakeTransport();
  const hub = new AgenticHub({ transport, authenticator: goodAuth, clock, sweepIntervalMs: 0 });
  // registry TTL defaults to 30_000ms.

  const conn = new FakeConnection("c1", { token: "s3cret", credential: "cap-1", remote: "peer-a" });
  transport.accept(conn);
  await tick();

  clock.set(1000 + 20_000);
  conn.receive(registerFrame("w-1")); // refresh liveness
  await tick();

  clock.set(1000 + 40_000); // 40s since connect, but only 20s since last frame
  hub.sweepNow();
  assert.equal(hub.connectionCount, 1);
  assert.equal(conn.closed, null);
  await hub.close();
});

test("liveness: a silent peer ages out on the TTL and its socket is closed", async () => {
  const clock = fakeClock(1000);
  const transport = new FakeTransport();
  const hub = new AgenticHub({ transport, authenticator: goodAuth, clock, sweepIntervalMs: 0 });

  const conn = new FakeConnection("c1", { token: "s3cret", credential: "cap-1", remote: "peer-a" });
  transport.accept(conn);
  await tick();

  clock.set(1000 + 40_000); // > 30s TTL with no frame
  hub.sweepNow();

  assert.equal(hub.connectionCount, 0);
  assert.equal(conn.closed?.code, LIVENESS_TIMEOUT);
  await hub.close();
});

test("a keepalive pong refreshes liveness", async () => {
  const clock = fakeClock(1000);
  const transport = new FakeTransport();
  const hub = new AgenticHub({ transport, authenticator: goodAuth, clock, sweepIntervalMs: 0 });

  const conn = new FakeConnection("c1", { token: "s3cret", credential: "cap-1", remote: "peer-a" });
  transport.accept(conn);
  await tick();

  clock.set(1000 + 20_000);
  conn.pong();
  clock.set(1000 + 40_000);
  hub.sweepNow();

  assert.equal(hub.connectionCount, 1);
  await hub.close();
});

test("an inbound keepalive ping refreshes liveness", async () => {
  const clock = fakeClock(1000);
  const transport = new FakeTransport();
  const hub = new AgenticHub({ transport, authenticator: goodAuth, clock, sweepIntervalMs: 0 });

  const conn = new FakeConnection("c1", { token: "s3cret", credential: "cap-1", remote: "peer-a" });
  transport.accept(conn);
  await tick();

  clock.set(1000 + 20_000);
  conn.ping();
  clock.set(1000 + 40_000);
  hub.sweepNow();

  assert.equal(hub.connectionCount, 1);
  await hub.close();
});

test("liveness sweep reads time from the registry, not a separate hub clock (no clock drift)", async () => {
  // A pre-built registry stamps lastSeen with ITS clock; the hub must sweep
  // against that same clock. If the hub kept a separate, faster clock it would
  // spuriously age out a connection the registry still considers fresh — the
  // registry is the single source of truth for liveness time.
  const registryClock = fakeClock(1000);
  const registry = new ConnectionRegistry({ clock: registryClock });
  const hubClock = fakeClock(1000 + 100_000); // 100s ahead of the registry's clock
  const transport = new FakeTransport();
  const hub = new AgenticHub({ transport, authenticator: goodAuth, registry, clock: hubClock, sweepIntervalMs: 0 });

  const conn = new FakeConnection("c1", { token: "s3cret", credential: "cap-1", remote: "peer-a" });
  transport.accept(conn);
  await tick();

  // Neither clock advances: the connection was just seen at registryClock=1000,
  // well within the 30s TTL, so it must NOT be swept.
  hub.sweepNow();

  assert.equal(hub.connectionCount, 1);
  assert.equal(conn.closed, null);
  await hub.close();
});
test("a closed connection is removed from the registry", async () => {
  const transport = new FakeTransport();
  const hub = new AgenticHub({ transport, authenticator: goodAuth, sweepIntervalMs: 0 });

  const conn = new FakeConnection("c1", { token: "s3cret", credential: "cap-1", remote: "peer-a" });
  transport.accept(conn);
  await tick();
  assert.equal(hub.connectionCount, 1);

  conn.close(1000, "bye");
  assert.equal(hub.connectionCount, 0);
  await hub.close();
});

test("a peer that disconnects while auth is in flight is never left tracked", async () => {
  // The authenticator may be async (e.g. a network identity check). If the peer
  // vanishes mid-auth, the close event must not be missed — otherwise the hub
  // tracks a dead socket until a much later TTL sweep, inflating connectionCount.
  const transport = new FakeTransport();
  let release: ((r: AuthResult) => void) | undefined;
  const pending = new Promise<AuthResult>((resolve) => {
    release = resolve;
  });
  const hub = new AgenticHub({ transport, authenticator: () => pending, sweepIntervalMs: 0 });

  const conn = new FakeConnection("c1", { token: "s3cret", credential: "cap-1", remote: "peer-a" });
  transport.accept(conn); // begins #accept, awaits the pending authenticator
  await tick();

  conn.close(1001, "gone"); // peer disconnects before auth resolves
  release?.({ ok: true, grant: { identity: "peer-a" } });
  await tick();

  assert.equal(hub.connectionCount, 0);
  await hub.close();
});

test("close() terminates tracked connections so shutdown is deterministic", async () => {
  const transport = new FakeTransport();
  const hub = new AgenticHub({ transport, authenticator: goodAuth, sweepIntervalMs: 0 });

  const conn = new FakeConnection("c1", { token: "s3cret", credential: "cap-1", remote: "peer-a" });
  transport.accept(conn);
  await tick();
  assert.equal(hub.connectionCount, 1);

  await hub.close();

  assert.notEqual(conn.closed, null); // the socket was actively closed
  assert.equal(hub.connectionCount, 0);
});
