import { test } from "node:test";
import assert from "node:assert/strict";
import { createLogger } from "./logger.ts";
import type { AppApi } from "./context.ts";
import {
  URBAN_EVENT_MODES,
  createUrbanEvents,
  mountExtensions,
  urbanEventMode,
  type GateDecision,
  type GateRequest,
  type UrbanExtension,
} from "./extensions.ts";
import { EventBus } from "./events.ts";

// A minimal AppApi double — the extension host only reaches for `log` (and hands
// `app` through to extensions untouched). The typed-but-unused fields are filled
// via `JSON.parse` (returns `any`) per AGENTS.md, never an `as`-cast.
function unused<T>(): T {
  return JSON.parse("null");
}

function fakeApi(): AppApi {
  return {
    manifest: unused(),
    data: unused(),
    engine: unused(),
    env: () => undefined,
    log: createLogger(() => {}),
  };
}

test("taxonomy — the typed channels agree with the documented mode table", () => {
  assert.equal(URBAN_EVENT_MODES.lifecycle, "emit");
  assert.equal(URBAN_EVENT_MODES["extension/register"], "serial");
  assert.equal(URBAN_EVENT_MODES["request/dispatch"], "waterfall");
  assert.equal(URBAN_EVENT_MODES["security/gate"], "waterfall");
  assert.equal(URBAN_EVENT_MODES.reconcile, "parallel");
  assert.equal(urbanEventMode("security/gate"), "waterfall");
});

test("taxonomy — createUrbanEvents declares every seam exactly once on a bus", () => {
  const bus = new EventBus();
  const events = createUrbanEvents(bus);
  assert.equal(events.lifecycle.mode, "emit");
  assert.equal(events.extensionRegister.mode, "serial");
  assert.equal(events.requestDispatch.mode, "waterfall");
  assert.equal(events.securityGate.mode, "waterfall");
  assert.equal(events.reconcile.mode, "parallel");
});

test("mountExtensions — runs the connector-pack / agentic-family surface through the taxonomy in a deterministic order", async () => {
  const registered: string[] = [];
  const mk = (name: string, order?: number): UrbanExtension => ({
    name,
    order,
    setup(ctx) {
      registered.push(name);
      ctx.events.lifecycle.on(() => {});
    },
  });

  // Hand them in a shuffled order; `order` (then registration order) decides.
  const host = await mountExtensions(fakeApi(), [mk("slack-pack", 10), mk("agentic-family"), mk("cron-pack", 5)]);
  assert.deepEqual(registered, ["agentic-family", "cron-pack", "slack-pack"]);
  await host.stop();
});

test("composition — order + short-circuit via the security/gate waterfall, then disposal", async () => {
  const audit: string[] = [];
  // Two connector-pack-style extensions each contribute a permission middleware.
  const allowAll: UrbanExtension = {
    name: "allow-all",
    order: 20,
    setup(ctx) {
      ctx.events.securityGate.on(async (req, next) => {
        audit.push(`allow-all:${req.action}`);
        return next(req);
      });
    },
  };
  const denyDeploy: UrbanExtension = {
    name: "deny-deploy",
    order: 10, // runs first — its short-circuit wins
    setup(ctx) {
      ctx.events.securityGate.on((req, next) => {
        audit.push(`deny-deploy:${req.action}`);
        if (req.action === "deploy") return { allow: false, reason: "deploy locked" };
        // Not our concern — delegate down the chain so later gates still run.
        return next(req);
      });
    },
  };

  // Private bus (no options): the host owns it, so `stop()` unwinds the whole ladder.
  const host = await mountExtensions(fakeApi(), [allowAll, denyDeploy]);

  const base = (_req: GateRequest): GateDecision => ({ allow: true });
  const decision = await host.events.securityGate.run({ subject: "u", action: "deploy", resource: "models" }, base);

  // deny-deploy ran first and short-circuited: allow-all never saw the request.
  assert.deepEqual(decision, { allow: false, reason: "deploy locked" });
  assert.deepEqual(audit, ["deny-deploy:deploy"]);

  // A non-deploy request is *not* deny-deploy's concern: it delegates via `next`, so
  // the downstream allow-all also runs. (Returning a bare decision instead of
  // `next(req)` would short-circuit the waterfall and starve allow-all.)
  audit.length = 0;
  const allowed = await host.events.securityGate.run({ subject: "u", action: "read", resource: "models" }, base);
  assert.deepEqual(allowed, { allow: true });
  assert.deepEqual(audit, ["deny-deploy:read", "allow-all:read"]);

  // Disposal: stop() unwinds every registration these extensions made.
  assert.ok(host.listenerCount >= 2);
  await host.stop();
  assert.equal(host.listenerCount, 0);
});

test("containment — a throwing extension setup never strands app boot or its siblings", async () => {
  const registered: string[] = [];
  const good1: UrbanExtension = {
    name: "good-1",
    order: 1,
    setup() {
      registered.push("good-1");
    },
  };
  const bad: UrbanExtension = {
    name: "bad",
    order: 2,
    setup() {
      throw new Error("plugin blew up during setup");
    },
  };
  const good2: UrbanExtension = {
    name: "good-2",
    order: 3,
    setup() {
      registered.push("good-2");
    },
  };

  // Must resolve (boot not stranded) and still mount the healthy siblings.
  const host = await mountExtensions(fakeApi(), [good1, bad, good2]);
  assert.deepEqual(registered, ["good-1", "good-2"]);
  await host.stop();
});

test("containment — a throwing listener does not strand a request going through the taxonomy", async () => {
  const throwing: UrbanExtension = {
    name: "throws-on-dispatch",
    setup(ctx) {
      ctx.events.requestDispatch.on(() => {
        throw new Error("bad middleware");
      });
    },
  };
  const host = await mountExtensions(fakeApi(), [throwing], { onError: () => {} });
  const res = await host.events.requestDispatch.run({ kind: "http", payload: "ping" }, (req) => ({
    handled: true,
    payload: `pong:${String(req.payload)}`,
  }));
  assert.deepEqual(res, { handled: true, payload: "pong:ping" });
  await host.stop();
});

test("HMR — start→stop→start leaks no listeners across cycles", async () => {
  const ext: UrbanExtension = {
    name: "leaky-candidate",
    setup(ctx) {
      ctx.events.lifecycle.on(() => {});
      ctx.events.reconcile.on(() => {});
      ctx.effect(() => {});
    },
  };

  for (let cycle = 0; cycle < 3; cycle++) {
    // Private bus per cycle: the host owns disposal, so stop() must fully unwind it.
    const host = await mountExtensions(fakeApi(), [ext]);
    assert.ok(host.listenerCount >= 3, `cycle ${cycle} registered listeners`);
    await host.stop();
    assert.equal(host.listenerCount, 0, `cycle ${cycle} disposed cleanly`);
  }
});

test("ownership — stop() leaves a shared app-wide bus for its owner to dispose", async () => {
  const bus = new EventBus();
  const events = createUrbanEvents(bus);
  // A core registration the owner (e.g. the runtime) makes outside the extension host.
  let coreDisposed = false;
  events.lifecycle.on(() => {});
  bus.effect(() => {
    coreDisposed = true;
  });

  const ext: UrbanExtension = {
    name: "pack",
    setup(ctx) {
      ctx.events.reconcile.on(() => {});
    },
  };
  const host = await mountExtensions(fakeApi(), [ext], { bus, events });

  await host.stop();
  // stop() does not own the shared bus, so it tears nothing down — the owner's core
  // registration survives until the owner itself disposes the bus.
  assert.equal(coreDisposed, false);
  assert.ok(bus.listenerCount >= 2);

  // The owner (runtime teardown) unwinds the whole ladder in one call.
  bus.dispose();
  assert.equal(coreDisposed, true);
  assert.equal(bus.listenerCount, 0);
});

test("mountExtensions — rejects a bus/events pair that is only half-provided", async () => {
  const bus = new EventBus();
  const events = createUrbanEvents(bus);
  await assert.rejects(() => mountExtensions(fakeApi(), [], { bus }), /provided together or both omitted/);
  await assert.rejects(() => mountExtensions(fakeApi(), [], { events }), /provided together or both omitted/);
});

test("effect() — an extension's arbitrary resource is torn down on stop", async () => {
  let timerCleared = false;
  const ext: UrbanExtension = {
    name: "poller",
    setup(ctx) {
      const timer = setInterval(() => {}, 1000);
      ctx.effect(() => {
        clearInterval(timer);
        timerCleared = true;
      });
    },
  };
  const host = await mountExtensions(fakeApi(), [ext]);
  assert.equal(timerCleared, false);
  await host.stop();
  assert.equal(timerCleared, true);
});

test("reconcile — parallel fan-out gives every extension's listener an independent chance", async () => {
  const bus = new EventBus({ onError: () => {} });
  const events = createUrbanEvents(bus);
  const ticks: string[] = [];
  const a: UrbanExtension = {
    name: "reconciler-a",
    setup(ctx) {
      ctx.events.reconcile.on(async () => {
        await Promise.resolve();
        ticks.push("a");
      });
    },
  };
  const b: UrbanExtension = {
    name: "reconciler-b",
    setup(ctx) {
      ctx.events.reconcile.on(() => {
        throw new Error("b unhealthy");
      });
    },
  };
  const c: UrbanExtension = {
    name: "reconciler-c",
    setup(ctx) {
      ctx.events.reconcile.on(async () => {
        await Promise.resolve();
        ticks.push("c");
      });
    },
  };
  const host = await mountExtensions(fakeApi(), [a, b, c], { bus, events });
  await events.reconcile.run({ source: "test", at: 0 });
  assert.deepEqual(ticks.sort(), ["a", "c"]);
  await host.stop();
});

test("effect() — returns the idempotent disposer so an extension can detach early before stop", async () => {
  let cleared = 0;
  let earlyDisposer: (() => void) | undefined;
  const ext: UrbanExtension = {
    name: "early-detach",
    setup(ctx) {
      earlyDisposer = ctx.effect(() => {
        cleared++;
      });
    },
  };
  const host = await mountExtensions(fakeApi(), [ext]);
  // `effect()` must hand back the disposer so the author can clean up early AND
  // remove the effect from the ladder so `stop()` won't run it a second time.
  assert.equal(typeof earlyDisposer, "function");
  earlyDisposer?.();
  assert.equal(cleared, 1);
  assert.equal(host.listenerCount, 0);
  await host.stop();
  assert.equal(cleared, 1, "already-detached effect must not run again on stop");
});

test("containment — a throwing setup rolls back its own partial registrations (atomic)", async () => {
  const bus = new EventBus({ onError: () => {} });
  const events = createUrbanEvents(bus);
  const seen: string[] = [];
  const partial: UrbanExtension = {
    name: "registers-then-throws",
    order: 1,
    setup(ctx) {
      ctx.events.lifecycle.on(() => seen.push("partial-listener"));
      ctx.effect(() => {});
      throw new Error("boom after partial registration");
    },
  };
  const healthy: UrbanExtension = {
    name: "healthy",
    order: 2,
    setup(ctx) {
      ctx.events.lifecycle.on(() => seen.push("healthy-listener"));
    },
  };
  const host = await mountExtensions(fakeApi(), [partial, healthy], { bus, events });
  // The failed extension left nothing live: only the healthy listener remains.
  assert.equal(host.listenerCount, 1);
  // A contained-and-skipped extension must not influence later dispatches.
  events.lifecycle.emit({ app: "x", phase: "started" });
  assert.deepEqual(seen, ["healthy-listener"]);
  await host.stop();
  // Bus is caller-owned, so the owner disposes it; the healthy listener then unwinds.
  bus.dispose();
  assert.equal(bus.listenerCount, 0);
});
