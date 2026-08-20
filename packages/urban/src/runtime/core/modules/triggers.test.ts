import { test } from "node:test";
import { createLogger } from "../logger.ts";
import assert from "node:assert/strict";
import type { AppApi, RuntimeContext } from "../context.ts";
import type { EngineClient, HostContext, HttpRequest } from "../host.ts";
import type { Trigger } from "../manifest.ts";
import { makeRouter } from "../router.ts";
import { DataLayer } from "./datasource.ts";
import { evalCorrelation, mountTriggers, runTriggerAction, type SchedulerDeps } from "./triggers.ts";

interface EngineCall {
  kind: "start" | "message";
  target: string;
  variables?: Record<string, unknown>;
  correlationKey?: string;
}

class MiniEngine implements EngineClient {
  private readonly calls: EngineCall[];
  constructor(calls: EngineCall[]) {
    this.calls = calls;
  }
  async deployResources(): Promise<{ deployed: number }> { return { deployed: 0 }; }
  async createInstance(input: { processDefinitionId: string; variables?: Record<string, unknown> }): Promise<{ processInstanceKey: string }> {
    this.calls.push({ kind: "start", target: input.processDefinitionId, variables: input.variables });
    return { processInstanceKey: "pi-1" };
  }
  async cancelInstance(): Promise<void> {}
  async publishMessage(input: { name: string; correlationKey?: string; variables?: Record<string, unknown> }): Promise<void> {
    this.calls.push({ kind: "message", target: input.name, correlationKey: input.correlationKey, variables: input.variables });
  }
  async searchUserTasks(): Promise<[]> { return []; }
  async openUserTasks(): Promise<[]> { return []; }
  async getForm(): Promise<null> { return null; }
  async completeUserTask(): Promise<void> {}
  async searchProcessInstances(): Promise<[]> { return []; }
  async registerWorker(jobType: string): Promise<{ jobType: string; unsubscribe(): Promise<void> }> {
    return { jobType, unsubscribe: async () => {} };
  }
  async close(): Promise<void> {}
}

function fakeApp(): { app: AppApi; calls: EngineCall[]; logs: Array<{ level: string; msg: string }> } {
  const calls: EngineCall[] = [];
  const logs: Array<{ level: string; msg: string }> = [];
  const engine = new MiniEngine(calls);
  const app: AppApi = {
    manifest: { schemaVersion: 1, id: "t", name: "T" },
    data: new DataLayer(new Map(), undefined, {}),
    engine,
    env: () => undefined,
    now: () => 0,
    wait: () => Promise.resolve(),
    log: createLogger((level: string, msg: string) => {
      logs.push({ level, msg });
    }),
  };
  return { app, calls, logs };
}

function fakeCtx(triggers: Trigger[]): { ctx: RuntimeContext; hostLogs: Array<{ level: string; msg: string }> } {
  const hostLogs: Array<{ level: string; msg: string }> = [];
  const host: HostContext = {
    runtime: "node",
    env: () => undefined,
    readTextFile: async () => "",
    listDir: async () => [],
    exists: async () => false,
    openSqlite: () => {
      throw new Error("sqlite not used in this test");
    },
    importModule: async () => ({}),
    serveHttp: async () => ({ port: 0, stop: async () => {} }),
    now: () => 0,
    log: (level: string, msg: string) => hostLogs.push({ level, msg }),
  };
  const ctx: RuntimeContext = {
    root: "/app",
    manifest: { schemaVersion: 1, id: "t", name: "T", triggers },
    engine: new MiniEngine([]),
    host,
  };
  return { ctx, hostLogs };
}

/** A deterministic scheduler: timers fire only when the clock is advanced past their deadline. */
function fakeScheduler(startMs: number): SchedulerDeps & { advance: (ms: number) => Promise<void>; pending: () => number } {
  let clock = startMs;
  let seq = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  return {
    now: () => clock,
    setTimer: (fn, delayMs) => {
      const id = ++seq;
      timers.set(id, { at: clock + delayMs, fn });
      return id;
    },
    clearTimer: (h) => {
      if (typeof h === "number") timers.delete(h);
    },
    pending: () => timers.size,
    // Advance the clock, firing every timer whose deadline has passed (in order), letting
    // microtasks (the async action) drain between fires.
    advance: async (ms) => {
      const target = clock + ms;
      // Fire due timers one at a time; a timer's callback may schedule a new one.
      // deno-lint-ignore no-constant-condition
      while (true) {
        let nextId = -1;
        let nextAt = Infinity;
        for (const [id, t] of timers) {
          if (t.at <= target && t.at < nextAt) {
            nextAt = t.at;
            nextId = id;
          }
        }
        if (nextId < 0) break;
        const t = timers.get(nextId)!;
        timers.delete(nextId);
        clock = t.at;
        t.fn();
        await Promise.resolve();
        await Promise.resolve();
      }
      clock = target;
    },
  };
}

test("evalCorrelation resolves literals and = body paths", () => {
  const scope = { body: { taskId: 42 }, headers: {}, query: {} };
  assert.equal(evalCorrelation("lit", scope), "lit");
  assert.equal(evalCorrelation("= body.taskId", scope), "42");
  assert.equal(evalCorrelation("= body.missing", scope), undefined);
  assert.equal(evalCorrelation(undefined, scope), undefined);
});

test("resolveExpr ignores inherited (prototype-chain) properties", () => {
  const scope = { body: { id: "x" }, headers: {}, query: {} };
  // `constructor`/`toString` live on Object.prototype, not the body — must not resolve.
  assert.equal(evalCorrelation("= body.constructor", scope), undefined);
  assert.equal(evalCorrelation("= body.toString", scope), undefined);
  assert.equal(evalCorrelation("= body.__proto__", scope), undefined);
});

test("evalCorrelation returns undefined for a non-scalar result", () => {
  const scope = { body: { obj: { a: 1 }, arr: [1, 2], n: 7, flag: false }, headers: {}, query: {} };
  assert.equal(evalCorrelation("= body.obj", scope), undefined);
  assert.equal(evalCorrelation("= body.arr", scope), undefined);
  assert.equal(evalCorrelation("= body.n", scope), "7");
  assert.equal(evalCorrelation("= body.flag", scope), "false");
});

test("runTriggerAction starts a process with action.variables", async () => {
  const { app, calls } = fakeApp();
  // The manifest surface types `variables` as a FEEL string; the runtime helper
  // (runTriggerAction/resolveActionVariables) also accepts an inline object literal.
  const res = await runTriggerAction(app, { start: "proc-1", variables: { a: 1 } }, {
    body: { ignored: true },
    headers: {},
    query: {},
  });
  assert.equal(res.kind, "start");
  assert.equal(res.target, "proc-1");
  assert.deepEqual(calls, [{ kind: "start", target: "proc-1", variables: { a: 1 } }]);
});

test("runTriggerAction publishes a message, defaulting variables to the body", async () => {
  const { app, calls } = fakeApp();
  const res = await runTriggerAction(app, { message: "msg-1", correlationKey: "= body.id" }, {
    body: { id: "k1", v: 9 },
    headers: {},
    query: {},
  });
  assert.equal(res.kind, "message");
  assert.equal(res.correlationKey, "k1");
  assert.deepEqual(calls, [
    { kind: "message", target: "msg-1", correlationKey: "k1", variables: { id: "k1", v: 9 } },
  ]);
});

test("runTriggerAction resolves a FEEL-string action.variables to an object", async () => {
  const { app, calls } = fakeApp();
  const res = await runTriggerAction(app, { start: "proc-2", variables: "= body.vars" }, {
    body: { vars: { a: 1, b: "x" }, other: true },
    headers: {},
    query: {},
  });
  assert.equal(res.kind, "start");
  assert.deepEqual(calls, [{ kind: "start", target: "proc-2", variables: { a: 1, b: "x" } }]);
});

test("runTriggerAction falls back to the body when a FEEL-string variables misses", async () => {
  const { app, calls } = fakeApp();
  await runTriggerAction(app, { message: "m", variables: "= body.nope" }, {
    body: { k: 1 },
    headers: {},
    query: {},
  });
  assert.deepEqual(calls[0].variables, { k: 1 });
});

test("cron trigger fires its action on schedule and reschedules", async () => {
  const { app, calls } = fakeApp();
  const { ctx } = fakeCtx([
    { id: "nightly", type: "cron", spec: "0 6 * * *", action: { start: "daily-report" } },
  ]);
  // 2026-08-01T05:00:00Z — next 06:00 fire is 1h away.
  const sched = fakeScheduler(Date.parse("2026-08-01T05:00:00Z"));
  const handle = mountTriggers(ctx, app, sched);
  assert.deepEqual(handle.describe?.(), { mounted: [], scheduled: ["nightly@0 6 * * *"] });
  assert.equal(sched.pending(), 1);

  await sched.advance(60 * 60 * 1000); // advance 1h → 06:00 fires
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], { kind: "start", target: "daily-report", variables: { firedAt: "2026-08-01T06:00:00.000Z" } });
  assert.equal(sched.pending(), 1); // rearmed for the next day

  await sched.advance(24 * 60 * 60 * 1000); // next 06:00
  assert.equal(calls.length, 2);
  assert.equal(calls[1].variables?.firedAt, "2026-08-02T06:00:00.000Z");

  await handle.stop();
  assert.equal(sched.pending(), 0);
  await sched.advance(48 * 60 * 60 * 1000); // no more fires after stop
  assert.equal(calls.length, 2);
});

test("cron trigger with onMissed once/all warns and degrades to skip", async () => {
  const { app, logs } = fakeApp();
  const { ctx } = fakeCtx([
    { id: "c", type: "cron", spec: "0 6 * * *", onMissed: "all", action: { start: "p" } },
  ]);
  const sched = fakeScheduler(Date.parse("2026-08-01T05:00:00Z"));
  mountTriggers(ctx, app, sched);
  const warned = logs.find((l) => l.level === "warn" && /onMissed="all"/.test(l.msg));
  assert.ok(warned, "expected a warning that onMissed=all degrades to skip");
});

test("cron trigger with an invalid spec logs an error and does not schedule", () => {
  const { app, logs } = fakeApp();
  const { ctx } = fakeCtx([{ id: "bad", type: "cron", spec: "not a cron", action: { start: "p" } }]);
  const sched = fakeScheduler(0);
  const handle = mountTriggers(ctx, app, sched);
  assert.equal(sched.pending(), 0);
  assert.deepEqual(handle.describe?.(), { mounted: [], scheduled: [] });
  assert.ok(logs.some((l) => l.level === "error" && /invalid cron spec/.test(l.msg)));
});

test("cron trigger with no actionable action is not scheduled", () => {
  const { app, logs } = fakeApp();
  const { ctx } = fakeCtx([{ id: "noop", type: "cron", spec: "0 6 * * *", action: {} }]);
  const sched = fakeScheduler(0);
  const handle = mountTriggers(ctx, app, sched);
  assert.equal(sched.pending(), 0);
  assert.deepEqual(handle.describe?.(), { mounted: [], scheduled: [] });
  assert.ok(logs.some((l) => l.level === "warn" && /no action\.start\/message/.test(l.msg)));
});

test("cron trigger with an impossible spec warns and is not reported as scheduled", () => {
  const { app, logs } = fakeApp();
  const { ctx } = fakeCtx([{ id: "feb30", type: "cron", spec: "0 0 30 2 *", action: { start: "p" } }]);
  const sched = fakeScheduler(Date.parse("2026-01-01T00:00:00Z"));
  const handle = mountTriggers(ctx, app, sched);
  assert.equal(sched.pending(), 0);
  assert.deepEqual(handle.describe?.(), { mounted: [], scheduled: [] });
  assert.ok(logs.some((l) => l.level === "warn" && /never fires/.test(l.msg)));
});

test("cron trigger with a far-future fire chunks the wait instead of overflowing setTimeout", async () => {
  const { app, calls } = fakeApp();
  // Annual: Jan 1 00:00. Start just after so the next fire is ~1 year away (>> 24.8 days).
  const { ctx } = fakeCtx([{ id: "annual", type: "cron", spec: "0 0 1 1 *", action: { start: "yr" } }]);
  const start = Date.parse("2026-01-01T00:01:00Z");
  const nextFire = Date.parse("2027-01-01T00:00:00Z");
  const sched = fakeScheduler(start);
  const handle = mountTriggers(ctx, app, sched);
  assert.equal(sched.pending(), 1);

  // Advance to just before the deadline: the wait was chunked (re-armed) and never fired.
  await sched.advance(nextFire - start - 60_000);
  assert.equal(calls.length, 0);
  assert.equal(sched.pending(), 1);

  // Cross the deadline: fires exactly once, on the intended instant, then re-arms.
  await sched.advance(120_000);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].variables?.firedAt, "2027-01-01T00:00:00.000Z");
  await handle.stop();
});

test("webhook trigger still routes and publishes", async () => {
  const { app, calls } = fakeApp();
  const { ctx } = fakeCtx([
    { id: "hook", type: "webhook", action: { message: "got-it", correlationKey: "= body.id" } },
  ]);
  const handle = mountTriggers(ctx, app);
  const router = async (r: HttpRequest) => makeRouter(handle.routes)(r);
  const res = await router({
    method: "POST",
    path: "/hooks/hook",
    query: new URLSearchParams(""),
    headers: new Headers(),
    text: () => Promise.resolve(JSON.stringify({ id: "k9" })),
  });
  assert.equal(res.status ?? 200, 200);
  assert.deepEqual(calls, [
    { kind: "message", target: "got-it", correlationKey: "k9", variables: { id: "k9" } },
  ]);
  await handle.stop();
});
