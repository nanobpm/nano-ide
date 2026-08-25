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
import type { EngineClient, ProcessInstanceSnapshot, SqliteDb } from "../host.ts";
import type { InstanceTracking } from "../manifest.ts";
import { cancelInstanceReconciling } from "./cancel.ts";
import { INSTANCE_STATE_TABLE } from "./instance-state-store.ts";

// ADR 0065 — the instanceTracking writer→source inversion. Cancel no longer WRITES a terminal patch on
// the base row; it records the terminal fact into the canonical `_urban_instance_state` projection
// through the SAME `reconcileTerminatedKey` the poll reconciler uses (so cancel and poll cannot drift),
// and the terminal status is DERIVED from the projection by the read model. These tests therefore assert
// on the recorded projection state and `reconciled` (1 = terminal source recorded) — never a base-row
// mutation.

type State = ProcessInstanceSnapshot["state"];

const PR_DDL = `CREATE TABLE pull_requests (
  pr_key TEXT PRIMARY KEY,
  process_key TEXT,
  status TEXT NOT NULL
);`;

interface PrRow {
  pr_key: string;
  process_key: string | null;
  status: string;
}

// The pull_requests binding: an ACTIVE row derives to `abandoned` when its instance terminates — the
// value the derived terminal edge resolves to (no longer a stored patch). Cancel feeds the projection;
// the read model derives the status.
const PR_BINDING: InstanceTracking = {
  table: "pull_requests",
  keyField: "process_key",
  statusField: "status",
  activeStatuses: ["converging"],
  onTerminated: { set: { status: "abandoned", process_key: null } },
};

/** An EngineClient double for the cancel primitive. `cancelInstance` runs `onCancel` (which may
 *  throw and/or mutate `states`); `searchProcessInstances` reflects the current `states` map, or
 *  throws when `verifyThrows` is set (to exercise the unverifiable-read path). */
function cancelEngine(opts: {
  states: Record<string, State>;
  onCancel: (key: string, states: Record<string, State>) => void;
  verifyThrows?: boolean;
}): { engine: EngineClient; cancels: string[] } {
  const cancels: string[] = [];
  const notUsed = (m: string) => (): never => {
    throw new Error(`cancelEngine.${m} is not exercised by this test`);
  };
  const engine: EngineClient = {
    async cancelInstance(args: { processInstanceKey: string }): Promise<void> {
      cancels.push(args.processInstanceKey);
      opts.onCancel(args.processInstanceKey, opts.states);
    },
    async searchProcessInstances(filter?: {
      processInstanceKeys?: string[];
      state?: State;
    }): Promise<ProcessInstanceSnapshot[]> {
      if (opts.verifyThrows) throw new Error("read model unavailable");
      const keys = filter?.processInstanceKeys ?? [];
      const out: ProcessInstanceSnapshot[] = [];
      for (const key of keys) {
        const state = opts.states[key];
        if (state && (!filter?.state || filter.state === state)) {
          out.push({ processInstanceKey: key, state });
        }
      }
      return out;
    },
    deployResources: notUsed("deployResources"),
    createInstance: notUsed("createInstance"),
    publishMessage: notUsed("publishMessage"),
    searchUserTasks: notUsed("searchUserTasks"),
    openUserTasks: notUsed("openUserTasks"),
    getForm: notUsed("getForm"),
    completeUserTask: notUsed("completeUserTask"),
    searchElementInstances: notUsed("searchElementInstances"),
    searchElementInstanceWaitStates: notUsed("searchElementInstanceWaitStates"),
    getElementInstance: notUsed("getElementInstance"),
    registerWorker: notUsed("registerWorker"),
    close: notUsed("close"),
  };
  return { engine, cancels };
}

interface Harness {
  api: AppApi;
  table: Table<PrRow>;
  db: SqliteDb;
  logs: { level: string; msg: string }[];
  close: () => Promise<void>;
}

async function withHarness(engine: EngineClient, seedStatus = "converging"): Promise<Harness> {
  const dir = await mkdtemp(join(tmpdir(), "urban-cancel-"));
  const host = createNodeHost({ cwd: dir, log: () => {} });
  const db = host.openSqlite(join(dir, "test.db"));
  db.exec(PR_DDL);
  const source: ProvisionedSource = {
    name: "app",
    driver: "sqlite",
    db,
    source: makeGateway(db),
    migrationsApplied: [],
    close: () => db.close(),
  };
  const data = new DataLayer(new Map([["app", source]]), "app", {});
  const table = data.table<PrRow>("pull_requests", "process_key");
  await table.insert({ pr_key: "pr-1", process_key: "100", status: seedStatus });
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
    table,
    db,
    logs,
    close: async () => {
      db.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

/** The recorded engine lifecycle state for a key in the `_urban_instance_state` projection, or
 *  undefined when it was never recorded. The projection table is created lazily by cancel's own
 *  `ensureSchema`; return undefined if it does not exist yet (nothing was ever recorded). */
function projectedState(db: SqliteDb, key: string): string | undefined {
  try {
    const rows = db.all<{ state: string }>(
      `SELECT state FROM ${INSTANCE_STATE_TABLE} WHERE process_instance_key = ?`,
      [key],
    );
    return rows[0]?.state;
  } catch {
    return undefined; // projection table not provisioned ⇒ nothing recorded
  }
}

test("terminating a tracked instance records its terminal source immediately (no base write)", async () => {
  // cancelInstance succeeds (no throw) and the engine commits the termination.
  const { engine, cancels } = cancelEngine({
    states: { "100": "ACTIVE" },
    onCancel: (key, states) => {
      states[key] = "TERMINATED";
    },
  });
  const h = await withHarness(engine);
  try {
    const r = await cancelInstanceReconciling(h.api, [PR_BINDING], "100");
    assert.deepEqual(cancels, ["100"]);
    assert.equal(r.ok, true);
    assert.equal(r.state, "TERMINATED");
    assert.equal(r.reconciled, 1);
    // The terminal fact was recorded into the canonical projection …
    assert.equal(projectedState(h.db, "100"), "TERMINATED");
    // … and the base row was left UNTOUCHED (source-not-writer); the derived read model surfaces the
    // terminal status without a stored write.
    const row = await h.table.get("100");
    assert.equal(row?.status, "converging");
    assert.equal(row?.process_key, "100");
  } finally {
    await h.close();
  }
});

test("a cancel that throws but reads back TERMINATED is idempotent success + records the source", async () => {
  // The instance was already terminated; the engine rejects a second cancel, but the verify read
  // confirms it is gone — treat as success and still record the terminal source.
  const { engine } = cancelEngine({
    states: { "100": "TERMINATED" },
    onCancel: () => {
      throw new Error("instance is not active");
    },
  });
  const h = await withHarness(engine);
  try {
    const r = await cancelInstanceReconciling(h.api, [PR_BINDING], "100");
    assert.equal(r.ok, true);
    assert.equal(r.state, "TERMINATED");
    assert.equal(r.reconciled, 1);
    assert.equal(projectedState(h.db, "100"), "TERMINATED");
  } finally {
    await h.close();
  }
});

test("a failed cancel with a still-ACTIVE instance is an honest failure and records nothing", async () => {
  const { engine } = cancelEngine({
    states: { "100": "ACTIVE" },
    onCancel: () => {
      throw new Error("permission denied");
    },
  });
  const h = await withHarness(engine);
  try {
    const r = await cancelInstanceReconciling(h.api, [PR_BINDING], "100");
    assert.equal(r.ok, false);
    assert.equal(r.state, "ACTIVE");
    assert.equal(r.reconciled, 0);
    assert.match(r.error ?? "", /permission denied/);
    assert.equal(projectedState(h.db, "100"), undefined); // instance still running — nothing recorded
    const row = await h.table.get("100");
    assert.equal(row?.status, "converging"); // untouched
    assert.ok(h.logs.some((l) => l.level === "error"));
  } finally {
    await h.close();
  }
});

test("an accepted cancel that still reads ACTIVE (engine lag) records the terminal source", async () => {
  // The engine accepted the 204 but its query store still lags at ACTIVE. The cancel IS committed, so
  // the terminal source must be recorded now — otherwise the derived view stays on the stored worker
  // status until a poll catches up (and never, if the instance is later cleaned up). accepted-cancel/lag.
  const { engine } = cancelEngine({
    states: { "100": "ACTIVE" },
    onCancel: () => {}, // accepted (204); state deliberately NOT flipped, to model read-model lag
  });
  const h = await withHarness(engine);
  try {
    const r = await cancelInstanceReconciling(h.api, [PR_BINDING], "100");
    assert.equal(r.ok, true);
    assert.equal(r.state, "ACTIVE");
    assert.equal(r.reconciled, 1);
    assert.equal(projectedState(h.db, "100"), "TERMINATED");
    const row = await h.table.get("100");
    assert.equal(row?.status, "converging"); // base row untouched (source-not-writer)
  } finally {
    await h.close();
  }
});

test("a COMPLETED instance is not recorded (the app's finalize logic owns that outcome)", async () => {
  const { engine } = cancelEngine({
    states: { "100": "COMPLETED" },
    onCancel: () => {}, // engine accepts the request; instance had already completed
  });
  const h = await withHarness(engine);
  try {
    const r = await cancelInstanceReconciling(h.api, [PR_BINDING], "100");
    assert.equal(r.ok, true);
    assert.equal(r.state, "COMPLETED");
    assert.equal(r.reconciled, 0);
    assert.equal(projectedState(h.db, "100"), undefined); // COMPLETED never recorded here
    const row = await h.table.get("100");
    assert.equal(row?.status, "converging"); // left for the finalize worker
  } finally {
    await h.close();
  }
});

test("an accepted cancel that reads back gone (engine cleanup) records the terminal source", async () => {
  const { engine } = cancelEngine({
    states: {}, // the engine no longer exposes the key (already cleaned up)
    onCancel: () => {},
  });
  const h = await withHarness(engine);
  try {
    const r = await cancelInstanceReconciling(h.api, [PR_BINDING], "999999");
    assert.equal(r.ok, true);
    assert.equal(r.state, "gone");
    // The accepted 204 is a committed termination, so record the terminal source even though the read
    // model no longer exposes the instance — otherwise the derived view could never leave the stored
    // worker status (the poll cannot observe a gone instance either). accepted-cancel/read-lag.
    assert.equal(r.reconciled, 1);
    assert.equal(projectedState(h.db, "999999"), "TERMINATED");
  } finally {
    await h.close();
  }
});

test("records the terminal source even when no base row matches (the projection is binding-independent)", async () => {
  // Post-inversion the terminal fact is recorded into the canonical projection for the cancelled key
  // regardless of which base rows reference it — the projection is the engine-truth store, and the
  // derived read model only surfaces the fact for rows that point at the key (none here). This agrees
  // with the poll path (both record TERMINATED for the same key), so they cannot drift.
  const { engine } = cancelEngine({
    states: { "555": "TERMINATED" },
    onCancel: () => {},
  });
  const h = await withHarness(engine);
  try {
    // "555" matches no row (the seeded row tracks "100").
    const r = await cancelInstanceReconciling(h.api, [PR_BINDING], "555");
    assert.equal(r.ok, true);
    assert.equal(r.state, "TERMINATED");
    assert.equal(r.reconciled, 1);
    assert.equal(projectedState(h.db, "555"), "TERMINATED");
    const row = await h.table.get("100");
    assert.equal(row?.status, "converging"); // the unrelated tracked row is untouched
  } finally {
    await h.close();
  }
});

test("cancel succeeds and records nothing when there is no default data source (absent-safe)", async () => {
  // The projection feed is a sidecar on the app's own data source. With no default source there is
  // nothing to record into — but a successful engine termination must STILL be reported as a success:
  // a projection feed must never break a cancel. `reconcileTerminatedKey` is absent-safe (returns 0).
  const { engine } = cancelEngine({
    states: { "100": "ACTIVE" },
    onCancel: (key, states) => {
      states[key] = "TERMINATED";
    },
  });
  const dir = await mkdtemp(join(tmpdir(), "urban-cancel-nosrc-"));
  const logs: { level: string; msg: string }[] = [];
  const data = new DataLayer(new Map(), undefined, {}); // no default source configured
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
  try {
    const r = await cancelInstanceReconciling(api, [PR_BINDING], "100");
    assert.equal(r.ok, true); // the engine termination committed — a success
    assert.equal(r.state, "TERMINATED");
    assert.equal(r.reconciled, 0); // nothing to record into
    assert.equal(r.error, undefined); // absent-safe: not surfaced as an error
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("an accepted cancel whose verify read fails is trusted (gone) — the 204 committed", async () => {
  const { engine } = cancelEngine({
    states: { "100": "ACTIVE" },
    onCancel: () => {}, // accepted
    verifyThrows: true,
  });
  const h = await withHarness(engine);
  try {
    const r = await cancelInstanceReconciling(h.api, [PR_BINDING], "100");
    assert.equal(r.ok, true);
    assert.equal(r.state, "gone");
    // Accepted 204 → committed termination; record the terminal source even though the verify read
    // could not confirm it (read-model lag / cleanup must not strand the derived status).
    assert.equal(r.reconciled, 1);
    assert.equal(projectedState(h.db, "100"), "TERMINATED");
    assert.ok(h.logs.some((l) => l.level === "warn"));
  } finally {
    await h.close();
  }
});

test("a thrown cancel whose verify read also fails is reported as an honest failure", async () => {
  const { engine } = cancelEngine({
    states: { "100": "ACTIVE" },
    onCancel: () => {
      throw new Error("transport error");
    },
    verifyThrows: true,
  });
  const h = await withHarness(engine);
  try {
    const r = await cancelInstanceReconciling(h.api, [PR_BINDING], "100");
    assert.equal(r.ok, false);
    assert.equal(r.state, "ACTIVE");
    assert.equal(r.reconciled, 0);
    assert.match(r.error ?? "", /transport error/);
    assert.equal(projectedState(h.db, "100"), undefined);
    const row = await h.table.get("100");
    assert.equal(row?.status, "converging");
  } finally {
    await h.close();
  }
});

test("a thrown cancel whose verify read comes back empty (gone) is an unverified failure, not a false success", async () => {
  // The engine-restart trap: the cancel POST throws (dead keep-alive socket / the brief window
  // the gateway is down), then the verify search hits the just-restarted engine whose query store
  // has NOT yet rehydrated the still-running instance — so the read comes back empty ("gone").
  // A throw is not a committed 204, and absence from the read model is not proof of termination, so
  // reporting success here is the "worst possible lie": the button says cancelled while the run
  // keeps going. It must be an honest ok:false so the caller surfaces it and the user retries.
  const { engine } = cancelEngine({
    states: {}, // read model transiently empty (mid-restart), though instance "100" is still live
    onCancel: () => {
      throw new Error("fetch failed");
    },
  });
  const h = await withHarness(engine);
  try {
    const r = await cancelInstanceReconciling(h.api, [PR_BINDING], "100");
    assert.equal(r.ok, false); // NOT a false success
    assert.equal(r.state, "gone");
    assert.equal(r.reconciled, 0);
    assert.match(r.error ?? "", /fetch failed/);
    assert.equal(projectedState(h.db, "100"), undefined); // never record a possibly-live run as terminal
    const row = await h.table.get("100");
    assert.equal(row?.status, "converging");
    assert.ok(h.logs.some((l) => l.level === "error"));
  } finally {
    await h.close();
  }
});
