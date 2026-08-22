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
import type { EngineClient, ProcessInstanceSnapshot, SqliteDb, UserTaskFilter, UserTaskSummary } from "../host.ts";
import type { InstanceTracking } from "../manifest.ts";
import {
  DEFAULT_INSTANCE_TRACKING_POLL_MS,
  mountInstanceTracking,
  reconcileTerminatedKey,
  reconcileWaitingHumanKey,
  tryInstanceProjections,
  WAITING_HUMAN_PROBE_CONCURRENCY,
} from "./instance-tracking.ts";
import { defineInstanceTrackingReadModel } from "./instance-status-read-model.ts";
import { INSTANCE_STATE_TABLE } from "./instance-state-store.ts";
import { OPEN_USER_TASKS_TABLE } from "./open-user-tasks-store.ts";
import { assertReadModelParity } from "../read-model.ts";
import { MAX_TIMER_DELAY_MS, type SchedulerDeps } from "./scheduler.ts";
import { fakeScheduler } from "./scheduler.test-utils.ts";

// ADR 0065 — the instanceTracking writer→source inversion. The reconciler no longer WRITES a derivable
// status column on the base row; it FEEDS engine truth into the canonical projections
// (`_urban_instance_state`, `_urban_open_user_tasks`) and the effective status is DERIVED by the managed
// `<table>__tracking` VIEW's `derived_status` column. These tests therefore assert on the DERIVED value
// and the projection state — never a base-row mutation (the base `status` is left untouched for the
// app's own workers).

/** An EngineClient driven by a fixed map of processInstanceKey → state (for searchProcessInstances)
 *  and an optional map of processInstanceKey → number-of-open-user-tasks (for openUserTasks, the
 *  wait-on-human edge). Records the keys asked for on each call. `openUserTasks` models the engine
 *  truth the reconciler feeds `urban_open_user_tasks` from — only *open* (CREATED) tasks count, so a
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
  db: SqliteDb;
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
    now: () => 0,
    wait: () => Promise.resolve(),
    log: createLogger((level, msg) => {
      logs.push({ level, msg });
    }),
  };
  return {
    api,
    table: tbl,
    db,
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

// ── Derived-status / projection query helpers (the inversion's read surface) ────────────────────

/** The DERIVED effective status for a key, read from the managed `<table>__tracking` VIEW's
 *  `derived_status` column — the value the operator page reads post-inversion. Returns the values for
 *  every base row sharing the key (a non-unique keyField maps to several rows). */
function derived(h: Harness, key: string, view = "plans__tracking", keyField = "process_key"): string[] {
  const rows = h.db.all<{ derived_status: string }>(
    `SELECT derived_status FROM ${view} WHERE ${keyField} = ? ORDER BY plan_key`,
    [key],
  );
  return rows.map((r) => r.derived_status);
}

/** The single derived status for a key (asserts exactly one base row). */
function derivedOne(h: Harness, key: string, view = "plans__tracking"): string | undefined {
  const all = derived(h, key, view);
  return all[0];
}

/** The recorded engine lifecycle state for a key in the `_urban_instance_state` projection, or
 *  undefined when the key was never recorded (never terminated). */
function projectedState(h: Harness, key: string): string | undefined {
  const rows = h.db.all<{ state: string }>(
    `SELECT state FROM ${INSTANCE_STATE_TABLE} WHERE process_instance_key = ?`,
    [key],
  );
  return rows[0]?.state;
}

/** The number of open user tasks projected for a key in `_urban_open_user_tasks`. */
function projectedOpenTasks(h: Harness, key: string): number {
  const rows = h.db.all<{ n: number }>(
    `SELECT COUNT(*) AS n FROM ${OPEN_USER_TASKS_TABLE} WHERE process_instance_key = ?`,
    [key],
  );
  return Number(rows[0]?.n ?? 0);
}

test("derives the terminal status for an active row whose instance is TERMINATED (no base write)", async () => {
  const { engine } = fakeEngine({ pi1: "TERMINATED" });
  const h = await withHarness(engine, PLANS_DDL, async (t) => {
    await t.insert({ plan_key: "p1", process_key: "pi1", status: "dispatched", note: "hi" });
  });
  const sched = fakeScheduler();
  const handle = mount(h, [planBinding()], sched);
  await sched.advance(1000);
  // The derived status flips; the base row is UNTOUCHED (source-not-writer).
  assert.equal(derivedOne(h, "pi1"), "abandoned");
  const row = await h.table.get("pi1");
  assert.equal(row?.status, "dispatched"); // base status never rewritten
  assert.equal(row?.note, "hi"); // secondary column never rewritten either
  // …and the terminal fact was recorded into the canonical projection.
  assert.equal(projectedState(h, "pi1"), "TERMINATED");
  await handle.stop();
  await h.close();
});

test("derives the stored status for an active row whose instance is still ACTIVE", async () => {
  const { engine } = fakeEngine({ pi1: "ACTIVE" });
  const h = await withHarness(engine, PLANS_DDL, async (t) => {
    await t.insert({ plan_key: "p1", process_key: "pi1", status: "dispatched", note: "hi" });
  });
  const sched = fakeScheduler();
  const handle = mount(h, [planBinding()], sched);
  await sched.advance(1000);
  assert.equal(derivedOne(h, "pi1"), "dispatched"); // no terminal edge ⇒ passes the stored value through
  assert.equal(projectedState(h, "pi1"), undefined); // ACTIVE is not recorded
  await handle.stop();
  await h.close();
});

test("does NOT record a COMPLETED instance (a finalize worker owns that outcome)", async () => {
  const { engine, queries } = fakeEngine({ pi1: "COMPLETED" });
  const h = await withHarness(engine, PLANS_DDL, async (t) => {
    await t.insert({ plan_key: "p1", process_key: "pi1", status: "dispatched", note: "hi" });
  });
  const sched = fakeScheduler();
  const handle = mount(h, [planBinding()], sched);
  await sched.advance(1000);
  assert.equal(derivedOne(h, "pi1"), "dispatched"); // not terminal-derived
  assert.equal(projectedState(h, "pi1"), undefined); // COMPLETED never recorded here
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

test("without statusField, polls every row and records each terminal instance into the projection", async () => {
  // With no statusField there is no single column to derive, so NO VIEW is provisioned — but the
  // reconciler still feeds engine truth into the canonical instance-state projection.
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
  assert.equal(projectedState(h, "pi1"), "TERMINATED");
  assert.equal(projectedState(h, "pi2"), "TERMINATED");
  await handle.stop();
  await h.close();
});

test("terminalStatuses: derives the terminal status for a TERMINATED row in an un-enumerated non-terminal status (the allow-list regression)", async () => {
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
  assert.equal(derivedOne(h, "pi1"), "abandoned"); // …and derives to terminal
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
  assert.equal(derivedOne(h, "pi1"), "abandoned");
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
// worker-written transient status (converging/merging/running) still derives to awaiting.
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
  // One reconcile pass must read it back as awaiting_operator — DERIVED over the fed projection,
  // never written to the base row.
  const { engine } = fakeEngine({ pi1: "ACTIVE" }, { pi1: 1 });
  const h = await withHarness(engine, PLANS_DDL, async (t) => {
    await t.insert({ plan_key: "p1", process_key: "pi1", status: "converging", note: null });
  });
  const sched = fakeScheduler();
  const handle = mount(h, [waitingBinding()], sched);
  await sched.advance(1000);
  assert.equal(derivedOne(h, "pi1"), "awaiting_operator");
  assert.equal((await h.table.get("pi1"))?.status, "converging"); // base untouched
  assert.equal(projectedOpenTasks(h, "pi1"), 1); // the open task was fed into the projection
  await handle.stop();
  await h.close();
});

test("derives the worker-owned transient status when the instance has NO open user task (backward)", async () => {
  // No open user task and not terminated ⇒ the derived edge must NOT be awaiting_operator; the
  // worker-owned transient status shows through. This is the "must not remain awaiting_operator once
  // the task completes" leg.
  const { engine } = fakeEngine({ pi1: "ACTIVE" }, { pi1: 0 });
  const h = await withHarness(engine, PLANS_DDL, async (t) => {
    await t.insert({ plan_key: "p1", process_key: "pi1", status: "converging", note: null });
  });
  const sched = fakeScheduler();
  const handle = mount(h, [waitingBinding()], sched);
  await sched.advance(1000);
  assert.equal(derivedOne(h, "pi1"), "converging");
  assert.equal(projectedOpenTasks(h, "pi1"), 0);
  await handle.stop();
  await h.close();
});

test("re-escalation after an answer re-flips to awaiting_operator on the next poll (instance A)", async () => {
  // The re-escalation-after-answer defect (nano-workforce#318): the row sits at converging after an
  // answer; a re-escalation opens a NEW user task. Because the status is DERIVED every tick over the
  // live projection, the next poll re-flips it to awaiting_operator by construction.
  const openTasks: Record<string, number> = { pi1: 0 }; // answered: task completed, none open
  const { engine } = fakeEngine({ pi1: "ACTIVE" }, openTasks);
  const h = await withHarness(engine, PLANS_DDL, async (t) => {
    await t.insert({ plan_key: "p1", process_key: "pi1", status: "converging", note: null });
  });
  const sched = fakeScheduler();
  const handle = mount(h, [waitingBinding()], sched);
  await sched.advance(1000);
  assert.equal(derivedOne(h, "pi1"), "converging"); // still converging: no open task
  openTasks.pi1 = 1; // re-escalation: a new user task opens
  await sched.advance(1000);
  assert.equal(derivedOne(h, "pi1"), "awaiting_operator"); // re-flipped
  await handle.stop();
  await h.close();
});

test("#422: an answered escalation reads NON-stale by construction (tearing is gone)", async () => {
  // nano-workforce#422 — the tearing the inversion removes. Under the OLD writer the derivable
  // `status` was STORED, so an answered escalation (its user task retired) still showed a stale ⚠
  // (awaiting_operator) until a bespoke self-heal poll re-wrote it. With the derivation over the LIVE
  // open-task projection, once `syncInstance([])` retires the task the EXISTS goes false on the very
  // next read — there is no stored column left to tear.
  const openTasks: Record<string, number> = { pi1: 1 }; // escalated: one open user task
  const { engine } = fakeEngine({ pi1: "ACTIVE" }, openTasks);
  const h = await withHarness(engine, PLANS_DDL, async (t) => {
    await t.insert({ plan_key: "p1", process_key: "pi1", status: "converging", note: null });
  });
  const sched = fakeScheduler();
  const handle = mount(h, [waitingBinding()], sched);
  await sched.advance(1000);
  assert.equal(derivedOne(h, "pi1"), "awaiting_operator"); // escalated ⇒ parked on a human
  assert.equal(projectedOpenTasks(h, "pi1"), 1);

  // The operator answers/closes the escalation — the engine no longer reports an open task.
  openTasks.pi1 = 0;
  await sched.advance(1000);
  // The derived read model MUST NOT still read awaiting_operator. The retired task was cleared from
  // the projection, so the edge is false — non-stale WITHOUT any compensating write.
  assert.notEqual(derivedOne(h, "pi1"), "awaiting_operator");
  assert.equal(derivedOne(h, "pi1"), "converging");
  assert.equal(projectedOpenTasks(h, "pi1"), 0); // the answered task was retired from the projection
  await handle.stop();
  await h.close();
});

test("terminated wins over an open user task (precedence)", async () => {
  // A terminated instance that also (transiently) reports an open user task must derive to the
  // terminal status, never awaiting_operator — onTerminated has precedence, and the terminal record
  // retires the open tasks at the source too.
  const { engine, userTaskQueries } = fakeEngine({ pi1: "TERMINATED" }, { pi1: 1 });
  const h = await withHarness(engine, PLANS_DDL, async (t) => {
    await t.insert({ plan_key: "p1", process_key: "pi1", status: "converging", note: "x" });
  });
  const sched = fakeScheduler();
  const handle = mount(h, [waitingBinding()], sched);
  await sched.advance(1000);
  assert.equal(derivedOne(h, "pi1"), "abandoned");
  assert.equal(projectedState(h, "pi1"), "TERMINATED");
  assert.equal(projectedOpenTasks(h, "pi1"), 0); // terminal record cleared any open tasks
  assert.deepEqual(userTaskQueries, []); // terminated key was excluded before the openUserTasks probe
  await handle.stop();
  await h.close();
});

test("does not log per-poll for a long-parked awaiting_operator instance (quiet feed)", async () => {
  // A long-parked instance is re-polled every tick. Feeding the projection is idempotent and must not
  // emit a per-poll info/warn log (the derived edge is recomputed silently on read).
  const { engine } = fakeEngine({ pi1: "ACTIVE" }, { pi1: 1 });
  const h = await withHarness(engine, PLANS_DDL, async (t) => {
    await t.insert({ plan_key: "p1", process_key: "pi1", status: "awaiting_operator", note: null });
  });
  const sched = fakeScheduler();
  const handle = mount(h, [waitingBinding()], sched);
  await sched.advance(1000);
  await sched.advance(1000);
  assert.equal(derivedOne(h, "pi1"), "awaiting_operator");
  const noisy = h.logs.filter((l) => l.msg.includes("awaiting") || (l.level !== "debug" && l.msg.includes("open user tasks")));
  assert.equal(noisy.length, 0); // idempotent feed never logs
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
  assert.equal(derivedOne(h, "pi1"), "dispatched"); // derives to the stored status; no wait-on-human edge
  assert.equal((await h.table.get("pi1"))?.status, "dispatched"); // base untouched
  await handle.stop();
  await h.close();
});

test("derives awaiting_operator for EVERY row sharing a non-unique key (multi-row)", async () => {
  // `keyField` (process_key) is NOT unique here. Post-inversion the projection is fed ONCE per key and
  // the derived VIEW joins every base row on that key to it — so both rows sharing pi1 derive to the
  // same edge, regardless of their (untouched) stored status. No per-row write to strand.
  const { engine } = fakeEngine({ pi1: "ACTIVE" }, { pi1: 1 });
  const h = await withHarness(engine, PLANS_DDL, async (t) => {
    await t.insert({ plan_key: "p1", process_key: "pi1", status: "awaiting_operator", note: null });
    await t.insert({ plan_key: "p2", process_key: "pi1", status: "converging", note: null });
  });
  const sched = fakeScheduler();
  const handle = mount(h, [waitingBinding()], sched);
  await sched.advance(1000);
  assert.deepEqual(derived(h, "pi1"), ["awaiting_operator", "awaiting_operator"]);
  // The base rows keep their (distinct) stored statuses — nothing was written.
  const rows = await h.table.find({ process_key: "pi1" });
  assert.deepEqual(rows.map((r) => r.status).sort(), ["awaiting_operator", "converging"]);
  await handle.stop();
  await h.close();
});

test("feeds every parked key across multiple probe batches (bounded-parallel probing)", async () => {
  // More active keys than WAITING_HUMAN_PROBE_CONCURRENCY forces multiple probe batches. Every key
  // must still be probed and fed — the batching must not drop keys.
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
    assert.equal(derivedOne(h, `pi${i}`), expected, `pi${i}`);
  }
  await handle.stop();
  await h.close();
});

// ── Read-model parity: the SQL VIEW backend and the TS function backend agree ───────────────────

test("the derived status read model's SQL and TS backends stay in parity", async () => {
  // The two backends fall out of the SAME AST; `assertReadModelParity` builds TEMP projection fixtures
  // and checks the compiled VIEW and the in-process function agree over sample rows — the guard that
  // replaces a hand-written per-edge parity test.
  const { engine } = fakeEngine({});
  const h = await withHarness(engine, PLANS_DDL, async () => {});
  const model = defineInstanceTrackingReadModel(waitingBinding());
  assert.ok(model, "waitingBinding has a statusField ⇒ a model");
  assertReadModelParity(
    model,
    h.db,
    [
      // terminal edge true → derives abandoned
      {
        baseRow: { process_key: "k1", status: "converging" },
        projections: {
          urban_instance_state: [{ process_instance_key: "k1", state: "TERMINATED" }],
          urban_open_user_tasks: [],
        },
      },
      // wait-on-human edge true, not terminated → derives awaiting_operator
      {
        baseRow: { process_key: "k2", status: "converging" },
        projections: {
          urban_instance_state: [],
          urban_open_user_tasks: [{ process_instance_key: "k2", user_task_key: "t" }],
        },
      },
      // both true → terminated wins (precedence)
      {
        baseRow: { process_key: "k3", status: "converging" },
        projections: {
          urban_instance_state: [{ process_instance_key: "k3", state: "TERMINATED" }],
          urban_open_user_tasks: [{ process_instance_key: "k3", user_task_key: "t" }],
        },
      },
      // neither → the stored status shows through
      {
        baseRow: { process_key: "k4", status: "running" },
        projections: { urban_instance_state: [], urban_open_user_tasks: [] },
      },
    ],
  );
  await h.close();
});

// ── Efficiency + retirement edges (ADR 0065 review round) ───────────────────────────────────────

test("a settled TERMINATED key is not re-queried and does not re-log on subsequent polls", async () => {
  // Once recorded TERMINATED the base row keeps its (unchanged) status, so it would keep passing the
  // selector; the reconciler must skip the settled key on later ticks — no repeat engine query, no repeat
  // `recorded terminated instance` log, no inflated `reconciled` (fixes the one-log-per-settled-per-tick).
  const { engine, queries } = fakeEngine({ pi1: "TERMINATED" });
  const h = await withHarness(engine, PLANS_DDL, async (t) => {
    await t.insert({ plan_key: "p1", process_key: "pi1", status: "dispatched", note: null });
  });
  const sched = fakeScheduler();
  const handle = mount(h, [planBinding()], sched);
  await sched.advance(1000);
  await sched.advance(1000);
  await sched.advance(1000);
  assert.deepEqual(queries, [["pi1"]]); // queried once; settled thereafter, never re-queried
  const terminalLogs = h.logs.filter((l) => l.msg.includes("recorded terminated instance"));
  assert.equal(terminalLogs.length, 1); // logged exactly once, not per tick
  await handle.stop();
  await h.close();
});

// A binding that both derives the wait-on-human edge AND uses a fail-CLOSED `activeStatuses` allow-list —
// the exact combination whose retirement gap the review flagged (a key answered off the allow-list would
// strand its open-task projection).
const activeWaitingBinding = (over: Partial<InstanceTracking> = {}): InstanceTracking => ({
  table: "plans",
  keyField: "process_key",
  statusField: "status",
  activeStatuses: ["dispatched"],
  onTerminated: { set: { status: "abandoned" } },
  onWaitingHuman: { set: { status: "awaiting_operator" } },
  pollMs: 1000,
  ...over,
});

test("retires a stale open-task projection for a key that left the activeStatuses allow-list", async () => {
  // Instance parked on a human while `dispatched` (in the allow-list) → projected open. The app then
  // answers: the task closes AND the worker flips the row to a non-active status, so the row no longer
  // passes `activeStatuses`. Without retiring projected keys independently of the allow-list, the open-task
  // row would linger and the VIEW keep deriving awaiting_operator — a fresh nano-workforce#422 tear.
  const openTasks: Record<string, number> = { pi1: 1 };
  const { engine } = fakeEngine({ pi1: "ACTIVE" }, openTasks);
  const h = await withHarness(engine, PLANS_DDL, async (t) => {
    await t.insert({ plan_key: "p1", process_key: "pi1", status: "dispatched", note: null });
  });
  const sched = fakeScheduler();
  const handle = mount(h, [activeWaitingBinding()], sched);
  await sched.advance(1000);
  assert.equal(projectedOpenTasks(h, "pi1"), 1); // parked: projected open
  assert.equal(derivedOne(h, "pi1"), "awaiting_operator");

  // Answer: task closed AND worker moved the row OUT of the active set.
  openTasks.pi1 = 0;
  await h.table.update("pi1", { status: "done" });
  await sched.advance(1000);
  assert.equal(projectedOpenTasks(h, "pi1"), 0); // retired even though the row left activeStatuses
  await handle.stop();
  await h.close();
});

test("skips the derived VIEW when its status column collides with an existing base column", async () => {
  // The VIEW selects `base.*` then `${statusColumn} AS ...`; a base column already named the same
  // (here the default `derived_status`) would make SQLite keep the STORED column and shadow the derived
  // one, so a page reading it sees a stale value. Provisioning must detect the collision, skip the VIEW,
  // and warn — rather than publish a VIEW that silently defeats the derivation.
  const ddl =
    "CREATE TABLE plans (plan_key TEXT PRIMARY KEY, process_key TEXT, status TEXT NOT NULL, note TEXT, derived_status TEXT)";
  const { engine } = fakeEngine({ pi1: "TERMINATED" });
  const h = await withHarness(engine, ddl, async (t) => {
    await t.insert({ plan_key: "p1", process_key: "pi1", status: "dispatched", note: null });
  });
  const sched = fakeScheduler();
  const handle = mount(h, [planBinding()], sched); // default statusColumn = derived_status ⇒ collides
  await sched.advance(1000);
  const views = h.db.all<{ name: string }>(
    "SELECT name FROM sqlite_master WHERE type='view' AND name='plans__tracking'",
  );
  assert.equal(views.length, 0); // VIEW was NOT created
  assert.ok(h.logs.some((l) => l.level === "warn" && l.msg.includes("collides with an existing")));
  await handle.stop();
  await h.close();
});

test("reconcileWaitingHumanKey does not re-project a settled TERMINATED instance (cancel-during-poll race)", async () => {
  // The wait-on-human probe `await`s the engine, yielding the event loop; a concurrent cancel can record
  // the instance TERMINATED and retire its tasks WHILE the probe is in flight. Re-inserting the (now
  // stale) open tasks would strand a row the terminal path already cleared — the key is then classified
  // settled and never re-probed, a permanent stale projection row. The terminal recheck must refuse.
  const { engine } = fakeEngine({});
  const h = await withHarness(engine, PLANS_DDL, async () => {});
  const projections = tryInstanceProjections(h.api);
  assert.ok(projections);
  // A concurrent cancel recorded TERMINATED (and cleared any tasks) mid-probe.
  reconcileTerminatedKey(h.api, projections, "pi1");
  assert.equal(projectedState(h, "pi1"), "TERMINATED");
  // The in-flight probe now tries to feed a stale open task; the guard drops it (returns 0, no row).
  const fed = reconcileWaitingHumanKey(h.api, projections, "pi1", [{ userTaskKey: "pi1-t0" }]);
  assert.equal(fed, 0);
  assert.equal(projectedOpenTasks(h, "pi1"), 0);
  await h.close();
});

test("retires a stale managed VIEW when a binding no longer declares a statusField", async () => {
  // A manifest change that drops `statusField` leaves the binding with nothing derivable. An earlier
  // boot's managed VIEW must be RETIRED, or its stale derived surface stays discoverable/readable while
  // the runtime believes it provisioned nothing.
  const { engine } = fakeEngine({});
  const h = await withHarness(engine, PLANS_DDL, async () => {});
  h.db.exec('CREATE VIEW main."plans__tracking" AS SELECT * FROM plans;'); // a previous boot's VIEW
  const sched = fakeScheduler();
  const handle = mount(h, [planBinding({ statusField: undefined, activeStatuses: undefined })], sched);
  const views = h.db.all<{ name: string }>(
    "SELECT name FROM sqlite_master WHERE type='view' AND name='plans__tracking'",
  );
  assert.equal(views.length, 0); // stale VIEW retired
  await handle.stop();
  await h.close();
});

test("skips provisioning when a non-view object already holds the managed VIEW name", async () => {
  // A real table sharing the managed-view name shadows it: `DROP VIEW IF EXISTS` can't remove a table and
  // `CREATE VIEW IF NOT EXISTS` then silently no-ops, so a page would read the wrong object while the mount
  // looked successful. Provisioning must refuse (warn + skip) and leave the real table untouched.
  const { engine } = fakeEngine({ pi1: "TERMINATED" });
  const h = await withHarness(engine, PLANS_DDL, async (t) => {
    await t.insert({ plan_key: "p1", process_key: "pi1", status: "dispatched", note: null });
  });
  h.db.exec('CREATE TABLE "plans__tracking" (x TEXT)'); // an undeclared real table squats the name
  const sched = fakeScheduler();
  const handle = mount(h, [planBinding()], sched);
  await sched.advance(1000);
  const obj = h.db.all<{ type: string }>("SELECT type FROM sqlite_master WHERE name='plans__tracking'");
  assert.equal(obj.length, 1);
  assert.equal(obj[0].type, "table"); // untouched — not dropped, not shadowed by a VIEW
  assert.ok(h.logs.some((l) => l.level === "warn" && l.msg.includes("non-view object")));
  await handle.stop();
  await h.close();
});

test("detects a non-view shadow case-insensitively (SQLite folds object names)", async () => {
  // SQLite resolves object names case-insensitively, so a real table `plans__tracking` shadows a
  // configured view `PLANS__TRACKING` at DROP/CREATE time. A binary `=` name check would miss the
  // shadow and let `CREATE VIEW IF NOT EXISTS` silently no-op against the existing table; the guard
  // must fold case (COLLATE NOCASE) so it refuses (warn + skip) and leaves the real table untouched.
  const { engine } = fakeEngine({ pi1: "TERMINATED" });
  const h = await withHarness(engine, PLANS_DDL, async (t) => {
    await t.insert({ plan_key: "p1", process_key: "pi1", status: "dispatched", note: null });
  });
  h.db.exec('CREATE TABLE "plans__tracking" (x TEXT)'); // lowercase real table squats the name
  const sched = fakeScheduler();
  const handle = mount(h, [planBinding({ readModel: { view: "PLANS__TRACKING" } })], sched); // cased override
  await sched.advance(1000);
  const obj = h.db.all<{ type: string }>("SELECT type FROM sqlite_master WHERE name='plans__tracking'");
  assert.equal(obj.length, 1);
  assert.equal(obj[0].type, "table"); // untouched — not dropped, not shadowed by a VIEW
  assert.ok(h.logs.some((l) => l.level === "warn" && l.msg.includes("non-view object")));
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
