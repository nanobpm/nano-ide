import { test } from "node:test";
import assert from "node:assert/strict";
import type { AppApi, RuntimeContext } from "../context.ts";
import type { EngineClient, EngineJob, HostContext, JobHandler, WorkerSubscription } from "../host.ts";
import type { AppManifest } from "../manifest.ts";
import { DataLayer } from "./datasource.ts";
import { mountWorkers, sdkDecisionEvaluator, type AppJobHandler } from "./workers.ts";

/** A tiny engine that records registrations and can deliver a job to a handler. */
class MiniEngine implements EngineClient {
  workers = new Map<string, JobHandler>();
  async deployResources(): Promise<{ deployed: number }> { return { deployed: 0 }; }
  async createInstance(): Promise<{ processInstanceKey: string }> { return { processInstanceKey: "pi" }; }
  async cancelInstance(): Promise<void> {}
  async publishMessage(): Promise<void> {}
  async searchUserTasks(): Promise<[]> { return []; }
  async completeUserTask(): Promise<void> {}
  async searchProcessInstances(): Promise<[]> { return []; }
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
    log: () => {},
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

// ── AppJobHandler generics: optional In/Out type parameters ──────────────────────────────
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
