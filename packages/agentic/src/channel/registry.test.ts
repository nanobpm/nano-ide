import assert from "node:assert/strict";
import { test } from "node:test";
import type { Clock } from "./clock.ts";
import { ConnectionRegistry } from "./registry.ts";

function fakeClock(start = 1000): Clock & { set(t: number): void } {
  let t = start;
  return { now: () => t, set: (v: number) => (t = v) };
}

test("tracks a connection with connectedAt/lastSeen and reports size", () => {
  const clock = fakeClock(1000);
  const registry = new ConnectionRegistry({ ttlMs: 100, clock });

  const entry = registry.add("c1", "alice");
  assert.equal(registry.size, 1);
  assert.equal(entry.identity, "alice");
  assert.equal(entry.connectedAt, 1000);
  assert.equal(entry.lastSeen, 1000);
  assert.deepEqual(entry.presence, { instances: new Map() });
  assert.ok(registry.has("c1"));
});

test("touch advances liveness to now", () => {
  const clock = fakeClock(1000);
  const registry = new ConnectionRegistry({ ttlMs: 100, clock });
  registry.add("c1", "alice");

  clock.set(1050);
  registry.touch("c1");
  assert.equal(registry.get("c1")?.lastSeen, 1050);
});

test("addInstance binds instances + capabilities; instancesForConnection resolves them", () => {
  const registry = new ConnectionRegistry({ ttlMs: 100, clock: fakeClock() });
  registry.add("c1", "alice");

  // One connection carries MANY instances (a supervisor multiplexing N workers).
  registry.addInstance("c1", "w-1", { cognition: "opus", family: "anthropic" });
  registry.addInstance("c1", "w-2", { cognition: "sonnet" });

  assert.deepEqual([...registry.instancesForConnection("c1")].sort(), ["w-1", "w-2"]);
  assert.equal(registry.capabilityForInstance("c1", "w-1")?.cognition, "opus");
  assert.equal(registry.capabilityForInstance("c1", "w-2")?.cognition, "sonnet");
  assert.equal(registry.capabilityForInstance("c1", "w-unknown"), undefined);
});

test("removeInstance unbinds a single instance; remove drops all instances on the connection", () => {
  const registry = new ConnectionRegistry({ ttlMs: 100, clock: fakeClock() });
  registry.add("c1", "alice");
  registry.addInstance("c1", "w-1");
  registry.addInstance("c1", "w-2");
  registry.addInstance("c1", "w-3");

  assert.equal(registry.removeInstance("c1", "w-2"), true);
  assert.equal(registry.removeInstance("c1", "w-2"), false); // idempotent
  assert.deepEqual([...registry.instancesForConnection("c1")].sort(), ["w-1", "w-3"]);

  // Dropping the connection drops ALL its remaining instances.
  registry.remove("c1");
  assert.deepEqual([...registry.instancesForConnection("c1")], []);
});

test("sweep ages out only connections past the TTL and returns them", () => {
  const clock = fakeClock(1000);
  const registry = new ConnectionRegistry({ ttlMs: 100, clock });
  registry.add("stale", "alice");
  registry.add("fresh", "bob");

  clock.set(1080);
  registry.touch("fresh"); // keep 'fresh' alive

  clock.set(1150); // stale.lastSeen=1000 (age 150 > 100); fresh.lastSeen=1080 (age 70)
  const removed = registry.sweep();

  assert.deepEqual(
    removed.map((r) => r.id),
    ["stale"],
  );
  assert.ok(!registry.has("stale"));
  assert.ok(registry.has("fresh"));
  assert.equal(registry.size, 1);
});

test("touch/addInstance/removeInstance/remove on an unknown id are safe no-ops", () => {
  const registry = new ConnectionRegistry({ clock: fakeClock() });
  registry.touch("nope");
  registry.addInstance("nope", "x");
  assert.equal(registry.removeInstance("nope", "x"), false);
  assert.deepEqual([...registry.instancesForConnection("nope")], []);
  assert.equal(registry.remove("nope"), undefined);
  assert.equal(registry.size, 0);
});
