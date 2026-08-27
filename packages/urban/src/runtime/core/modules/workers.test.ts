import { test } from "node:test";
import { createLogger } from "../logger.ts";
import assert from "node:assert/strict";
import type { AppApi, RuntimeContext } from "../context.ts";
import type { EngineClient, EngineJob, HostContext, JobHandler, WorkerSubscription } from "../host.ts";
import type { AppManifest } from "../manifest.ts";
import { DataLayer, type ProvisionedSource } from "./datasource.ts";
import { mountWorkers, sdkDecisionEvaluator, type AppJobHandler } from "./workers.ts";
import { fakeScheduler } from "./scheduler.test-utils.ts";
import { makeGateway } from "./gateway.ts";
import { LineageStore } from "./lineage-store.ts";
import {
  __resetExecStoreForTests,
  currentJobContext,
  installExecStore,
  type JobExecContext,
} from "../execContext.ts";
import { createNodeHost } from "../../adapters/node.ts";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** A tiny engine that records registrations and can deliver a job to a handler. */
class MiniEngine implements EngineClient {
  workers = new Map<string, JobHandler>();
  async deployResources(): Promise<{ deployed: number }> { return { deployed: 0 }; }
  async createInstance(): Promise<{ processInstanceKey: string }> { return { processInstanceKey: "pi" }; }
  async cancelInstance(): Promise<void> {}
  async publishMessage(): Promise<void> {}
  async searchUserTasks(): Promise<[]> { return []; }
  async openUserTasks(): Promise<[]> { return []; }
  async getForm(): Promise<null> { return null; }
  async completeUserTask(): Promise<void> {}
  async searchProcessInstances(): Promise<[]> { return []; }
  async searchElementInstances(): Promise<[]> { return []; }
  async searchElementInstanceWaitStates(): Promise<[]> { return []; }
  async getElementInstance(): Promise<null> { return null; }
  async searchIncidents(): Promise<never[]> { return []; }
  async resolveIncident(): Promise<void> {}
  async updateJobRetries(): Promise<void> {}
  async setVariables(): Promise<void> {}
  async close(): Promise<void> {}
  async registerWorker(jobType: string, handler: JobHandler): Promise<WorkerSubscription> {
    this.workers.set(jobType, handler);
    return { jobType, unsubscribe: async () => void this.workers.delete(jobType) };
  }
  deliver(jobType: string, job: EngineJob) {
    const h = this.workers.get(jobType);
    if (!h) throw new Error(`no worker for ${jobType}`);
    return h(job);
  }
}

function makeCtx(
  manifest: Partial<AppManifest>,
  engine: MiniEngine,
): { ctx: RuntimeContext; logs: Array<{ level: string; msg: string }> } {
  const logs: Array<{ level: string; msg: string }> = [];
  const host: HostContext = {
    runtime: "node",
    env: () => undefined,
    readTextFile: async () => "",
    listDir: async () => [],
    exists: async () => false,
    openSqlite: () => {
      throw new Error("sqlite not used in this test");
    },
    importModule: () => Promise.reject(new Error("no modules in this test")),
    serveHttp: async () => ({ port: 0, stop: async () => {} }),
    now: () => 0,
    log: (level: string, msg: string) => logs.push({ level, msg }),
  };
  const ctx: RuntimeContext = {
    root: "/app",
    manifest: { schemaVersion: 1, id: "t", name: "T", ...manifest },
    engine,
    host,
  };
  return { ctx, logs };
}

function makeApp(over: Partial<AppApi> = {}): AppApi {
  const env: Record<string, string> = { NANO_APP_LLM_MODEL: "m" };
  return {
    manifest: { schemaVersion: 1, id: "t", name: "T" },
    data: new DataLayer(new Map(), undefined, {}),
    engine: new MiniEngine(),
    env: (n) => env[n],
    log: createLogger(() => {}),
    now: () => Date.now(),
    wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    ...over,
  };
}

function fakeFetch(content: string): typeof fetch {
  return async () => new Response(
    JSON.stringify({ choices: [{ message: { content } }] }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

const orig = globalThis.fetch;
function withFetch(content: string, fn: () => Promise<void>): Promise<void> {
  globalThis.fetch = fakeFetch(content);
  return fn().finally(() => {
    globalThis.fetch = orig;
  });
}

test("mountWorkers registers an llm-bound worker and runs the job through the model", async () => {
  const engine = new MiniEngine();
  const { ctx, logs } = makeCtx(
    {
      workers: [{ taskType: "classify", llm: "classifier" }],
      llm: { classifier: { provider: "env", model: "" } },
    },
    engine,
  );
  const handle = await mountWorkers(ctx, makeApp());
  assert.deepEqual(handle.jobTypes, ["classify"]);
  assert.ok(logs.some((l) => l.msg === "llm worker registered"));

  await withFetch("hi there", async () => {
    const out = await engine.deliver("classify", {
      jobKey: "j1",
      jobType: "classify",
      variables: { prompt: "who are you" },
    });
    assert.deepEqual(out, { text: "hi there" });
  });
  await handle.stop();
});

test("mountWorkers throws when an llm worker references an unknown binding", async () => {
  const engine = new MiniEngine();
  const { ctx } = makeCtx(
    { workers: [{ taskType: "classify", llm: "missing" }], llm: {} },
    engine,
  );
  await assert.rejects(mountWorkers(ctx, makeApp()), /unknown llm binding "missing"/);
});

test("mountWorkers skips (with a warning) a worker with neither handler nor llm", async () => {
  const engine = new MiniEngine();
  const { ctx, logs } = makeCtx({ workers: [{ taskType: "orphan" }] }, engine);
  const handle = await mountWorkers(ctx, makeApp());
  assert.deepEqual(handle.jobTypes, []);
  assert.ok(logs.some((l) => l.level === "warn" && /neither a handler nor an llm/.test(l.msg)));
});

test("an llm worker with decision rails uses app.sdk to evaluate the decision", async () => {
  const engine = new MiniEngine();
  const evaluated: Array<{ id: string; vars: Record<string, unknown> }> = [];
  const sdk = {
    evaluateDecision: async (input: { decisionDefinitionId: string; variables: Record<string, unknown> }) => {
      evaluated.push({ id: input.decisionDefinitionId, vars: input.variables });
      return { output: JSON.stringify({ approved: true }) };
    },
  };
  const { ctx } = makeCtx(
    {
      workers: [{ taskType: "risk", llm: "risker" }],
      llm: { risker: { provider: "env", model: "", output: { decision: "risk-table" } } },
    },
    engine,
  );
  const app = makeApp();
  Object.defineProperty(app, "sdk", { value: sdk });
  await mountWorkers(ctx, app);

  await withFetch('{"amount":100}', async () => {
    const out = await engine.deliver("risk", {
      jobKey: "j1",
      jobType: "risk",
      variables: { prompt: "score it" },
    });
    assert.deepEqual(out, { approved: true });
  });
  assert.deepEqual(evaluated, [{ id: "risk-table", vars: { amount: 100 } }]);
});

test("sdkDecisionEvaluator parses the decision's JSON-string output", async () => {
  const evaluate = sdkDecisionEvaluator({
    evaluateDecision: async () => ({ output: JSON.stringify({ ok: 1 }) }),
  });
  assert.deepEqual(await evaluate("d", {}), { ok: 1 });
});

test("sdkDecisionEvaluator passes through a non-string output", async () => {
  const evaluate = sdkDecisionEvaluator({
    evaluateDecision: async () => ({ output: { ok: 2 } }),
  });
  assert.deepEqual(await evaluate("d", {}), { ok: 2 });
});

test("sdkDecisionEvaluator throws with decision context on unparseable output", async () => {
  const evaluate = sdkDecisionEvaluator({
    evaluateDecision: async () => ({ output: "not json" }),
  });
  await assert.rejects(evaluate("risk", {}), /decision "risk" returned unparseable JSON/);
});

test("sdkDecisionEvaluator throws a clear error when the SDK lacks evaluateDecision", async () => {
  const evaluate = sdkDecisionEvaluator({});
  await assert.rejects(evaluate("risk", {}), /does not support evaluateDecision.*"risk"/);
});

test("mountWorkers silently skips a connector-backed worker (mountConnectors owns it)", async () => {
  const engine = new MiniEngine();
  const { ctx, logs } = makeCtx(
    { workers: [{ taskType: "slack:send-message", connector: "nano-ide-connector-slack" }] },
    engine,
  );
  const handle = await mountWorkers(ctx, makeApp());
  assert.deepEqual(handle.jobTypes, []);
  assert.equal(engine.workers.size, 0);
  // No spurious "neither a handler nor an llm" warning for a connector worker.
  assert.ok(!logs.some((l) => l.msg.includes("neither a handler nor an llm")));
});

test("mountWorkers binds the job's correlation context onto the handler's app.log", async () => {
  const engine = new MiniEngine();
  const { ctx } = makeCtx({ workers: [{ taskType: "charge", handler: "workers/charge.ts" }] }, engine);
  const captured: Array<{ level: string; msg: string; fields?: Record<string, unknown> }> = [];
  // The handler logs through the injected app; assert the runtime pre-bound the job context.
  const handler: AppJobHandler = (_job, app) => {
    app.log.info("charging", { amount: 100 });
    return { ok: true };
  };
  ctx.host.importModule = async () => ({ default: handler });
  const app = makeApp({
    log: createLogger((level, msg, fields) => {
      captured.push({ level, msg, fields });
    }),
  });
  await mountWorkers(ctx, app);
  await engine.deliver("charge", {
    jobKey: "j-7",
    jobType: "charge",
    processInstanceKey: "pi-42",
    elementId: "Task_Charge",
    variables: {},
  });
  assert.equal(captured.length, 1);
  assert.equal(captured[0].level, "info");
  assert.equal(captured[0].msg, "charging");
  assert.deepEqual(
    { ...captured[0].fields },
    {
      jobKey: "j-7",
      jobType: "charge",
      processInstanceKey: "pi-42",
      elementId: "Task_Charge",
      amount: 100,
    },
  );
});

test("mountWorkers omits absent instance/element from the bound log context", async () => {
  const engine = new MiniEngine();
  const { ctx } = makeCtx({ workers: [{ taskType: "ping", handler: "workers/ping.ts" }] }, engine);
  const captured: Array<Record<string, unknown> | undefined> = [];
  const handler: AppJobHandler = (_job, app) => {
    app.log.warn("no instance");
  };
  ctx.host.importModule = async () => ({ default: handler });
  const app = makeApp({
    log: createLogger((_level, _msg, fields) => {
      captured.push(fields);
    }),
  });
  await mountWorkers(ctx, app);
  await engine.deliver("ping", { jobKey: "j-1", jobType: "ping", variables: {} });
  assert.equal(captured.length, 1);
  assert.deepEqual({ ...captured[0] }, { jobKey: "j-1", jobType: "ping" });
});

// These are primarily compile-time assertions (the suite is typechecked by `tsc --noEmit`),
// with a runtime smoke that a typed handler still returns its output when delivered a job.
test("AppJobHandler carries optional In/Out variable types", async () => {
  // `In` is a plain interface — the `object` bound (not `Record<string, unknown>`) makes this
  // work, since interfaces have no implicit index signature.
  interface In {
    prKey: string;
    round: number;
    summary?: string;
  }
  interface Out {
    ok: boolean;
  }

  // In + Out: job.variables is typed as In, the return must be Out (or void).
  const typed: AppJobHandler<In, Out> = async (job) => {
    const key: string = job.variables.prKey; // typed access compiles
    const n: number = job.variables.round;
    return { ok: key.length > 0 && n >= 0 };
  };

  // In only: Out defaults to an open variables map, so any plain object of completion
  // variables may be returned.
  const inOnly: AppJobHandler<In> = (job) => ({ echoed: job.variables.prKey });

  // No parameters: fully open — the pre-generics behaviour.
  const open: AppJobHandler = (job) => ({ count: Object.keys(job.variables).length });

  // Returning nothing (void) is allowed under any parameterisation.
  const voidReturn: AppJobHandler<In> = () => {};

  const job: EngineJob<In> = {
    jobKey: "1",
    jobType: "pr.finalize",
    variables: { prKey: "p1", round: 2 },
  };
  // The open handler defaults `In` to a record; interface-typed jobs aren't assignable to it,
  // so hand it a plainly-typed job (the pre-generics shape).
  const openJob: EngineJob = {
    jobKey: "2",
    jobType: "pr.finalize",
    variables: { prKey: "p1", round: 2 },
  };
  const app = makeApp();

  assert.deepEqual(await typed(job, app), { ok: true });
  assert.deepEqual(await inOnly(job, app), { echoed: "p1" });
  assert.deepEqual(await open(openJob, app), { count: 2 });
  assert.equal(await voidReturn(job, app), undefined);
});

// --- Lineage threading + projection recording (issue #254) ---------------------

/** A DataLayer with a single default sqlite source, so `tryLineageStore` can record into it. */
async function dataLayerWithSqlite(): Promise<{ data: DataLayer; db: ProvisionedSource["db"]; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), "urban-workers-lineage-"));
  const host = createNodeHost({ cwd: dir, log: () => {} });
  const db = host.openSqlite(join(dir, "app.db"));
  const src: ProvisionedSource = {
    name: "main",
    driver: "sqlite",
    db,
    source: makeGateway(db),
    migrationsApplied: [],
    close: () => db.close(),
  };
  const data = new DataLayer(new Map([["main", src]]), "main", {});
  return { data, db, cleanup: async () => { try { db.close(); } catch { /* already closed */ } await rm(dir, { recursive: true, force: true }); } };
}

test("mountWorkers threads the lineage rootRequestKey into the ambient job context", async () => {
  __resetExecStoreForTests();
  const host = createNodeHost({ cwd: process.cwd(), log: () => {} });
  installExecStore(() => host.createAsyncStore?.<JobExecContext>());
  const engine = new MiniEngine();
  const { ctx } = makeCtx({ workers: [{ taskType: "spawn", handler: "workers/spawn.ts" }] }, engine);
  const seen: Array<JobExecContext | undefined> = [];
  const handler: AppJobHandler = () => {
    seen.push(currentJobContext());
  };
  ctx.host.importModule = async () => ({ default: handler });
  try {
    await mountWorkers(ctx, makeApp());
    // An instance carrying an envelope propagates its root.
    await engine.deliver("spawn", {
      jobKey: "j1",
      jobType: "spawn",
      processInstanceKey: "pi-child",
      variables: { _urban: { lineage: { rootRequestKey: "ROOT", causedByInstanceKey: "pi-parent" } } },
    });
    // An instance with no envelope is treated as its own root.
    await engine.deliver("spawn", { jobKey: "j2", jobType: "spawn", processInstanceKey: "pi-solo", variables: {} });
    assert.equal(seen[0]?.rootRequestKey, "ROOT");
    assert.equal(seen[1]?.rootRequestKey, "pi-solo");
  } finally {
    __resetExecStoreForTests();
  }
});

test("mountWorkers records each activated job's lineage edge into the projection (idempotently)", async () => {
  const engine = new MiniEngine();
  const { ctx } = makeCtx({ workers: [{ taskType: "work", handler: "workers/work.ts" }] }, engine);
  const handler: AppJobHandler = () => ({ ok: true });
  ctx.host.importModule = async () => ({ default: handler });
  const { data, db, cleanup } = await dataLayerWithSqlite();
  try {
    await mountWorkers(ctx, makeApp({ data }));
    const job = {
      jobKey: "j1",
      jobType: "work",
      processInstanceKey: "pi-child",
      variables: { _urban: { lineage: { rootRequestKey: "ROOT", causedByInstanceKey: "pi-root" } } },
    };
    await engine.deliver("work", job);
    await engine.deliver("work", { ...job, jobKey: "j2" }); // re-activation → idempotent

    const tree = new LineageStore(db).getLineage("ROOT");
    const child = tree.nodes.find((n) => n.instanceKey === "pi-child");
    assert.equal(child?.causedByInstanceKey, "pi-root");
    assert.equal(child?.edgeType, "weak");
    assert.equal(new LineageStore(db).edges("ROOT").length, 1, "re-activation does not duplicate the edge");
  } finally {
    await cleanup();
  }
});

test("mountWorkers records nothing when the app has no default data source (absent-safe)", async () => {
  const engine = new MiniEngine();
  const { ctx, logs } = makeCtx({ workers: [{ taskType: "work", handler: "workers/work.ts" }] }, engine);
  const handler: AppJobHandler = () => ({ ok: true });
  ctx.host.importModule = async () => ({ default: handler });
  // makeApp's DataLayer has no default source; mounting + delivering must not throw.
  await mountWorkers(ctx, makeApp());
  await engine.deliver("work", { jobKey: "j1", jobType: "work", processInstanceKey: "pi", variables: {} });
  assert.ok(!logs.some((l) => l.level === "error"));
});

test("mountWorkers surfaces a real provisioning failure as a warn (not the silent absent case)", async () => {
  const engine = new MiniEngine();
  const { ctx, logs } = makeCtx({ workers: [{ taskType: "work", handler: "workers/work.ts" }] }, engine);
  const handler: AppJobHandler = () => ({ ok: true });
  ctx.host.importModule = async () => ({ default: handler });
  const { data, db, cleanup } = await dataLayerWithSqlite();
  try {
    // A default source IS configured, but provisioning the projection fails (closed db). This is a
    // genuine fault, not the absent case, so it must be logged at `warn` with the error — never
    // disguised as an expected "no default data source" debug, and never a failed worker mount.
    db.close();
    await mountWorkers(ctx, makeApp({ data }));
    await engine.deliver("work", { jobKey: "j1", jobType: "work", processInstanceKey: "pi", variables: {} });
    const warned = logs.find((l) => l.level === "warn" && l.msg.includes("failed to provision"));
    assert.ok(warned, "a configured-but-broken datasource must warn, not silently degrade");
    assert.ok(!logs.some((l) => l.msg.includes("no default data source")), "must not claim the datasource is absent");
  } finally {
    await cleanup();
  }
});

test("mountWorkers surfaces a configured-but-missing default source as a warn (not the silent absent case)", async () => {
  const engine = new MiniEngine();
  const { ctx, logs } = makeCtx({ workers: [{ taskType: "work", handler: "workers/work.ts" }] }, engine);
  const handler: AppJobHandler = () => ({ ok: true });
  ctx.host.importModule = async () => ({ default: handler });
  // A default source is NAMED but no such source is provisioned, so `data.source()` throws
  // `no such data source "main"`. That is a genuine misconfiguration — it must warn, never be
  // disguised as the expected "no default data source" absent case.
  const data = new DataLayer(new Map(), "main", {});
  await mountWorkers(ctx, makeApp({ data }));
  await engine.deliver("work", { jobKey: "j1", jobType: "work", processInstanceKey: "pi", variables: {} });
  const warned = logs.find((l) => l.level === "warn" && l.msg.includes("failed to provision"));
  assert.ok(warned, "a configured-but-missing default source must warn, not silently degrade");
  assert.ok(!logs.some((l) => l.msg.includes("no default data source")), "must not claim the datasource is absent");
});
test("mountWorkers threads the injected scheduler: a worker's time-bounded loop is bounded by advanceTime, not real wall-time", async () => {
  // The regression this guards (#408): before the scheduler was threaded into mountWorkers,
  // a handler doing time-bounded work had to hardwire `Date.now()`/`setTimeout`, so under the
  // test kit it burned the FULL real budget while virtual time had already moved on. Now the
  // handler sources `now`/`wait` from `app`, so the loop advances only when the virtual clock
  // does — and a whole-app `advanceTime` bounds it.
  const BUDGET_MS = 60_000; // a real PT1M budget, like the readiness-probe symptom in the issue
  const INTERVAL_MS = 10_000;
  const sched = fakeScheduler(0);

  let attempts = 0;
  // A never-ready poll loop bound to the APP clock (deps-injected `now`/`wait` are the point).
  const probe: AppJobHandler = async (_job, appApi) => {
    const deadline = appApi.now() + BUDGET_MS;
    while (appApi.now() < deadline) {
      attempts += 1;
      await appApi.wait(INTERVAL_MS); // never becomes ready; only the budget stops it
    }
    return { readied: false, attempts };
  };

  const engine = new MiniEngine();
  const { ctx } = makeCtx({ workers: [{ taskType: "probe", handler: "workers/probe.ts" }] }, engine);
  ctx.host.importModule = async () => ({ default: probe });

  const handle = await mountWorkers(ctx, makeApp(), sched);
  assert.deepEqual(handle.jobTypes, ["probe"]);

  const wallStart = Date.now();
  // Deliver the job: the handler runs up to its first `app.wait` and parks on the virtual timer.
  const done = engine.deliver("probe", { jobKey: "j1", jobType: "probe", processInstanceKey: "pi", variables: {} });

  // Nothing has advanced the clock yet, so the loop is parked — not spinning on real time.
  assert.equal(sched.pending(), 1, "the handler must be parked on the virtual-clock wait, not a real timer");

  // Advance the virtual clock across the whole budget; this is what bounds the loop.
  await sched.advance(BUDGET_MS);
  const out = await done;

  const wallElapsed = Date.now() - wallStart;
  assert.deepEqual(out, { readied: false, attempts: 6 }, "the loop must run exactly over its virtual budget");
  assert.equal(sched.pending(), 0, "no virtual timers may leak past the budget");
  assert.ok(
    wallElapsed < 5_000,
    `the loop must settle in virtual time, not burn the real ${BUDGET_MS}ms budget (took ${wallElapsed}ms real)`,
  );

  await handle.stop();
});

test("mountWorkers defaults the app clock to real timers when no scheduler is injected", async () => {
  // Production parity: with no injected scheduler the handler's `app.now()`/`app.wait()` must fall
  // through to the default seam — `Date.now()` + `globalThis.setTimeout`. Assert that seam directly
  // by stubbing both globals, so the test is deterministic (no real 5ms sleep, no timer-jitter/clock-
  // resolution race) and proves the exact wiring rather than an observable side effect of it.
  const realSetTimeout = globalThis.setTimeout;
  const realDateNow = Date.now;
  const armedDelays: number[] = [];
  let clock = 1_000;
  try {
    Date.now = () => clock;
    // Object.assign carries realSetTimeout's full type (incl. `__promisify__`), so the merged value
    // stays assignable to `typeof globalThis.setTimeout` without a cast; the spy fires ASAP and
    // advances the fake clock by the armed delay, so no real wall-time elapses.
    globalThis.setTimeout = Object.assign((fn: () => void, ms?: number) => {
      armedDelays.push(ms ?? 0);
      clock += ms ?? 0;
      return realSetTimeout(fn, 0);
    }, realSetTimeout);

    let observed = -1;
    const handler: AppJobHandler = async (_job, appApi) => {
      const before = appApi.now();
      await appApi.wait(5); // must arm the default (stubbed) setTimeout with delay 5
      observed = appApi.now() - before;
      return { ok: true };
    };
    const engine = new MiniEngine();
    const { ctx } = makeCtx({ workers: [{ taskType: "tick", handler: "workers/tick.ts" }] }, engine);
    ctx.host.importModule = async () => ({ default: handler });

    const handle = await mountWorkers(ctx, makeApp()); // no scheduler → defaultScheduler()
    const out = await engine.deliver("tick", { jobKey: "j1", jobType: "tick", processInstanceKey: "pi", variables: {} });
    assert.deepEqual(out, { ok: true });
    assert.ok(armedDelays.includes(5), "app.wait(5) must arm the default globalThis.setTimeout seam with delay 5");
    assert.equal(observed, 5, "app.now must read the default Date.now clock (advanced by the armed 5ms timer)");
    await handle.stop();
  } finally {
    globalThis.setTimeout = realSetTimeout;
    Date.now = realDateNow;
  }
});
