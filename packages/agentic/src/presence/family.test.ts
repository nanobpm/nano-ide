import assert from "node:assert/strict";
import { setImmediate as tick } from "node:timers/promises";
import { test } from "node:test";
import { encodeFrame } from "../protocol/index.ts";
import type { Frame, MessageFamily } from "../protocol/index.ts";
import {
  AgenticHub,
  DuplicateFamilyHandlerError,
  sharedSecretAuthenticator,
} from "../channel/index.ts";
import type {
  ChannelConnection,
  ChannelTransport,
  Clock,
  CloseCode,
  HandshakeRequest,
} from "../channel/index.ts";
import { attachPresenceFamily, PresencePayloadError } from "./family.ts";
import { PresenceStore } from "./store.ts";
import { openTestDb } from "./test-db.ts";

/** In-memory connection the test drives directly — public-API fakes only. */
class FakeConnection implements ChannelConnection {
  readonly id: string;
  readonly handshake: HandshakeRequest;
  closed: { code?: CloseCode; reason?: string } | null = null;
  #onMessage: ((bytes: Uint8Array) => void) | undefined;
  #onClose: ((code?: CloseCode, reason?: string) => void) | undefined;

  constructor(id: string, handshake: HandshakeRequest) {
    this.id = id;
    this.handshake = handshake;
  }
  send(): void {}
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
  receive(bytes: Uint8Array): void {
    this.#onMessage?.(bytes);
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

function frame(family: MessageFamily, payload: unknown, seq = 1): Uint8Array {
  const f: Frame = { lane: "control", family, seq, payload };
  return encodeFrame(f);
}

const auth = sharedSecretAuthenticator({ secret: "s3cret" });

function connect(transport: FakeTransport, id: string, remote: string): FakeConnection {
  const conn = new FakeConnection(id, { token: "s3cret", credential: "cap-1", remote });
  transport.accept(conn);
  return conn;
}

test("a registering worker appears in the registry with presence + host/family via the S1 seam", async () => {
  const transport = new FakeTransport();
  const hub = new AgenticHub({ transport, authenticator: auth, sweepIntervalMs: 0 });
  const store = new PresenceStore(openTestDb(), { clock: fakeClock(5000) });
  attachPresenceFamily(hub, store, { sweepIntervalMs: 0 });

  const conn = connect(transport, "c1", "peer-a");
  await tick();
  conn.receive(frame("register", { instance: "w-1", capability: { family: "anthropic", host: "mac-1" } }));
  await tick();

  const row = store.get("w-1");
  assert.equal(row?.connectionId, "c1");
  assert.equal(row?.identity, "peer-a");
  assert.deepEqual(row?.capability, { family: "anthropic", host: "mac-1" });
  // The enrolment is mirrored onto S1's in-memory connection registry too.
  assert.deepEqual(
    hub.registry.get("c1")?.presence,
    { instances: new Map([["w-1", { family: "anthropic", host: "mac-1" }]]) },
  );

  await hub.close();
});

test("one connection multiplexes N instances; per-instance deregister unbinds one; disconnect drops all", async () => {
  const transport = new FakeTransport();
  const hub = new AgenticHub({ transport, authenticator: auth, sweepIntervalMs: 0 });
  const store = new PresenceStore(openTestDb(), { clock: fakeClock(5000) });
  attachPresenceFamily(hub, store, { sweepIntervalMs: 0 });

  // A single per-host supervisor connection registers THREE distinct workers.
  const conn = connect(transport, "c1", "supervisor-a");
  await tick();
  conn.receive(frame("register", { instance: "w-1", capability: { host: "mac-1" } }, 1));
  conn.receive(frame("register", { instance: "w-2", capability: { host: "mac-1" } }, 2));
  conn.receive(frame("register", { instance: "w-3", capability: { host: "mac-1" } }, 3));
  await tick();

  // All three attribute to the SAME connection, resolved by explicit instance.
  assert.deepEqual([...hub.registry.instancesForConnection("c1")].sort(), ["w-1", "w-2", "w-3"]);
  assert.equal(store.get("w-1")?.connectionId, "c1");
  assert.equal(store.get("w-2")?.connectionId, "c1");
  assert.equal(store.get("w-3")?.connectionId, "c1");

  // A per-instance deregister unbinds ONLY that instance; the others stay live.
  conn.receive(frame("deregister", { instance: "w-2" }, 4));
  await tick();
  assert.deepEqual([...hub.registry.instancesForConnection("c1")].sort(), ["w-1", "w-3"]);
  assert.equal(store.get("w-2"), undefined);
  assert.ok(store.get("w-1") !== undefined);

  // Disconnect drops ALL remaining instances on that connection.
  const dropped = store.removeByConnection("c1").sort();
  assert.deepEqual(dropped, ["w-1", "w-3"]);
  hub.registry.remove("c1");
  assert.deepEqual([...hub.registry.instancesForConnection("c1")], []);
  assert.equal(store.count(), 0);

  await hub.close();
});

test("attaches three distinct families through the seam and routes each to the store", async () => {
  const transport = new FakeTransport();
  const hub = new AgenticHub({ transport, authenticator: auth, sweepIntervalMs: 0 });
  const clock = fakeClock(1000);
  const store = new PresenceStore(openTestDb(), { clock });
  attachPresenceFamily(hub, store, { sweepIntervalMs: 0 });

  assert.deepEqual(hub.router.families().sort(), ["deregister", "heartbeat", "register"]);

  const conn = connect(transport, "c1", "peer-a");
  await tick();

  conn.receive(frame("register", { instance: "w-1", capability: { cognition: "opus" } }));
  await tick();
  assert.equal(store.get("w-1")?.lastSeen, 1000);

  clock.set(2500);
  conn.receive(frame("heartbeat", { instance: "w-1" }, 2));
  await tick();
  assert.equal(store.get("w-1")?.lastSeen, 2500, "heartbeat refreshed liveness");

  conn.receive(frame("deregister", { instance: "w-1" }, 3));
  await tick();
  assert.equal(store.get("w-1"), undefined, "deregister removed the row");

  await hub.close();
});

test("a foreign peer cannot hijack, heartbeat, or deregister another peer's instance", async () => {
  const transport = new FakeTransport();
  const errors: unknown[] = [];
  const hub = new AgenticHub({ transport, authenticator: auth, sweepIntervalMs: 0 });
  const clock = fakeClock(1000);
  const store = new PresenceStore(openTestDb(), { clock });
  attachPresenceFamily(hub, store, { sweepIntervalMs: 0, onError: (e) => errors.push(e) });

  const owner = connect(transport, "c1", "peer-a");
  const attacker = connect(transport, "c2", "peer-b");
  await tick();

  owner.receive(frame("register", { instance: "w-1", capability: { host: "owned" } }));
  await tick();
  assert.equal(store.get("w-1")?.identity, "peer-a");

  // Attacker (a different authenticated identity) tries to take over the instance.
  clock.set(2000);
  attacker.receive(frame("register", { instance: "w-1", capability: { host: "evil" } }, 2));
  await tick();
  let row = store.get("w-1");
  assert.equal(row?.identity, "peer-a", "register takeover blocked — owner keeps the row");
  assert.equal(row?.connectionId, "c1");
  assert.deepEqual(row?.capability, { host: "owned" });
  assert.equal(row?.lastSeen, 1000, "blocked register does not refresh liveness");
  assert.equal(errors.length, 1, "the blocked takeover is surfaced via onError");

  // Attacker cannot keep the instance alive on the owner's behalf.
  clock.set(5000);
  attacker.receive(frame("heartbeat", { instance: "w-1" }, 3));
  await tick();
  assert.equal(store.get("w-1")?.lastSeen, 1000, "foreign heartbeat is a no-op");

  // Attacker cannot deregister the owner's instance.
  attacker.receive(frame("deregister", { instance: "w-1" }, 4));
  await tick();
  assert.notEqual(store.get("w-1"), undefined, "foreign deregister is a no-op");

  // The genuine owner still controls its own instance.
  owner.receive(frame("heartbeat", { instance: "w-1" }, 2));
  await tick();
  assert.equal(store.get("w-1")?.lastSeen, 5000, "owner heartbeat refreshes liveness");
  owner.receive(frame("deregister", { instance: "w-1" }, 3));
  await tick();
  assert.equal(store.get("w-1"), undefined, "owner deregisters its own instance");

  await hub.close();
});

test("a malformed register frame is rejected and never touches the store", async () => {
  const transport = new FakeTransport();
  const errors: unknown[] = [];
  const hub = new AgenticHub({ transport, authenticator: auth, sweepIntervalMs: 0 });
  const store = new PresenceStore(openTestDb());
  attachPresenceFamily(hub, store, { sweepIntervalMs: 0, onError: (e) => errors.push(e) });

  const conn = connect(transport, "c1", "peer-a");
  await tick();
  // Missing the required `instance` field.
  conn.receive(frame("register", { capability: { host: "h" } }));
  await tick();

  assert.equal(store.count(), 0);
  assert.equal(errors.length, 1);

  await hub.close();
});

test("a non-object register payload is rejected with a payload error and never touches the store", async () => {
  const transport = new FakeTransport();
  const errors: unknown[] = [];
  const hub = new AgenticHub({ transport, authenticator: auth, sweepIntervalMs: 0 });
  const store = new PresenceStore(openTestDb());
  attachPresenceFamily(hub, store, { sweepIntervalMs: 0, onError: (e) => errors.push(e) });

  const conn = connect(transport, "c1", "peer-a");
  await tick();
  // A non-object payload (array) — validatePayload rejects it before it can
  // narrow to a record, so the store is never reached.
  conn.receive(frame("register", ["not", "an", "object"]));
  await tick();

  assert.equal(store.count(), 0);
  assert.equal(errors.length, 1);
  const err = errors[0];
  assert(err instanceof PresencePayloadError);
  assert.match(err.message, /must be an object/);

  await hub.close();
});

test("presence ages out on the TTL via the family sweep", async () => {
  const transport = new FakeTransport();
  const hub = new AgenticHub({ transport, authenticator: auth, sweepIntervalMs: 0 });
  const clock = fakeClock(1000);
  const store = new PresenceStore(openTestDb(), { ttlMs: 100, clock });
  const presence = attachPresenceFamily(hub, store, { sweepIntervalMs: 0 });

  const conn = connect(transport, "c1", "peer-a");
  await tick();
  conn.receive(frame("register", { instance: "w-1", capability: {} }));
  await tick();
  assert.equal(store.count(), 1);

  clock.set(1200); // age 200 > ttl 100
  const removed = presence.sweepNow();
  assert.deepEqual(removed.map((r) => r.instance), ["w-1"]);
  assert.equal(store.count(), 0);

  presence.stop();
  await hub.close();
});

test("attaching a second presence module to the same hub is rejected", () => {
  const transport = new FakeTransport();
  const hub = new AgenticHub({ transport, authenticator: auth, sweepIntervalMs: 0 });
  attachPresenceFamily(hub, new PresenceStore(openTestDb()), { sweepIntervalMs: 0 });
  assert.throws(
    () => attachPresenceFamily(hub, new PresenceStore(openTestDb()), { sweepIntervalMs: 0 }),
    DuplicateFamilyHandlerError,
  );
});
