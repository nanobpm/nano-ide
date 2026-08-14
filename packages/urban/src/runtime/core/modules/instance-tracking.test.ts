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
import type { EngineClient, ProcessInstanceSnapshot } from "../host.ts";
import type { InstanceTracking } from "../manifest.ts";
import {
  DEFAULT_INSTANCE_TRACKING_POLL_MS,
  mountInstanceTracking,
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

/** An EngineClient whose only live method is searchProcessInstances, driven by a fixed map of
 *  processInstanceKey → state. Records the keys asked for on each call. */
function fakeEngine(states: Record<string, ProcessInstanceSnapshot["state"]>): {
  engine: EngineClient;
  queries: string[][];
} {
  const queries: string[][] = [];
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
    deployResources: notUsed("deployResources"),
    createInstance: notUsed("createInstance"),
    cancelInstance: notUsed("cancelInstance"),
    publishMessage: notUsed("publishMessage"),
    searchUserTasks: notUsed("searchUserTasks"),
    completeUserTask: notUsed("completeUserTask"),
    registerWorker: notUsed("registerWorker"),
    close: notUsed("close"),
  };
  return { engine, queries };
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


function mount(h: Harness, bindings: InstanceTracking[], sched: SchedulerDeps) {
  h.api.manifest.instanceTracking = bindings;
  return mountInstanceTracking(
    // biome-ignore lint/plugin: RuntimeContext test double — mountInstanceTracking reads only manifest/engine/root; host is unused here.
    { manifest: h.api.manifest, host: {} as never, engine: h.api.engine, root: "." },
    h.api,
    sched,
  );
}
