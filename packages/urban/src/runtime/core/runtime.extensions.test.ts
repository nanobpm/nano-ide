import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createNodeHost } from "../adapters/node.ts";
import { createUrbanApp } from "./runtime.ts";
import type { EngineClient, JobHandler, WorkerSubscription } from "./host.ts";
import type { LifecycleEvent, UrbanExtension } from "./extensions.ts";

// A no-op engine double: the taxonomy wiring exercises lifecycle + extensions, so
// nothing here needs to deploy or register.
class NoopEngine implements EngineClient {
  async deployResources() {
    return { deployed: 0 };
  }
  async createInstance() {
    return { processInstanceKey: "pi-1" };
  }
  async cancelInstance() {}
  async publishMessage() {}
  async searchUserTasks() {
    return [];
  }
  async getForm() {
    return null;
  }
  async completeUserTask() {}
  async searchProcessInstances() {
    return [];
  }
  async registerWorker(jobType: string): Promise<WorkerSubscription> {
    return { jobType, unsubscribe: async () => {} };
  }
  async close() {}
}

// A bare app that mounts only the extension taxonomy — no deploy/data/http.
async function bareApp(extensions: readonly UrbanExtension[]) {
  const dir = await mkdtemp(join(tmpdir(), "urban-ext-"));
  await writeFile(
    join(dir, "nano.app.json"),
    JSON.stringify({ schemaVersion: 1, id: "ext-app", name: "Ext App" }),
  );
  const host = createNodeHost({ cwd: dir, log: () => {} });
  const app = await createUrbanApp({
    host,
    engine: new NoopEngine(),
    root: ".",
    port: 0,
    extensions,
    mount: {
      deploy: false,
      data: false,
      workers: false,
      surfaces: false,
      triggers: false,
      security: false,
      instanceTracking: false,
    },
  });
  return { app, dir };
}

test("runtime — lifecycle emits starting/started on start and stopping/stopped on stop", async () => {
  const phases: string[] = [];
  const recorder: UrbanExtension = {
    name: "phase-recorder",
    setup(ctx) {
      ctx.events.lifecycle.on((e: LifecycleEvent) => phases.push(e.phase));
    },
  };
  const { app, dir } = await bareApp([recorder]);
  try {
    // The recorder subscribes during start's extension mount, so it catches
    // `started` (emitted after mount) and both stop phases; `starting` fires before
    // any extension exists, by design.
    await app.start();
    await app.stop();
    assert.deepEqual(phases, ["started", "stopping", "stopped"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("runtime — a throwing extension does not strand app boot", async () => {
  const good: string[] = [];
  const boom: UrbanExtension = {
    name: "boom",
    order: 1,
    setup() {
      throw new Error("extension setup blew up");
    },
  };
  const healthy: UrbanExtension = {
    name: "healthy",
    order: 2,
    setup() {
      good.push("healthy");
    },
  };
  const { app, dir } = await bareApp([boom, healthy]);
  try {
    await app.start(); // must resolve despite `boom` throwing
    assert.deepEqual(good, ["healthy"]);
    const insp = app.inspect();
    assert.ok(insp.extensions, "extensions described in inspect()");
    await app.stop();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("runtime — extensions dispose cleanly across a start→stop→start cycle (no leaked listeners)", async () => {
  let liveTimers = 0;
  const poller: UrbanExtension = {
    name: "poller",
    setup(ctx) {
      const timer = setInterval(() => {}, 10_000);
      liveTimers += 1;
      ctx.events.lifecycle.on(() => {});
      ctx.effect(() => {
        clearInterval(timer);
        liveTimers -= 1;
      });
    },
  };
  const { app, dir } = await bareApp([poller]);
  try {
    await app.start();
    assert.equal(liveTimers, 1);
    assert.equal(app.events.lifecycle.size >= 1, true);
    await app.stop();
    // Dispose ladder unwound: the timer effect ran and the lifecycle listener is gone.
    assert.equal(liveTimers, 0);
    assert.equal(app.events.lifecycle.size, 0);

    // Restart: registrations rebuild without accumulating from the prior cycle.
    await app.start();
    assert.equal(liveTimers, 1);
    await app.stop();
    assert.equal(liveTimers, 0);
    assert.equal(app.events.lifecycle.size, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
