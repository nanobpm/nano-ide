import assert from "node:assert/strict";
import { test } from "node:test";
import type { Clock } from "@nanobpm/agentic-channel";
import { PresenceOwnershipError, PresenceStore } from "./store.ts";
import { openTestDb } from "./test-db.ts";

function fakeClock(start = 1000): Clock & { set(t: number): void } {
  let t = start;
  return { now: () => t, set: (v: number) => (t = v) };
}

function freshStore(opts: { ttlMs?: number; clock?: Clock } = {}): PresenceStore {
  const db = openTestDb();
  const store = new PresenceStore(db, opts);
  store.ensureSchema();
  return store;
}

test("register makes an instance appear with presence + host/family", () => {
  const clock = fakeClock(5000);
  const store = freshStore({ clock });

  const row = store.register({
    instance: "w-1",
    connectionId: "c1",
    identity: "peer-a",
    capability: { cognition: "opus", weight: 4, family: "anthropic", host: "mac-1" },
  });

  assert.equal(row.instance, "w-1");
  assert.equal(row.connectionId, "c1");
  assert.equal(row.identity, "peer-a");
  assert.deepEqual(row.capability, { cognition: "opus", weight: 4, family: "anthropic", host: "mac-1" });
  assert.equal(row.registeredAt, new Date(5000).toISOString());
  assert.equal(row.lastSeen, 5000);

  assert.deepEqual(store.get("w-1"), row);
  assert.equal(store.count(), 1);
  assert.deepEqual(store.list().map((r) => r.instance), ["w-1"]);
});

test("a partial capability stores only the declared attributes", () => {
  const store = freshStore();
  const row = store.register({
    instance: "w-2",
    connectionId: "c2",
    identity: "peer-b",
    capability: { family: "openai" },
  });
  assert.deepEqual(row.capability, { family: "openai" });
});

test("re-register keeps registered_at but refreshes connection, capability and liveness", () => {
  const clock = fakeClock(1000);
  const store = freshStore({ clock });
  store.register({ instance: "w-1", connectionId: "c1", identity: "peer-a", capability: { host: "h1" } });

  clock.set(2000);
  const again = store.register({
    instance: "w-1",
    connectionId: "c2",
    identity: "peer-a",
    capability: { host: "h2" },
  });

  assert.equal(again.registeredAt, new Date(1000).toISOString(), "registered_at is preserved");
  assert.equal(again.connectionId, "c2");
  assert.deepEqual(again.capability, { host: "h2" });
  assert.equal(again.lastSeen, 2000);
  assert.equal(store.count(), 1);
});

test("heartbeat refreshes liveness for a known instance and no-ops otherwise", () => {
  const clock = fakeClock(1000);
  const store = freshStore({ clock });
  store.register({ instance: "w-1", connectionId: "c1", identity: "peer-a", capability: {} });

  clock.set(9000);
  assert.equal(store.heartbeat("w-1"), true);
  assert.equal(store.get("w-1")?.lastSeen, 9000);

  assert.equal(store.heartbeat("nope"), false);
});

test("deregister removes an instance", () => {
  const store = freshStore();
  store.register({ instance: "w-1", connectionId: "c1", identity: "peer-a", capability: {} });
  assert.equal(store.deregister("w-1"), true);
  assert.equal(store.get("w-1"), undefined);
  assert.equal(store.deregister("w-1"), false);
});

test("register refuses to hijack an instance owned by a different identity", () => {
  const clock = fakeClock(1000);
  const store = freshStore({ clock });
  store.register({ instance: "w-1", connectionId: "c1", identity: "peer-a", capability: { host: "h1" } });

  clock.set(2000);
  assert.throws(
    () =>
      store.register({
        instance: "w-1",
        connectionId: "c2",
        identity: "peer-b",
        capability: { host: "evil" },
      }),
    PresenceOwnershipError,
  );

  // The original owner's row is untouched — no connection/identity/capability takeover.
  const row = store.get("w-1");
  assert.equal(row?.identity, "peer-a");
  assert.equal(row?.connectionId, "c1");
  assert.deepEqual(row?.capability, { host: "h1" });
  assert.equal(row?.lastSeen, 1000, "a blocked re-register does not refresh liveness");
});

test("heartbeat scoped to an identity no-ops for a foreign identity", () => {
  const clock = fakeClock(1000);
  const store = freshStore({ clock });
  store.register({ instance: "w-1", connectionId: "c1", identity: "peer-a", capability: {} });

  clock.set(9000);
  assert.equal(store.heartbeat("w-1", "peer-b"), false, "a foreign identity cannot refresh liveness");
  assert.equal(store.get("w-1")?.lastSeen, 1000, "liveness unchanged by a foreign heartbeat");

  assert.equal(store.heartbeat("w-1", "peer-a"), true, "the owning identity refreshes liveness");
  assert.equal(store.get("w-1")?.lastSeen, 9000);
});

test("deregister scoped to an identity no-ops for a foreign identity", () => {
  const store = freshStore();
  store.register({ instance: "w-1", connectionId: "c1", identity: "peer-a", capability: {} });

  assert.equal(store.deregister("w-1", "peer-b"), false, "a foreign identity cannot deregister");
  assert.notEqual(store.get("w-1"), undefined, "row survives a foreign deregister");

  assert.equal(store.deregister("w-1", "peer-a"), true, "the owning identity deregisters");
  assert.equal(store.get("w-1"), undefined);
});

test("sweep ages out instances past the TTL and keeps live ones", () => {
  const clock = fakeClock(1000);
  const store = freshStore({ ttlMs: 100, clock });

  store.register({ instance: "stale", connectionId: "c1", identity: "peer-a", capability: {} });
  clock.set(1050);
  store.register({ instance: "fresh", connectionId: "c2", identity: "peer-b", capability: {} });

  // now=1200: stale last_seen=1000 (age 200 > 100) ages out; fresh last_seen=1050 (age 150 > 100) too.
  // Bump fresh so only stale is old.
  clock.set(1120);
  store.heartbeat("fresh"); // fresh last_seen=1120
  const removed = store.sweep(1160); // stale age 160>100; fresh age 40<100

  assert.deepEqual(removed.map((r) => r.instance), ["stale"]);
  assert.deepEqual(store.list().map((r) => r.instance), ["fresh"]);
});

test("removeByConnection drops every instance on a dead connection", () => {
  const store = freshStore();
  store.register({ instance: "a", connectionId: "c1", identity: "peer-a", capability: {} });
  store.register({ instance: "b", connectionId: "c1", identity: "peer-a", capability: {} });
  store.register({ instance: "c", connectionId: "c2", identity: "peer-b", capability: {} });

  const removed = store.removeByConnection("c1").sort();
  assert.deepEqual(removed, ["a", "b"]);
  assert.deepEqual(store.list().map((r) => r.instance), ["c"]);
  assert.deepEqual(store.removeByConnection("cX"), []);
});
