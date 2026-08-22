// e2e coverage for `bootTestApp` (issue #157, S2). Boots a real Urban app in-process
// against the WASM engine + a virtual clock, and drives all four surfaces the harness
// exposes: HTTP/UI, workers, SQLite, and the instance-tracking reconciler.
//
// The reconciler case is the reason this kit exists: a cancelled instance is TERMINATED,
// and the poll loop must patch the tracking row. Here that whole loop runs deterministically
// — no 15s wall-clock wait, no flaky poll — because `advanceTime` drives the virtual clock.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bootTestApp } from "./boot-app.ts";

const ORDER_BPMN = `<?xml version="1.0" encoding="UTF-8"?>
<definitions xmlns="http://www.omg.org/spec/BPMN/20100524/MODEL"
             xmlns:zeebe="http://camunda.org/schema/zeebe/1.0"
             targetNamespace="http://nanobpm/testkit">
  <process id="order" isExecutable="true">
    <startEvent id="s"/>
    <sequenceFlow id="f1" sourceRef="s" targetRef="pack"/>
    <serviceTask id="pack">
      <extensionElements><zeebe:taskDefinition type="order.pack"/></extensionElements>
    </serviceTask>
    <sequenceFlow id="f2" sourceRef="pack" targetRef="e"/>
    <endEvent id="e"/>
  </process>
</definitions>`;

const REVIEW_BPMN = `<?xml version="1.0" encoding="UTF-8"?>
<definitions xmlns="http://www.omg.org/spec/BPMN/20100524/MODEL"
             xmlns:zeebe="http://camunda.org/schema/zeebe/1.0"
             targetNamespace="http://nanobpm/testkit">
  <process id="review" isExecutable="true">
    <startEvent id="s"/>
    <sequenceFlow id="f1" sourceRef="s" targetRef="approve"/>
    <userTask id="approve"><extensionElements><zeebe:userTask/></extensionElements></userTask>
    <sequenceFlow id="f2" sourceRef="approve" targetRef="e"/>
    <endEvent id="e"/>
  </process>
</definitions>`;

const HANDLERS = `export const handlers = {
  "order.pack": async (job, app) => {
    await app.data.table("orders", "process_key").insert({
      process_key: job.processInstanceKey,
      status: "packed",
      note: job.variables.orderId ?? null,
    });
    return { packed: true };
  },
};`;

const MIGRATION = `CREATE TABLE orders (
  id INTEGER PRIMARY KEY,
  process_key TEXT,
  status TEXT,
  note TEXT
);`;

// A process whose single service task is served by a worker with a *real-time budget*: a poll loop
// that sources `now`/`wait` from the app clock (issue #408). The probe never becomes ready, so only
// the budget stops it — under the test kit that budget is the virtual clock, so `advanceTime` bounds
// the loop instead of it burning the real `PROBE_BUDGET_MS`.
const PROBE_BPMN = `<?xml version="1.0" encoding="UTF-8"?>
<definitions xmlns="http://www.omg.org/spec/BPMN/20100524/MODEL"
             xmlns:zeebe="http://camunda.org/schema/zeebe/1.0"
             targetNamespace="http://nanobpm/testkit">
  <process id="probe" isExecutable="true">
    <startEvent id="s"/>
    <sequenceFlow id="f1" sourceRef="s" targetRef="poll"/>
    <serviceTask id="poll">
      <extensionElements><zeebe:taskDefinition type="probe.poll"/></extensionElements>
    </serviceTask>
    <sequenceFlow id="f2" sourceRef="poll" targetRef="e"/>
    <endEvent id="e"/>
  </process>
</definitions>`;

const PROBE_HANDLERS = `export const handlers = {
  "probe.poll": async (job, app) => {
    // Bind the budget to the APP clock (not Date.now) and sleep on app.wait (not setTimeout), so the
    // loop advances only as virtual time does. A never-ready probe: only the budget stops it.
    const deadline = app.now() + 60000; // PROBE_BUDGET_MS = PT1M
    let attempts = 0;
    while (app.now() < deadline) {
      attempts += 1;
      await app.wait(10000); // PROBE_INTERVAL_MS
    }
    await app.data.table("probes", "process_key").insert({
      process_key: job.processInstanceKey,
      attempts,
    });
    return { readied: false, attempts };
  },
};`;

const PROBE_MIGRATION = `CREATE TABLE probes (
  id INTEGER PRIMARY KEY,
  process_key TEXT,
  attempts INTEGER
);`;

/** Build a minimal but complete Urban app on disk: two processes, a worker, a SQLite
 *  source with one migration, a webhook that starts `order`, and an instanceTracking
 *  binding that abandons a tracked row when its instance terminates. */
async function makeFixture(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "urban-testkit-boot-"));
  await mkdir(join(dir, "processes"), { recursive: true });
  await mkdir(join(dir, "workers"), { recursive: true });
  await mkdir(join(dir, "db", "migrations"), { recursive: true });
  await writeFile(join(dir, "processes", "order.bpmn"), ORDER_BPMN);
  await writeFile(join(dir, "processes", "review.bpmn"), REVIEW_BPMN);
  await writeFile(join(dir, "workers", "handlers.ts"), HANDLERS);
  await writeFile(join(dir, "db", "migrations", "001_init.sql"), MIGRATION);
  const manifest = {
    schemaVersion: 1,
    id: "testkit-boot-fixture",
    name: "Testkit Boot Fixture",
    models: { processes: ["processes/*.bpmn"] },
    data: {
      default: "app",
      sources: { app: { driver: "sqlite", url: "file:./db/app.db", migrations: "db/migrations" } },
    },
    workers: [{ taskType: "order.pack", handler: "workers/handlers.ts" }],
    triggers: [
      {
        id: "order-hook",
        type: "webhook",
        path: "/hooks/order",
        action: { start: "order", variables: "= body" },
      },
    ],
    instanceTracking: [
      {
        table: "orders",
        keyField: "process_key",
        statusField: "status",
        activeStatuses: ["active"],
        onTerminated: { set: { status: "abandoned" } },
        pollMs: 1000,
      },
    ],
  };
  await writeFile(join(dir, "nano.app.json"), JSON.stringify(manifest, null, 2));
  return dir;
}

test("bootTestApp drives HTTP → worker → SQLite in-process and deterministically", async () => {
  const dir = await makeFixture();
  const app = await bootTestApp(dir);
  try {
    // HTTP surface: post to the webhook trigger, which starts the `order` process.
    const res = await app.ui.call({
      method: "POST",
      path: "/hooks/order",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ orderId: "ord-1" }),
    });
    assert.ok((res.status ?? 200) < 300, `webhook accepted (status ${res.status})`);

    // No worker has run yet at this instant — settle drains the engine's queued job.
    await app.settle();

    // SQLite surface: the worker's insert is now visible through the data layer.
    const orders = app.db.table<{ process_key: string; status: string; note: string }>(
      "orders",
      "process_key",
    );
    const rows = await orders.all();
    assert.equal(rows.length, 1, "one order row written by the worker");
    assert.equal(rows[0].status, "packed");
    assert.equal(rows[0].note, "ord-1", "worker projected the webhook body variable");
  } finally {
    await app.stop();
    await rm(dir, { recursive: true, force: true });
  }
});

test("bootTestApp stops the in-process server so routes are no longer callable", async () => {
  const dir = await makeFixture();
  const app = await bootTestApp(dir);
  await app.stop();
  await rm(dir, { recursive: true, force: true });
  await assert.rejects(
    () => app.ui.call({ method: "GET", path: "/hooks/order" }),
    /no router mounted/,
    "a stopped app's captured handler is cleared, so a route call throws",
  );
});

test("bootTestApp stops the app when the seed step throws", async () => {
  const dir = await makeFixture();
  const boom = new Error("seed failed");
  await assert.rejects(
    () => bootTestApp(dir, { seed: () => Promise.reject(boom) }),
    /seed failed/,
    "a throwing seed rejects the boot and rolls the app back (no leaked engine/router)",
  );
  await rm(dir, { recursive: true, force: true });
});

test("bootTestApp reconciles a terminated instance's tracking row on advanceTime", async () => {
  const dir = await makeFixture();
  const app = await bootTestApp(dir);
  try {
    // Start a long-running instance (parks at the user task → ACTIVE) and track it.
    const { processInstanceKey } = await app.engine.createInstance({ processDefinitionId: "review" });
    const orders = app.db.table<{ process_key: string; status: string }>("orders", "process_key");
    await orders.insert({ process_key: processInstanceKey, status: "active" });

    // Terminate it. The row is still "active" — the reconciler poll hasn't fired yet.
    await app.engine.cancelInstance({ processInstanceKey });
    let row = await orders.findOne({ process_key: processInstanceKey });
    assert.equal(row?.status, "active", "row not yet reconciled before any poll fires");

    // Advance past the poll interval: the reconciler observes TERMINATED and patches the row.
    await app.advanceTime(1000);
    row = await orders.findOne({ process_key: processInstanceKey });
    assert.equal(row?.status, "abandoned", "reconciler abandoned the terminated instance's row");
  } finally {
    await app.stop();
    await rm(dir, { recursive: true, force: true });
  }
});

/** Build a minimal app whose one worker runs a time-bounded poll loop on the app clock (#408). */
async function makeProbeFixture(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "urban-testkit-probe-"));
  await mkdir(join(dir, "processes"), { recursive: true });
  await mkdir(join(dir, "workers"), { recursive: true });
  await mkdir(join(dir, "db", "migrations"), { recursive: true });
  await writeFile(join(dir, "processes", "probe.bpmn"), PROBE_BPMN);
  await writeFile(join(dir, "workers", "handlers.ts"), PROBE_HANDLERS);
  await writeFile(join(dir, "db", "migrations", "001_init.sql"), PROBE_MIGRATION);
  const manifest = {
    schemaVersion: 1,
    id: "testkit-probe-fixture",
    name: "Testkit Probe Fixture",
    models: { processes: ["processes/*.bpmn"] },
    data: {
      default: "app",
      sources: { app: { driver: "sqlite", url: "file:./db/app.db", migrations: "db/migrations" } },
    },
    workers: [{ taskType: "probe.poll", handler: "workers/handlers.ts" }],
  };
  await writeFile(join(dir, "nano.app.json"), JSON.stringify(manifest, null, 2));
  return dir;
}

test("bootTestApp bounds a time-bounded worker by advanceTime (virtual time, not real wall-time) — #408", async () => {
  // Regression guard for #408: before the virtual-clock scheduler was threaded into mountWorkers and
  // the app clock/`wait` seam was surfaced on AppApi, a worker with a real-time budget (poll loop,
  // backoff) hardwired Date.now()/setTimeout, so under the test kit it burned the FULL real budget
  // (~PT1M) while virtual time had already moved on. Now the handler sources now/wait from `app`, so
  // the whole loop settles over the virtual clock: `advanceTime` bounds it, and it never touches the
  // real wall clock.
  const dir = await makeProbeFixture();
  const app = await bootTestApp(dir);
  const wallStart = Date.now();
  try {
    // Start the instance: the poll worker is dispatched and parks on its first app.wait — the drain
    // does NOT block on it (a real push worker runs autonomously), so createInstance returns at once.
    const { processInstanceKey } = await app.engine.createInstance({ processDefinitionId: "probe" });
    const probes = app.db.table<{ process_key: string; attempts: number }>("probes", "process_key");

    // No virtual time has passed, so the loop is still parked — it has written nothing yet.
    await app.settle();
    assert.equal((await probes.all()).length, 0, "the never-ready loop must not finish before its budget");

    // Advance the whole PT1M budget in virtual time: this — and only this — bounds the loop.
    await app.advanceTime(60000);

    const rows = await probes.all();
    assert.equal(rows.length, 1, "the loop settled once its virtual budget elapsed");
    assert.equal(rows[0].attempts, 6, "exactly one poll per 10s interval across the 60s budget");
    assert.equal(app.scheduler.pending(), 0, "no virtual timers may leak past the budget");
  } finally {
    const wallElapsed = Date.now() - wallStart;
    assert.ok(
      wallElapsed < 10_000,
      `the worker must settle in virtual time, not burn the real 60s budget (took ${wallElapsed}ms real)`,
    );
    await app.stop();
    await rm(dir, { recursive: true, force: true });
  }
});

test("bootTestApp stop() cancels a worker parked on app.wait instead of hanging (#446 follow-up)", async () => {
  // Regression (issue #446 follow-up): a worker parked mid-`app.wait()` sits on a VIRTUAL timer that
  // only `advanceTime` fires. If `stop()` (→ `engine.close()`) is called before that timer's due
  // instant, the handler never settles on its own, so close()'s `#settleInflight()` used to await it
  // forever and teardown hung until the test-runner timeout. The engine's shutdown signal, threaded
  // into the scheduler backing `app.wait()`, now cancels that park at teardown: the wait rejects, the
  // handler unwinds, and stop() returns. Proven end-to-end through the real app boot + teardown path.
  const dir = await makeProbeFixture();
  const app = await bootTestApp(dir);
  let stopped = false;
  try {
    // Start the instance: the poll worker is dispatched and parks on its first app.wait(10s). No
    // virtual time passes, so it stays parked in-flight — the classic virtual-timer park.
    await app.engine.createInstance({ processDefinitionId: "probe" });
    await app.settle();
    assert.ok(app.scheduler.pending() > 0, "the worker must be parked on a virtual app.wait timer");

    // stop() closes the engine mid-park; it must cancel the wait via the shutdown signal rather than
    // await a virtual timer no advanceTime will ever fire. A hang would blow the runner timeout; the
    // real-time bound below additionally proves it did not silently burn wall-clock time. Capture the
    // clock immediately before stop() so the bound measures teardown, not the (unrelated) setup above.
    const wallStart = Date.now();
    await app.stop();
    stopped = true;
    assert.ok(Date.now() - wallStart < 10_000, "stop() must not hang on the parked virtual wait");
  } finally {
    if (!stopped) await app.stop();
    await rm(dir, { recursive: true, force: true });
  }
});
