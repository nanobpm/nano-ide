import { test } from "node:test";
import assert from "node:assert/strict";
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

async function makeFixture(): Promise<string> {
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
    logs.filter((l) => l.msg === "booting"),
    [{ level: "info", msg: "booting", fields: { pid: 1 } }],
  );
  // ergonomic methods + child binding are present on the handle logger
  const bound = app.log.child({ region: "eu" });
  bound.warn("slow");
  assert.deepEqual(
    logs.filter((l) => l.msg === "slow"),
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
