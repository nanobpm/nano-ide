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
  assert.deepEqual(entry.presence, {});
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

test("setPresence merges S2's presence detail onto a live connection", () => {
  const registry = new ConnectionRegistry({ ttlMs: 100, clock: fakeClock() });
  registry.add("c1", "alice");

  registry.setPresence("c1", { instance: "w-1" });
  registry.setPresence("c1", { capability: { cognition: "opus", family: "anthropic" } });

  const entry = registry.get("c1");
  assert.equal(entry?.presence.instance, "w-1");
  assert.equal(entry?.presence.capability?.cognition, "opus");
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

test("touch/setPresence/remove on an unknown id are safe no-ops", () => {
  const registry = new ConnectionRegistry({ clock: fakeClock() });
  registry.touch("nope");
  registry.setPresence("nope", { instance: "x" });
  assert.equal(registry.remove("nope"), undefined);
  assert.equal(registry.size, 0);
});
