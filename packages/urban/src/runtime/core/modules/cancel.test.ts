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
import { cancelInstanceReconciling } from "./cancel.ts";

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

// The pull_requests binding: an ACTIVE row flips to `abandoned` (and drops the process pointer)
// when its instance terminates — the exact patch the poll reconciler applies.
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
    registerWorker: notUsed("registerWorker"),
    close: notUsed("close"),
  };
  return { engine, cancels };
}

interface Harness {
  api: AppApi;
  table: Table<PrRow>;
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
    log: createLogger((level, msg) => {
      logs.push({ level, msg });
    }),
  };
  return {
    api,
    table,
    logs,
    close: async () => {
      db.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

test("terminating a tracked instance reconciles its row immediately", async () => {
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
    const row = await h.table.get("100");
    assert.equal(row, undefined); // process_key was cleared to null, so no row keyed by "100"
    const byPr = (await h.table.all()).find((x) => x.pr_key === "pr-1");
    assert.equal(byPr?.status, "abandoned");
    assert.equal(byPr?.process_key, null);
  } finally {
    await h.close();
  }
});

test("a cancel that throws but reads back TERMINATED is idempotent success + reconciles", async () => {
  // The instance was already terminated; the engine rejects a second cancel, but the verify read
  // confirms it is gone — treat as success and still reconcile the (stale-active) row.
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
    const byPr = (await h.table.all()).find((x) => x.pr_key === "pr-1");
    assert.equal(byPr?.status, "abandoned");
  } finally {
    await h.close();
  }
});

test("a failed cancel with a still-ACTIVE instance is an honest failure and touches no row", async () => {
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
    const row = await h.table.get("100");
    assert.equal(row?.status, "converging"); // untouched — instance still running
    assert.ok(h.logs.some((l) => l.level === "error"));
  } finally {
    await h.close();
  }
});

test("a COMPLETED instance is not reconciled (the app's finalize logic owns that row)", async () => {
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
    const row = await h.table.get("100");
    assert.equal(row?.status, "converging"); // left for the finalize worker, not clobbered
  } finally {
    await h.close();
  }
});

test("a gone/unknown instance is idempotent success with no reconcile", async () => {
  const { engine } = cancelEngine({
    states: {}, // the engine has no record of this key
    onCancel: () => {},
  });
  const h = await withHarness(engine);
  try {
    const r = await cancelInstanceReconciling(h.api, [PR_BINDING], "999999");
    assert.equal(r.ok, true);
    assert.equal(r.state, "gone");
    assert.equal(r.reconciled, 0);
  } finally {
    await h.close();
  }
});

test("a TERMINATED instance with no matching binding row reconciles nothing", async () => {
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
    assert.equal(r.reconciled, 0);
    const row = await h.table.get("100");
    assert.equal(row?.status, "converging");
  } finally {
    await h.close();
  }
});

test("a reconcile write failure does not fail the cancel (the engine already terminated it)", async () => {
  const { engine } = cancelEngine({
    states: { "100": "ACTIVE" },
    onCancel: (key, states) => {
      states[key] = "TERMINATED";
    },
  });
  const h = await withHarness(engine);
  try {
    // A binding pointing at a table that does not exist makes the reconcile UPDATE throw.
    const badBinding: InstanceTracking = {
      table: "does_not_exist",
      keyField: "process_key",
      onTerminated: { set: { status: "abandoned" } },
    };
    const r = await cancelInstanceReconciling(h.api, [badBinding], "100");
    assert.equal(r.ok, true); // engine termination succeeded — the cancel is a success
    assert.equal(r.state, "TERMINATED");
    assert.equal(r.reconciled, 0);
    assert.ok(r.error); // the reconcile failure is surfaced, not swallowed
    assert.ok(h.logs.some((l) => l.level === "error"));
  } finally {
    await h.close();
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
    assert.equal(r.reconciled, 0);
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
    const row = await h.table.get("100");
    assert.equal(row?.status, "converging"); // never flip a possibly-live run to a terminal status
    assert.ok(h.logs.some((l) => l.level === "error"));
  } finally {
    await h.close();
  }
});
