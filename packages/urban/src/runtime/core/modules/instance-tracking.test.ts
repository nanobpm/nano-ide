import { test } from "node:test";
import { createLogger } from "../logger.ts";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createNodeHost } from "../../adapters/node.ts";
import { makeGateway } from "./gateway.ts";
import type { Table } from "./gateway.ts";
import { DataLayer, type ProvisionedSource } from "./datasource.ts";
import type { AppApi } from "../context.ts";
import type { EngineClient, ProcessInstanceSnapshot, UserTaskFilter, UserTaskSummary } from "../host.ts";
import type { InstanceTracking } from "../manifest.ts";
import {
  DEFAULT_INSTANCE_TRACKING_POLL_MS,
  mountInstanceTracking,
  WAITING_HUMAN_PROBE_CONCURRENCY,
} from "./instance-tracking.ts";
import { MAX_TIMER_DELAY_MS, type SchedulerDeps } from "./scheduler.ts";

// A real-timer flush drains the entire pending microtask chain (find → engine → update)
// each time a fake timer fires — deeper than a fixed number of `await Promise.resolve()`s.
const realSetTimeout = globalThis.setTimeout;
const flush = () => new Promise<void>((r) => realSetTimeout(r, 0));

// A deterministic timer + clock seam (mirrors triggers.test.ts): `advance` fires every due
// timer in order, draining microtasks between fires so the async reconcile completes.
function fakeScheduler(): SchedulerDeps & { advance: (ms: number) => Promise<void>; pending: () => number } {
  let clock = 0;
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
    advance: async (ms) => {
      const target = clock + ms;
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
        await flush();
      }
      clock = target;
    },
  };
}

/** An EngineClient driven by a fixed map of processInstanceKey → state (for searchProcessInstances)
 *  and an optional map of processInstanceKey → number-of-open-user-tasks (for openUserTasks, the
 *  wait-on-human edge). Records the keys asked for on each call. `openUserTasks` models the engine
 *  truth the reconciler derives `awaiting_operator` from — only *open* (CREATED) tasks count, so a
 *  key absent from `openTasks` (or mapped to 0) reports no parked human. */
function fakeEngine(
  states: Record<string, ProcessInstanceSnapshot["state"]>,
  openTasks: Record<string, number> = {},
): {
  engine: EngineClient;
  queries: string[][];
  userTaskQueries: (string | undefined)[];
} {
  const queries: string[][] = [];
  const userTaskQueries: (string | undefined)[] = [];
  const notUsed = (m: string) => (): never => {
    throw new Error(`fakeEngine.${m} is not exercised by this test`);
  };
  // Typed as EngineClient (not `as unknown as`) so the compiler enforces the full contract:
  // if EngineClient gains/changes a method, this fake fails to compile instead of drifting.
  const engine: EngineClient = {
    async searchProcessInstances(filter?: {
      processInstanceKeys?: string[];
      state?: ProcessInstanceSnapshot["state"];
    }): Promise<ProcessInstanceSnapshot[]> {
      const keys = filter?.processInstanceKeys ?? [];
      queries.push([...keys]);
      const out: ProcessInstanceSnapshot[] = [];
      for (const key of keys) {
        const state = states[key];
        if (state && (!filter?.state || filter.state === state)) {
          out.push({ processInstanceKey: key, state });
        }
      }
      return out;
    },
    async openUserTasks(filter?: UserTaskFilter): Promise<UserTaskSummary[]> {
      const key = filter?.processInstanceKey;
      userTaskQueries.push(key);
      const n = key ? (openTasks[key] ?? 0) : 0;
      return Array.from({ length: n }, (_unused, i): UserTaskSummary => ({
        userTaskKey: `${key}-t${i}`,
      }));
    },
    deployResources: notUsed("deployResources"),
    createInstance: notUsed("createInstance"),
    cancelInstance: notUsed("cancelInstance"),
    publishMessage: notUsed("publishMessage"),
    searchUserTasks: notUsed("searchUserTasks"),
    getForm: notUsed("getForm"),
    completeUserTask: notUsed("completeUserTask"),
    registerWorker: notUsed("registerWorker"),
    close: notUsed("close"),
  };
  return { engine, queries, userTaskQueries };
}

interface Harness {
  api: AppApi;
  table: Table<PlanRow>;
  dir: string;
  close: () => Promise<void>;
  logs: { level: string; msg: string }[];
}

// The row shape every test seeds (matches PLANS_DDL); typing the harness table with it lets
// `table.get(...)` return a typed row instead of the generic `object` constraint that
// `ReturnType<DataLayer["table"]>` collapses to.
interface PlanRow {
  plan_key: string;
  process_key: string | null;
  status: string;
  note: string | null;
}

async function withHarness(
  engine: EngineClient,
  ddl: string,
  seed: (t: Table<PlanRow>) => Promise<void>,
  keyField = "process_key",
  table = "plans",
): Promise<Harness> {
  const dir = await mkdtemp(join(tmpdir(), "urban-instance-tracking-"));
  const host = createNodeHost({ cwd: dir, log: () => {} });
  const db = host.openSqlite(join(dir, "test.db"));
  db.exec(ddl);
  const source: ProvisionedSource = {
    name: "app",
    driver: "sqlite",
    db,
    source: makeGateway(db),
    migrationsApplied: [],
    close: () => db.close(),
  };
  const data = new DataLayer(new Map([["app", source]]), "app", {});
  const tbl = data.table<PlanRow>(table, keyField);
  await seed(tbl);
  const logs: { level: string; msg: string }[] = [];
  const api: AppApi = {
    manifest: { schemaVersion: 1, id: "app", name: "App" },
    data,
    engine,
    env: () => undefined,
    log: createLogger((level, msg) => {
      logs.push({ level, msg });
    }),
  };
  return {
    api,
    table: tbl,
    dir,
    logs,
    close: async () => {
      db.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

const PLANS_DDL =
  "CREATE TABLE plans (plan_key TEXT PRIMARY KEY, process_key TEXT, status TEXT NOT NULL, note TEXT)";

const planBinding = (over: Partial<InstanceTracking> = {}): InstanceTracking => ({
  table: "plans",
  keyField: "process_key",
  statusField: "status",
  activeStatuses: ["planning", "dispatched"],
  onTerminated: { set: { status: "abandoned", note: null } },
  pollMs: 1000,
  ...over,
});

test("reconciles an active row whose instance is TERMINATED", async () => {
  const { engine } = fakeEngine({ pi1: "TERMINATED" });
  const h = await withHarness(engine, PLANS_DDL, async (t) => {
    await t.insert({ plan_key: "p1", process_key: "pi1", status: "dispatched", note: "hi" });
  });
  const sched = fakeScheduler();
  const handle = mount(h, [planBinding()], sched);
  await sched.advance(1000);
  const row = await h.table.get("pi1");
  assert.equal(row?.status, "abandoned");
  assert.equal(row?.note, null);
  await handle.stop();
  await h.close();
});

test("leaves an active row whose instance is still ACTIVE untouched", async () => {
  const { engine } = fakeEngine({ pi1: "ACTIVE" });
  const h = await withHarness(engine, PLANS_DDL, async (t) => {
    await t.insert({ plan_key: "p1", process_key: "pi1", status: "dispatched", note: "hi" });
  });
  const sched = fakeScheduler();
  const handle = mount(h, [planBinding()], sched);
  await sched.advance(1000);
  const row = await h.table.get("pi1");
  assert.equal(row?.status, "dispatched");
  await handle.stop();
  await h.close();
});

test("does NOT reconcile a COMPLETED instance (a finalize worker owns that row)", async () => {
  const { engine, queries } = fakeEngine({ pi1: "COMPLETED" });
  const h = await withHarness(engine, PLANS_DDL, async (t) => {
    await t.insert({ plan_key: "p1", process_key: "pi1", status: "dispatched", note: "hi" });
  });
  const sched = fakeScheduler();
  const handle = mount(h, [planBinding()], sched);
  await sched.advance(1000);
  const row = await h.table.get("pi1");
  assert.equal(row?.status, "dispatched"); // untouched
  // and it did ask the engine, filtered to TERMINATED
  assert.deepEqual(queries, [["pi1"]]);
  await handle.stop();
  await h.close();
});

test("only polls rows in an active status (skips already-terminal rows)", async () => {
  const { engine, queries } = fakeEngine({ pi1: "TERMINATED", pi2: "TERMINATED" });
  const h = await withHarness(engine, PLANS_DDL, async (t) => {
    await t.insert({ plan_key: "p1", process_key: "pi1", status: "dispatched", note: null });
    await t.insert({ plan_key: "p2", process_key: "pi2", status: "abandoned", note: null }); // terminal
  });
  const sched = fakeScheduler();
  const handle = mount(h, [planBinding()], sched);
  await sched.advance(1000);
  assert.deepEqual(queries, [["pi1"]]); // pi2 was already terminal, never polled
  await handle.stop();
  await h.close();
});

test("skips rows whose key column is null/empty", async () => {
  const { engine, queries } = fakeEngine({});
  const h = await withHarness(engine, PLANS_DDL, async (t) => {
    await t.insert({ plan_key: "p1", process_key: null, status: "dispatched", note: null });
    await t.insert({ plan_key: "p2", process_key: "", status: "dispatched", note: null });
  });
  const sched = fakeScheduler();
  const handle = mount(h, [planBinding()], sched);
  await sched.advance(1000);
  assert.equal(queries.length, 0); // no keys to poll → no engine call
  await handle.stop();
  await h.close();
});

test("re-arms after each tick and stops cleanly", async () => {
  const { engine, queries } = fakeEngine({ pi1: "ACTIVE" });
  const h = await withHarness(engine, PLANS_DDL, async (t) => {
    await t.insert({ plan_key: "p1", process_key: "pi1", status: "dispatched", note: null });
  });
  const sched = fakeScheduler();
  const handle = mount(h, [planBinding()], sched);
  await sched.advance(1000);
  await sched.advance(1000);
  await sched.advance(1000);
  assert.equal(queries.length, 3); // polled once per interval
  assert.equal(sched.pending(), 1); // one timer armed for the next tick
  await handle.stop();
  assert.equal(sched.pending(), 0); // stop() cleared it
  await h.close();
});

test("without statusField/activeStatuses, polls every row", async () => {
  const { engine, queries } = fakeEngine({ pi1: "TERMINATED", pi2: "TERMINATED" });
  const h = await withHarness(engine, PLANS_DDL, async (t) => {
    await t.insert({ plan_key: "p1", process_key: "pi1", status: "abandoned", note: null });
    await t.insert({ plan_key: "p2", process_key: "pi2", status: "dispatched", note: null });
  });
  const sched = fakeScheduler();
  const binding = planBinding({ statusField: undefined, activeStatuses: undefined });
  const handle = mount(h, [binding], sched);
  await sched.advance(1000);
  assert.deepEqual(queries[0]?.sort(), ["pi1", "pi2"]);
  // both got reconciled (already-abandoned p1 is a no-op change, p2 flips)
  assert.equal((await h.table.get("pi2"))?.status, "abandoned");
  await handle.stop();
  await h.close();
});

test("terminalStatuses: reconciles a TERMINATED row in an un-enumerated non-terminal status (the allow-list regression)", async () => {
  // The row's status ("awaiting_operator") is listed in NEITHER activeStatuses nor terminalStatuses
  // — the exact drift an allow-list misses. A fail-open terminalStatuses selector still polls it.
  const { engine, queries } = fakeEngine({ pi1: "TERMINATED" });
  const h = await withHarness(engine, PLANS_DDL, async (t) => {
    await t.insert({ plan_key: "p1", process_key: "pi1", status: "awaiting_operator", note: "hi" });
  });
  const sched = fakeScheduler();
  const binding = planBinding({ activeStatuses: undefined, terminalStatuses: ["abandoned"] });
  const handle = mount(h, [binding], sched);
  await sched.advance(1000);
  assert.deepEqual(queries, [["pi1"]]); // it WAS polled despite not being in any enumerated list
  const row = await h.table.get("pi1");
  assert.equal(row?.status, "abandoned"); // …and reconciled
  await handle.stop();
  await h.close();
});

test("terminalStatuses: a row already in a terminal status is not polled", async () => {
  const { engine, queries } = fakeEngine({ pi1: "TERMINATED", pi2: "TERMINATED" });
  const h = await withHarness(engine, PLANS_DDL, async (t) => {
    await t.insert({ plan_key: "p1", process_key: "pi1", status: "awaiting_operator", note: null });
    await t.insert({ plan_key: "p2", process_key: "pi2", status: "abandoned", note: null }); // terminal
  });
  const sched = fakeScheduler();
  const binding = planBinding({ activeStatuses: undefined, terminalStatuses: ["abandoned"] });
  const handle = mount(h, [binding], sched);
  await sched.advance(1000);
  assert.deepEqual(queries, [["pi1"]]); // pi2 was already terminal, excluded from the poll
  await handle.stop();
  await h.close();
});

test("terminalStatuses wins when a binding somehow declares both selectors (fail-open)", async () => {
  // Validation rejects declaring both, but a hand-built binding must still behave predictably:
  // terminalStatuses (the fail-open selector) takes precedence over activeStatuses.
  const { engine, queries } = fakeEngine({ pi1: "TERMINATED" });
  const h = await withHarness(engine, PLANS_DDL, async (t) => {
    // status is NOT in activeStatuses — an allow-list would skip it — but IS non-terminal.
    await t.insert({ plan_key: "p1", process_key: "pi1", status: "awaiting_operator", note: null });
  });
  const sched = fakeScheduler();
  const binding = planBinding({ activeStatuses: ["planning"], terminalStatuses: ["abandoned"] });
  const handle = mount(h, [binding], sched);
  await sched.advance(1000);
  assert.deepEqual(queries, [["pi1"]]); // polled via the terminalStatuses selector
  assert.equal((await h.table.get("pi1"))?.status, "abandoned");
  await handle.stop();
  await h.close();
});

test("a malformed (non-array) terminalStatuses degrades to fail-open poll-all, not a Set-of-characters filter", async () => {
  // A hand-built/JSON binding could carry a bare string. The buggy path (`new Set("ab")`) would
  // filter rows by whether their status is one of those *characters* — silently dropping rows.
  // The shared `isConfiguredStatusSelector` gate makes a malformed selector fall through to the
  // fail-open poll-all path instead. Build the invalid fixture via JSON.parse (no `as` cast).
  const { engine, queries } = fakeEngine({ pi1: "TERMINATED", pi2: "TERMINATED" });
  const h = await withHarness(engine, PLANS_DDL, async (t) => {
    // Both statuses are single characters that appear in "abandoned" — the buggy Set-of-chars
    // filter would exclude them, polling nothing; the fail-open path polls both.
    await t.insert({ plan_key: "p1", process_key: "pi1", status: "a", note: null });
    await t.insert({ plan_key: "p2", process_key: "pi2", status: "b", note: null });
  });
  const malformed = JSON.parse('{"terminalStatuses":"abandoned","activeStatuses":null}');
  const sched = fakeScheduler();
  const binding = planBinding(malformed);
  const handle = mount(h, [binding], sched);
  await sched.advance(1000);
  assert.deepEqual(queries[0]?.sort(), ["pi1", "pi2"]); // fail-open: every row polled
  await handle.stop();
  await h.close();
});

test("a malformed (non-array) activeStatuses degrades to fail-open poll-all instead of crashing .map", async () => {
  const { engine, queries } = fakeEngine({ pi1: "TERMINATED", pi2: "TERMINATED" });
  const h = await withHarness(engine, PLANS_DDL, async (t) => {
    await t.insert({ plan_key: "p1", process_key: "pi1", status: "planning", note: null });
    await t.insert({ plan_key: "p2", process_key: "pi2", status: "dispatched", note: null });
  });
  const malformed = JSON.parse('{"activeStatuses":"planning","terminalStatuses":null}');
  const sched = fakeScheduler();
  const binding = planBinding(malformed);
  const handle = mount(h, [binding], sched);
  await sched.advance(1000);
  assert.deepEqual(queries[0]?.sort(), ["pi1", "pi2"]); // no crash; fail-open poll-all
  await handle.stop();
  await h.close();
});

test("defaults pollMs when the binding omits it", async () => {
  const { engine, queries } = fakeEngine({ pi1: "ACTIVE" });
  const h = await withHarness(engine, PLANS_DDL, async (t) => {
    await t.insert({ plan_key: "p1", process_key: "pi1", status: "dispatched", note: null });
  });
  const sched = fakeScheduler();
  const binding = planBinding({ pollMs: undefined });
  const handle = mount(h, [binding], sched);
  await sched.advance(DEFAULT_INSTANCE_TRACKING_POLL_MS - 1);
  assert.equal(queries.length, 0); // not yet
  await sched.advance(1);
  assert.equal(queries.length, 1); // fired at the default interval
  await handle.stop();
  await h.close();
});

test("clamps a pollMs beyond setTimeout's 32-bit range instead of firing immediately", async () => {
  const { engine, queries } = fakeEngine({ pi1: "ACTIVE" });
  const h = await withHarness(engine, PLANS_DDL, async (t) => {
    await t.insert({ plan_key: "p1", process_key: "pi1", status: "dispatched", note: null });
  });
  const sched = fakeScheduler();
  // A pollMs past the 32-bit signed range would overflow setTimeout and fire at ~0 (a hot loop).
  const handle = mount(h, [planBinding({ pollMs: MAX_TIMER_DELAY_MS * 3 })], sched);
  await sched.advance(1000);
  assert.equal(queries.length, 0); // did NOT fire immediately …
  await sched.advance(MAX_TIMER_DELAY_MS);
  assert.equal(queries.length, 1); // … it fired at the clamped delay
  await handle.stop();
  await h.close();
});

// A binding mounted without validation (or with a hand-built binding) must not become a
// 0-delay hot loop when pollMs is non-positive/NaN — it falls back to the default interval.
for (const bad of [0, -1000, Number.NaN]) {
  test(`falls back to the default interval for a non-positive/NaN pollMs (${bad})`, async () => {
    const { engine, queries } = fakeEngine({ pi1: "ACTIVE" });
    const h = await withHarness(engine, PLANS_DDL, async (t) => {
      await t.insert({ plan_key: "p1", process_key: "pi1", status: "dispatched", note: null });
    });
    const sched = fakeScheduler();
    const handle = mount(h, [planBinding({ pollMs: bad })], sched);
    await sched.advance(DEFAULT_INSTANCE_TRACKING_POLL_MS - 1);
    assert.equal(queries.length, 0); // did NOT hot-loop at ~0 …
    await sched.advance(1);
    assert.equal(queries.length, 1); // … it fired at the default interval instead
    await handle.stop();
    await h.close();
  });
}


// ── Wait-on-human edge (onWaitingHuman, issue #355) ────────────────────────────────────────────

// A binding that reconciles both engine-truth edges: terminal (onTerminated) and wait-on-human
// (onWaitingHuman). terminalStatuses (fail-open) keeps every non-abandoned row polled so a stale
// worker-written transient status (converging/merging/running) is still reconciled to awaiting.
const waitingBinding = (over: Partial<InstanceTracking> = {}): InstanceTracking => ({
  table: "plans",
  keyField: "process_key",
  statusField: "status",
  terminalStatuses: ["abandoned"],
  onTerminated: { set: { status: "abandoned", note: null } },
  onWaitingHuman: { set: { status: "awaiting_operator" } },
  pollMs: 1000,
  ...over,
});

test("derives awaiting_operator for a row whose instance has an open user task (forward)", async () => {
  // The row carries a STALE worker-written transient status; the instance is parked at a user task.
  // One reconcile pass must read it back as awaiting_operator — derived, not written.
  const { engine } = fakeEngine({ pi1: "ACTIVE" }, { pi1: 1 });
  const h = await withHarness(engine, PLANS_DDL, async (t) => {
    await t.insert({ plan_key: "p1", process_key: "pi1", status: "converging", note: null });
  });
  const sched = fakeScheduler();
  const handle = mount(h, [waitingBinding()], sched);
  await sched.advance(1000);
  assert.equal((await h.table.get("pi1"))?.status, "awaiting_operator");
  await handle.stop();
  await h.close();
});

test("leaves the worker-owned transient status when the instance has NO open user task (backward)", async () => {
  // No open user task and not terminated ⇒ the reconciler must not force awaiting_operator; the
  // worker-owned transient status survives. This is the "must not remain awaiting_operator once the
  // task completes" leg: a just-answered instance (task completed, worker wrote converging) is not
  // re-latched to awaiting_operator.
  const { engine } = fakeEngine({ pi1: "ACTIVE" }, { pi1: 0 });
  const h = await withHarness(engine, PLANS_DDL, async (t) => {
    await t.insert({ plan_key: "p1", process_key: "pi1", status: "converging", note: null });
  });
  const sched = fakeScheduler();
  const handle = mount(h, [waitingBinding()], sched);
  await sched.advance(1000);
  assert.equal((await h.table.get("pi1"))?.status, "converging");
  await handle.stop();
  await h.close();
});

test("re-escalation after an answer re-flips to awaiting_operator on the next poll (instance A)", async () => {
  // The re-escalation-after-answer defect (nano-workforce#318): the row sits at converging after an
  // answer; a re-escalation opens a NEW user task. Because the status is DERIVED every tick, the
  // next poll re-flips it to awaiting_operator by construction — no bespoke poller, no stuck state.
  const openTasks: Record<string, number> = { pi1: 0 }; // answered: task completed, none open
  const { engine } = fakeEngine({ pi1: "ACTIVE" }, openTasks);
  const h = await withHarness(engine, PLANS_DDL, async (t) => {
    await t.insert({ plan_key: "p1", process_key: "pi1", status: "converging", note: null });
  });
  const sched = fakeScheduler();
  const handle = mount(h, [waitingBinding()], sched);
  await sched.advance(1000);
  assert.equal((await h.table.get("pi1"))?.status, "converging"); // still converging: no open task
  openTasks.pi1 = 1; // re-escalation: a new user task opens
  await sched.advance(1000);
  assert.equal((await h.table.get("pi1"))?.status, "awaiting_operator"); // re-flipped
  await handle.stop();
  await h.close();
});

test("terminated wins over an open user task (precedence)", async () => {
  // A terminated instance that also (transiently) reports an open user task must reconcile to the
  // terminal patch, never awaiting_operator — onTerminated has precedence.
  const { engine, userTaskQueries } = fakeEngine({ pi1: "TERMINATED" }, { pi1: 1 });
  const h = await withHarness(engine, PLANS_DDL, async (t) => {
    await t.insert({ plan_key: "p1", process_key: "pi1", status: "converging", note: "x" });
  });
  const sched = fakeScheduler();
  const handle = mount(h, [waitingBinding()], sched);
  await sched.advance(1000);
  const row = await h.table.get("pi1");
  assert.equal(row?.status, "abandoned");
  assert.equal(row?.note, null);
  assert.deepEqual(userTaskQueries, []); // terminated key was excluded before the openUserTasks probe
  await handle.stop();
  await h.close();
});

test("does not re-write or re-log a row already at awaiting_operator (quiet-idempotent)", async () => {
  // A long-parked instance is re-polled every tick. The wait-on-human writer must be a no-op when
  // the row already carries the patch, so it does not re-log on every poll.
  const { engine } = fakeEngine({ pi1: "ACTIVE" }, { pi1: 1 });
  const h = await withHarness(engine, PLANS_DDL, async (t) => {
    await t.insert({ plan_key: "p1", process_key: "pi1", status: "awaiting_operator", note: null });
  });
  const sched = fakeScheduler();
  const handle = mount(h, [waitingBinding()], sched);
  await sched.advance(1000);
  await sched.advance(1000);
  assert.equal((await h.table.get("pi1"))?.status, "awaiting_operator");
  const awaitingLogs = h.logs.filter((l) => l.msg.includes("awaiting operator"));
  assert.equal(awaitingLogs.length, 0); // no-op patch never logged
  await handle.stop();
  await h.close();
});

test("a binding without onWaitingHuman never probes open user tasks (edge is opt-in)", async () => {
  const { engine, userTaskQueries } = fakeEngine({ pi1: "ACTIVE" }, { pi1: 1 });
  const h = await withHarness(engine, PLANS_DDL, async (t) => {
    await t.insert({ plan_key: "p1", process_key: "pi1", status: "dispatched", note: null });
  });
  const sched = fakeScheduler();
  const handle = mount(h, [planBinding()], sched); // planBinding has no onWaitingHuman
  await sched.advance(1000);
  assert.deepEqual(userTaskQueries, []); // never probed
  assert.equal((await h.table.get("pi1"))?.status, "dispatched"); // untouched
  await handle.stop();
  await h.close();
});

test("reconciles EVERY row sharing a non-unique key, even when one is already patched (multi-row)", async () => {
  // `keyField` (process_key) is NOT unique here, and table.update patches ALL matching rows. The
  // quiet-idempotence check must consider every matching row, not a single get() (LIMIT 1): with two
  // rows on the same process_key — one already awaiting_operator, one still converging — a LIMIT-1
  // probe that hits the patched row would skip the write and strand the other. Both must converge.
  const { engine } = fakeEngine({ pi1: "ACTIVE" }, { pi1: 1 });
  const h = await withHarness(engine, PLANS_DDL, async (t) => {
    await t.insert({ plan_key: "p1", process_key: "pi1", status: "awaiting_operator", note: null });
    await t.insert({ plan_key: "p2", process_key: "pi1", status: "converging", note: null });
  });
  const sched = fakeScheduler();
  const handle = mount(h, [waitingBinding()], sched);
  await sched.advance(1000);
  const rows = await h.table.find({ process_key: "pi1" });
  assert.deepEqual(
    rows.map((r) => r.status).sort(),
    ["awaiting_operator", "awaiting_operator"],
  );
  await handle.stop();
  await h.close();
});

test("reconciles every parked key across multiple probe batches (bounded-parallel probing)", async () => {
  // More active keys than WAITING_HUMAN_PROBE_CONCURRENCY forces multiple probe batches. Every key
  // with an open user task must still be probed and reconciled — the batching must not drop keys.
  const total = WAITING_HUMAN_PROBE_CONCURRENCY * 2 + 3; // spans three batches
  const states: Record<string, ProcessInstanceSnapshot["state"]> = {};
  const openTasks: Record<string, number> = {};
  for (let i = 0; i < total; i++) {
    states[`pi${i}`] = "ACTIVE";
    openTasks[`pi${i}`] = i % 2; // half parked on a human, half not
  }
  const { engine, userTaskQueries } = fakeEngine(states, openTasks);
  const h = await withHarness(engine, PLANS_DDL, async (t) => {
    for (let i = 0; i < total; i++) {
      await t.insert({ plan_key: `p${i}`, process_key: `pi${i}`, status: "converging", note: null });
    }
  });
  const sched = fakeScheduler();
  const handle = mount(h, [waitingBinding()], sched);
  await sched.advance(1000);
  // Every active key was probed exactly once.
  assert.equal(userTaskQueries.length, total);
  assert.deepEqual([...userTaskQueries].sort(), Object.keys(states).sort());
  for (let i = 0; i < total; i++) {
    const expected = i % 2 === 1 ? "awaiting_operator" : "converging";
    assert.equal((await h.table.get(`pi${i}`))?.status, expected, `pi${i}`);
  }
  await handle.stop();
  await h.close();
});

function mount(h: Harness, bindings: InstanceTracking[], sched: SchedulerDeps) {
  h.api.manifest.instanceTracking = bindings;
  return mountInstanceTracking(
    // biome-ignore lint/plugin: RuntimeContext test double — mountInstanceTracking reads only manifest/engine/root; host is unused here.
    { manifest: h.api.manifest, host: {} as never, engine: h.api.engine, root: "." },
    h.api,
    sched,
  );
}
