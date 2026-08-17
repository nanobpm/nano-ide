import { test } from "node:test";
import assert from "node:assert/strict";
import * as http from "node:http";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createNodeHost } from "../adapters/node.ts";
import { createUrbanApp, resolvePort } from "./runtime.ts";
import type { SchedulerDeps } from "./modules/scheduler.ts";
import { runFromEnv } from "../run.ts";
import { isRecord } from "./guards.ts";
import type {
  EngineClient,
  EngineJob,
  JobHandler,
  WorkerSubscription,
} from "./host.ts";

// A fake engine: records everything and lets the test deliver a job to a registered worker.
class FakeEngine implements EngineClient {
  deployed = 0;
  workers = new Map<string, JobHandler>();
  messages: { name: string; correlationKey?: string; variables?: Record<string, unknown> }[] = [];
  canceledInstances: string[] = [];
  completedTasks: { key: string; variables?: Record<string, unknown> }[] = [];
  userTasks = [{ userTaskKey: "ut-1", elementId: "approve", variables: {} }];

  async deployResources(r: { name: string }[]) {
    this.deployed += r.length;
    return { deployed: r.length };
  }
  async createInstance() {
    return { processInstanceKey: "pi-1" };
  }
  async cancelInstance(input: { processInstanceKey: string }) {
    this.canceledInstances.push(input.processInstanceKey);
  }
  async publishMessage(input: { name: string; correlationKey?: string; variables?: Record<string, unknown> }) {
    this.messages.push(input);
  }
  async searchUserTasks() {
    return this.userTasks;
  }
  async openUserTasks() {
    return this.userTasks;
  }
  async getForm() {
    return null;
  }
  async completeUserTask(key: string, variables?: Record<string, unknown>) {
    this.completedTasks.push({ key, variables });
  }
  async searchProcessInstances() {
    return [];
  }
  async registerWorker(jobType: string, handler: JobHandler): Promise<WorkerSubscription> {
    this.workers.set(jobType, handler);
    return { jobType, unsubscribe: async () => void this.workers.delete(jobType) };
  }
  async close() {}
  // test helper
  async deliver(jobType: string, job: EngineJob) {
    const h = this.workers.get(jobType);
    if (!h) throw new Error(`no worker for ${jobType}`);
    return h(job);
  }
}

function expectRecord(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new TypeError("expected record");
  return value;
}

function expectArray(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new TypeError("expected array");
  return value;
}

async function makeFixture(extraManifest?: Record<string, unknown>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "urban-rt-"));
  await mkdir(join(dir, "processes"));
  await mkdir(join(dir, "decisions"));
  await mkdir(join(dir, "forms"));
  await mkdir(join(dir, "db", "migrations"), { recursive: true });
  await mkdir(join(dir, "workers"));
  await writeFile(join(dir, "processes", "p.bpmn"), "<definitions/>");
  await writeFile(join(dir, "decisions", "d.dmn"), "<definitions/>");
  await writeFile(join(dir, "forms", "f.form"), "{}");
  await writeFile(
    join(dir, "db", "migrations", "001_init.sql"),
    "CREATE TABLE crew_tasks (id INTEGER PRIMARY KEY, title TEXT, status TEXT);",
  );
  await writeFile(
    join(dir, "workers", "handlers.ts"),
    `export const handlers = {
      "wf.claim": async (job, app) => {
        app.data.repo("task").insert({ title: job.variables.title, status: "claimed" });
        return { claimed: true, hasSdk: !!app.sdk, sdkMarker: app.sdk?.__marker };
      },
    };`,
  );
  const manifest = {
    schemaVersion: 1,
    id: "fixture-app",
    name: "Fixture App",
    models: { processes: ["processes/*.bpmn"], decisions: ["decisions/*.dmn"], forms: ["forms/*.form"] },
    data: { default: "app", sources: { app: { driver: "sqlite", url: "file:./db/app.db", migrations: "db/migrations" } } },
    types: { task: { table: "crew_tasks", fields: { title: { type: "string" }, status: { type: "string" } } } },
    workers: [{ taskType: "wf.claim", handler: "workers/handlers.ts" }],
    triggers: [{ id: "hook", type: "webhook", path: "/hooks/task", action: { message: "wf.requested", correlationKey: "= body.taskId" } }],
    surfaces: { taskInbox: { enabled: true, path: "/tasks" } },
    ...extraManifest,
  };
  await writeFile(join(dir, "nano.app.json"), JSON.stringify(manifest, null, 2));
  return dir;
}

test("runtime materializes the manifest end-to-end against a fake engine", async () => {
  const dir = await makeFixture();
  const host = createNodeHost({ cwd: dir, log: () => {} });
  const engine = new FakeEngine();
  const app = await createUrbanApp({ host, engine, root: ".", port: 0 });
  await app.start();

  try {
    // deploy
    assert.equal(engine.deployed, 3, "3 model files deployed");

    // migrations applied
    const insp = app.inspect();
    const data = expectRecord(insp.data);
    const sources = expectArray(data.sources).map(expectRecord);
    assert.deepEqual(sources[0].migrations, 1);

    // workers registered + data injected: deliver a job and see a DB row
    await engine.deliver("wf.claim", {
      jobKey: "j1",
      jobType: "wf.claim",
      variables: { title: "Fix bug" },
    });
    const rows = app.data!.repo("task").all<{ title: string; status: string }>();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].title, "Fix bug");
    assert.equal(rows[0].status, "claimed");

    // HTTP surfaces + triggers on the real node server
    const port = app.httpPort!;
    assert.ok(port > 0);

    const tasksRes = await fetch(`http://localhost:${port}/tasks/api/tasks`);
    assert.equal(tasksRes.status, 200);
    assert.equal(expectArray(await tasksRes.json()).length, 1);

    const hookRes = await fetch(`http://localhost:${port}/hooks/task`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ taskId: "T-9", title: "from webhook" }),
    });
    assert.equal(hookRes.status, 200);
    assert.equal(engine.messages.length, 1);
    assert.equal(engine.messages[0].name, "wf.requested");
    assert.equal(engine.messages[0].correlationKey, "T-9");

    // complete a user task through the surface API
    const done = await fetch(`http://localhost:${port}/tasks/api/complete`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ userTaskKey: "ut-1", variables: { approved: true } }),
    });
    assert.equal(done.status, 200);
    assert.equal(engine.completedTasks.length, 1);
    assert.equal(engine.completedTasks[0].key, "ut-1");

    // healthz
    const health = await fetch(`http://localhost:${port}/healthz`);
    assert.equal(expectRecord(await health.json()).ok, true);

    // field-drift guard
    assert.throws(() => app.data!.repo("task").insert({ bogus: 1 }));
    // all-declared-but-undefined payload throws (parity with Table.insert): the caller
    // meant to write those columns, so we don't silently insert a DEFAULT VALUES row.
    assert.throws(
      () => app.data!.repo("task").insert({ title: undefined, status: undefined }),
      /all values were undefined/,
    );
  } finally {
    await app.stop();
    await rm(dir, { recursive: true, force: true });
  }
});

test("threads the engine SDK client onto app.sdk for handlers (SDK-backed engine)", async () => {
  const dir = await makeFixture();
  const host = createNodeHost({ cwd: dir, log: () => {} });
  class SdkEngine extends FakeEngine {
    sdk = { __marker: "engine-sdk" };
  }
  const engine = new SdkEngine();
  const app = await createUrbanApp({ host, engine, root: ".", port: 0 });
  await app.start();

  try {
    const out = expectRecord(await engine.deliver("wf.claim", {
      jobKey: "j1",
      jobType: "wf.claim",
      variables: { title: "Fix bug" },
    }));
    assert.equal(out.hasSdk, true, "handler saw app.sdk");
    assert.equal(out.sdkMarker, "engine-sdk", "app.sdk is the engine's own client");
  } finally {
    await app.stop();
    await rm(dir, { recursive: true, force: true });
  }
});

test("app.sdk is undefined when the engine exposes no SDK client", async () => {
  const dir = await makeFixture();
  const host = createNodeHost({ cwd: dir, log: () => {} });
  const engine = new FakeEngine();
  const app = await createUrbanApp({ host, engine, root: ".", port: 0 });
  await app.start();

  try {
    const out = expectRecord(await engine.deliver("wf.claim", {
      jobKey: "j1",
      jobType: "wf.claim",
      variables: { title: "Fix bug" },
    }));
    assert.equal(out.hasSdk, false, "no app.sdk for a non-SDK engine");
    assert.equal(out.sdkMarker, undefined);
  } finally {
    await app.stop();
    await rm(dir, { recursive: true, force: true });
  }
});

test("exposes the native http server for a same-port WebSocket upgrade", async () => {
  const dir = await makeFixture();
  const host = createNodeHost({ cwd: dir, log: () => {} });
  const engine = new FakeEngine();
  const app = await createUrbanApp({ host, engine, root: ".", port: 0 });

  // undefined before start
  const httpServerBeforeStart = app.httpServer;
  assert.equal(httpServerBeforeStart, undefined);

  await app.start();
  try {
    // the live node:http Server, on the app's own port — narrow the getter's `object | undefined`
    // to a concrete server with runtime checks (no type assertion needed).
    const server = app.httpServer;
    if (server === undefined) throw new Error("httpServer should be defined after start");
    assert.ok(server instanceof http.Server, "httpServer is a node:http Server after start");

    // an attached 'upgrade' handler completes a WebSocket handshake on the app's port —
    // exactly what @nanobpm/agentic's WebSocketChannelTransport({ server }) needs.
    server.on("upgrade", (_req, socket) => {
      socket.write(
        "HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n",
      );
      socket.destroy();
    });

    const upgraded = await new Promise<boolean>((resolve, reject) => {
      const req = http.request({
        port: app.httpPort!,
        path: "/agentic",
        headers: { Connection: "Upgrade", Upgrade: "websocket" },
      });
      // fail fast rather than hang the runner if the handshake never happens
      const timer = setTimeout(() => {
        req.destroy();
        reject(new Error("upgrade handshake timed out"));
      }, 5000);
      req.on("upgrade", (_res, socket) => {
        clearTimeout(timer);
        socket.destroy();
        resolve(true);
      });
      // a plain HTTP response means the server did NOT upgrade — surface it clearly
      req.on("response", (res) => {
        clearTimeout(timer);
        res.resume();
        req.destroy();
        reject(new Error(`expected upgrade, got HTTP ${res.statusCode}`));
      });
      req.on("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });
      req.end();
    });
    assert.equal(upgraded, true, "upgrade handshake completed on the app port");
  } finally {
    await app.stop();
    await rm(dir, { recursive: true, force: true });
  }

  // undefined again after stop
  assert.equal(app.httpServer, undefined);
});

test("stop() completes promptly even with a lingering upgraded socket", async () => {
  const dir = await makeFixture();
  const host = createNodeHost({ cwd: dir, log: () => {} });
  const engine = new FakeEngine();
  const app = await createUrbanApp({ host, engine, root: ".", port: 0 });

  await app.start();
  const openSockets: import("node:stream").Duplex[] = [];
  try {
    const server = app.httpServer;
    if (server === undefined) throw new Error("httpServer should be defined after start");
    assert.ok(server instanceof http.Server, "httpServer is a node:http Server after start");

    // Complete the handshake but deliberately KEEP the upgraded socket open on both
    // ends — this is exactly the long-lived WebSocket case that would make a plain
    // `server.close()` hang forever.
    server.on("upgrade", (_req, socket) => {
      openSockets.push(socket);
      socket.write(
        "HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n",
      );
    });

    await new Promise<void>((resolve, reject) => {
      const req = http.request({
        port: app.httpPort!,
        path: "/agentic",
        headers: { Connection: "Upgrade", Upgrade: "websocket" },
      });
      const timer = setTimeout(() => {
        req.destroy();
        reject(new Error("upgrade handshake timed out"));
      }, 5000);
      req.on("upgrade", (_res, socket) => {
        clearTimeout(timer);
        openSockets.push(socket);
        resolve();
      });
      req.on("response", (res) => {
        clearTimeout(timer);
        res.resume();
        req.destroy();
        reject(new Error(`expected upgrade, got HTTP ${res.statusCode}`));
      });
      req.on("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });
      req.end();
    });

    // stop() must resolve without waiting on the still-open upgraded socket.
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("app.stop() hung on an open upgraded socket")), 5000);
      app.stop().then(
        () => {
          clearTimeout(timer);
          resolve();
        },
        (err) => {
          clearTimeout(timer);
          reject(err);
        },
      );
    });

    assert.equal(app.httpServer, undefined, "httpServer is undefined after stop");
  } finally {
    for (const s of openSockets) s.destroy();
    await rm(dir, { recursive: true, force: true });
  }
});

test("stop() resets state so the app can be cleanly restarted", async () => {
  const dir = await makeFixture();
  const host = createNodeHost({ cwd: dir, log: () => {} });
  const engine = new FakeEngine();
  const app = await createUrbanApp({ host, engine, root: ".", port: 0 });

  try {
    await app.start();
    const firstPort = app.httpPort!;
    assert.ok(firstPort > 0);
    await app.stop();

    // after stop, inspect() no longer carries stale describe data / port
    const stopped = app.inspect();
    assert.equal(stopped.httpPort, undefined);
    assert.equal(stopped.workers, undefined);

    // and a fresh start works (would throw "already started" if state leaked)
    await app.start();
    assert.ok(app.httpPort! > 0);
    // deploy ran again on the clean start, not doubled from the first run
    assert.equal(engine.deployed, 6);
  } finally {
    await app.stop();
    await rm(dir, { recursive: true, force: true });
  }
});

test("a failed start() tears down and resets state (no 'already started' wedge)", async () => {
  const dir = await makeFixture();
  const host = createNodeHost({ cwd: dir, log: () => {} });
  let failNextDeploy = true;
  const engine = new FakeEngine();
  const origDeploy = engine.deployResources.bind(engine);
  engine.deployResources = async (r: { name: string }[]) => {
    if (failNextDeploy) {
      failNextDeploy = false;
      throw new Error("boom during deploy");
    }
    return origDeploy(r);
  };
  const app = await createUrbanApp({ host, engine, root: ".", port: 0 });

  try {
    await assert.rejects(() => app.start(), /boom during deploy/);
    // state reset: not wedged, no leaked port/describe
    const s = app.inspect();
    assert.equal(s.httpPort, undefined);
    assert.equal(s.workers, undefined);
    // a subsequent start() succeeds rather than throwing "app already started"
    await app.start();
    assert.ok(app.httpPort! > 0);
  } finally {
    await app.stop();
    await rm(dir, { recursive: true, force: true });
  }
});

test("task-inbox /api/complete returns 400 on a malformed JSON body", async () => {
  const dir = await makeFixture();
  const host = createNodeHost({ cwd: dir, log: () => {} });
  const engine = new FakeEngine();
  const app = await createUrbanApp({ host, engine, root: ".", port: 0 });
  await app.start();
  try {
    const res = await fetch(`http://localhost:${app.httpPort!}/tasks/api/complete`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{not json",
    });
    assert.equal(res.status, 400);
    assert.equal(engine.completedTasks.length, 0);
  } finally {
    await app.stop();
    await rm(dir, { recursive: true, force: true });
  }
});

test("app.log is an app-level structured logger routed to the host sink", async () => {
  const dir = await makeFixture();
  const logs: Array<{ level: string; msg: string; fields?: Record<string, unknown> }> = [];
  const host = createNodeHost({ cwd: dir, log: (level, msg, fields) => logs.push({ level, msg, fields }) });
  const engine = new FakeEngine();
  const app = await createUrbanApp({ host, engine, root: ".", port: 0 });
  app.log.info("booting", { pid: 1 });
  assert.deepEqual(
    // `fields` is the merged bag, deliberately a null-prototype object (untrusted-key hardening);
    // spread it so the assertion compares contents, not prototype.
    logs.filter((l) => l.msg === "booting").map((l) => ({ ...l, fields: { ...l.fields } })),
    [{ level: "info", msg: "booting", fields: { pid: 1 } }],
  );
  // ergonomic methods + child binding are present on the handle logger
  const bound = app.log.child({ region: "eu" });
  bound.warn("slow");
  assert.deepEqual(
    logs.filter((l) => l.msg === "slow").map((l) => ({ ...l, fields: { ...l.fields } })),
    [{ level: "warn", msg: "slow", fields: { region: "eu" } }],
  );
});

test("resolvePort prefers explicit, then $PORT, then 8090; rejects bad $PORT", () => {
  assert.equal(resolvePort(3000, "9999"), 3000);
  assert.equal(resolvePort(undefined, "9999"), 9999);
  assert.equal(resolvePort(undefined, undefined), 8090);
  assert.equal(resolvePort(undefined, ""), 8090);
  assert.throws(() => resolvePort(undefined, "abc"), /invalid PORT/);
  assert.throws(() => resolvePort(undefined, "70000"), /invalid PORT/);
});

test("runFromEnv anchors the host at a non-'.' root without double-prefixing paths", async () => {
  const dir = await makeFixture();
  const engine = new FakeEngine();
  // No host passed → runFromEnv selects a host anchored at `dir`. The regression
  // guarded here: it must NOT also prefix `dir` inside createUrbanApp (which
  // would look for "<dir>/<dir>/nano.app.json" and fail).
  const app = await runFromEnv({ root: dir, engine, port: 0, handleSignals: false });
  try {
    assert.equal(app.manifest.id, "fixture-app");
    assert.equal(engine.deployed, 3, "models deployed from the correct root");
  } finally {
    await app.stop();
    await rm(dir, { recursive: true, force: true });
  }
});

// Captures console.log for the duration of `fn`, restoring it after.
async function captureStdout(fn: () => Promise<void>): Promise<string[]> {
  const lines: string[] = [];
  const original = console.log;
  console.log = (...args: unknown[]) => {
    lines.push(args.map((a) => (typeof a === "string" ? a : String(a))).join(" "));
  };
  try {
    await fn();
  } finally {
    console.log = original;
  }
  return lines;
}

test("emits the ADR 0057 boot handshake when NANOBPMN_APP_HANDSHAKE is set", async () => {
  const dir = await makeFixture();
  const host = createNodeHost({ cwd: dir, log: () => {} });
  const engine = new FakeEngine();
  const app = await createUrbanApp({ host, engine, root: ".", port: 0 });
  const prev = process.env.NANOBPMN_APP_HANDSHAKE;
  process.env.NANOBPMN_APP_HANDSHAKE = "1";
  try {
    const lines = await captureStdout(() => app.start());
    const handshake = lines.find((l) => l.startsWith("@@NBPM_LISTENING@@"));
    assert.ok(handshake, "a @@NBPM_LISTENING@@ line was emitted");
    const payload = JSON.parse(handshake!.slice("@@NBPM_LISTENING@@".length));
    assert.equal(payload.port, app.httpPort, "handshake reports the actual bound port");
    assert.ok(payload.port > 0);
  } finally {
    if (prev === undefined) delete process.env.NANOBPMN_APP_HANDSHAKE;
    else process.env.NANOBPMN_APP_HANDSHAKE = prev;
    await app.stop();
    await rm(dir, { recursive: true, force: true });
  }
});

test("does NOT emit the boot handshake without NANOBPMN_APP_HANDSHAKE", async () => {
  const dir = await makeFixture();
  const host = createNodeHost({ cwd: dir, log: () => {} });
  const engine = new FakeEngine();
  const app = await createUrbanApp({ host, engine, root: ".", port: 0 });
  const prev = process.env.NANOBPMN_APP_HANDSHAKE;
  delete process.env.NANOBPMN_APP_HANDSHAKE;
  try {
    const lines = await captureStdout(() => app.start());
    assert.ok(
      !lines.some((l) => l.startsWith("@@NBPM_LISTENING@@")),
      "no handshake line when the supervisor env is unset (clean terminal runs)",
    );
  } finally {
    if (prev !== undefined) process.env.NANOBPMN_APP_HANDSHAKE = prev;
    await app.stop();
    await rm(dir, { recursive: true, force: true });
  }
});

test("treats NANOBPMN_APP_HANDSHAKE other than \"1\" as opt-out", async () => {
  const dir = await makeFixture();
  const host = createNodeHost({ cwd: dir, log: () => {} });
  const engine = new FakeEngine();
  const app = await createUrbanApp({ host, engine, root: ".", port: 0 });
  const prev = process.env.NANOBPMN_APP_HANDSHAKE;
  process.env.NANOBPMN_APP_HANDSHAKE = "0";
  try {
    const lines = await captureStdout(() => app.start());
    assert.ok(
      !lines.some((l) => l.startsWith("@@NBPM_LISTENING@@")),
      '"0" is not the opt-in sentinel ("1"), so no handshake is emitted',
    );
  } finally {
    if (prev === undefined) delete process.env.NANOBPMN_APP_HANDSHAKE;
    else process.env.NANOBPMN_APP_HANDSHAKE = prev;
    await app.stop();
    await rm(dir, { recursive: true, force: true });
  }
});

// Read the interface a started app's HTTP server actually bound to (issue #235).
function appBoundAddress(app: { httpServer: object | undefined }): string {
  const native = app.httpServer;
  assert.ok(native instanceof http.Server, "app exposes a node http.Server");
  const addr = native.address();
  assert.ok(addr && typeof addr === "object", "server has a bound AddressInfo");
  return addr.address;
}

test("defaults to a loopback bind when the manifest omits network (issue #235)", async () => {
  const dir = await makeFixture();
  const host = createNodeHost({ cwd: dir, log: () => {} });
  const engine = new FakeEngine();
  const app = await createUrbanApp({ host, engine, root: ".", port: 0 });
  await app.start();
  try {
    assert.equal(appBoundAddress(app), "127.0.0.1");
  } finally {
    await app.stop();
    await rm(dir, { recursive: true, force: true });
  }
});

test('manifest network.bind:"all" binds every interface (issue #235)', async () => {
  const dir = await makeFixture({ network: { bind: "all" } });
  const logs: Array<{ level: string; msg: string }> = [];
  const host = createNodeHost({ cwd: dir, log: (level, msg) => logs.push({ level, msg }) });
  const engine = new FakeEngine();
  const app = await createUrbanApp({ host, engine, root: ".", port: 0 });
  await app.start();
  try {
    assert.equal(appBoundAddress(app), "0.0.0.0");
    // exposing the app off-box must never be silent
    assert.ok(
      logs.some((l) => l.level === "warn" && l.msg.includes("all interfaces")),
      "a warning is logged when binding to all interfaces",
    );
  } finally {
    await app.stop();
    await rm(dir, { recursive: true, force: true });
  }
});

test("URBAN_BIND=all overrides a loopback manifest (issue #235)", async () => {
  const dir = await makeFixture({ network: { bind: "loopback" } });
  const host = createNodeHost({ cwd: dir, log: () => {} });
  const engine = new FakeEngine();
  const prev = process.env.URBAN_BIND;
  process.env.URBAN_BIND = "all";
  let app: Awaited<ReturnType<typeof createUrbanApp>> | undefined;
  try {
    app = await createUrbanApp({ host, engine, root: ".", port: 0 });
    await app.start();
    assert.equal(appBoundAddress(app), "0.0.0.0");
  } finally {
    if (prev === undefined) delete process.env.URBAN_BIND;
    else process.env.URBAN_BIND = prev;
    await app?.stop();
    await rm(dir, { recursive: true, force: true });
  }
});

// A minimal deterministic scheduler seam: records armed timers so a test can assert the
// injected scheduler — not the live one — drives createUrbanApp's background loops.
function countingScheduler(): SchedulerDeps & { armed: () => number } {
  let clock = 0;
  let armed = 0;
  return {
    now: () => clock,
    setTimer: (_fn, _ms) => {
      armed += 1;
      return armed;
    },
    clearTimer: () => {},
    armed: () => armed,
  };
}

async function makeTrackingFixture(): Promise<string> {
  const dir = await makeFixture();
  const manifestPath = join(dir, "nano.app.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  manifest.instanceTracking = [
    {
      table: "crew_tasks",
      keyField: "id",
      statusField: "status",
      activeStatuses: ["claimed"],
      onTerminated: { set: { status: "abandoned" } },
      pollMs: 1000,
    },
  ];
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2));
  return dir;
}

test("threads an injected scheduler into the instance-tracking reconciler loop", async () => {
  const dir = await makeTrackingFixture();
  const host = createNodeHost({ cwd: dir, log: () => {} });
  const engine = new FakeEngine();
  const sched = countingScheduler();
  const app = await createUrbanApp({ host, engine, root: ".", port: 0, scheduler: sched });
  try {
    await app.start();
    // The reconciler arms its first poll on the injected scheduler, not the live one — so the
    // whole-app settle loop can drive it deterministically over a virtual clock.
    assert.ok(sched.armed() >= 1, "injected scheduler armed the reconciler poll");
  } finally {
    await app.stop();
    await rm(dir, { recursive: true, force: true });
  }
});
