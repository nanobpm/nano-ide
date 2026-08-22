import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createNodeHost } from "../../adapters/node.ts";
import type { SqliteDb } from "../host.ts";
import {
  and,
  caseWhen,
  col,
  defineReadModel,
  eq,
  exists,
  lit,
  pcol,
  projectionRegistry,
  type ParitySample,
  type ReadModel,
  when,
  assertReadModelParity,
} from "../read-model.ts";
import {
  CANONICAL_PROJECTIONS,
  registerCanonicalProjections,
} from "./canonical-projections.ts";
import { INSTANCE_STATE_TABLE, InstanceStateStore } from "./instance-state-store.ts";
import { OPEN_USER_TASKS_TABLE, OpenUserTasksStore } from "./open-user-tasks-store.ts";

// This suite registers into the process-wide `projectionRegistry` singleton; clear it after every
// test so registrations never leak into later tests and make the suite order-dependent.
afterEach(() => {
  projectionRegistry.clear();
});

// A read model that derives an instance's status edge PURELY from the two canonical projections:
//   terminated → "abandoned"  (terminated wins), else open user task → "awaiting_operator", else the
// instance's own stored status. This is the shape the downstream writer-source-inversion task derives.
function statusEdgeModel(): ReadModel {
  return defineReadModel({
    name: "urban_instance_status",
    baseTable: "instances",
    derive: {
      status_edge: caseWhen(
        [
          when(
            exists(
              "urban_instance_state",
              and(eq(pcol("process_instance_key"), col("process_instance_key")), eq(pcol("state"), lit("TERMINATED"))),
            ),
            lit("abandoned"),
          ),
          when(
            exists("urban_open_user_tasks", eq(pcol("process_instance_key"), col("process_instance_key"))),
            lit("awaiting_operator"),
          ),
        ],
        col("status"),
      ),
    },
  });
}

async function withDb(fn: (db: SqliteDb) => void | Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "urban-canonical-"));
  const host = createNodeHost({ cwd: dir, log: () => {} });
  const db = host.openSqlite(join(dir, "test.db"));
  try {
    await fn(db);
  } finally {
    db.close();
    await rm(dir, { recursive: true, force: true });
  }
}

test("registerCanonicalProjections maps each DSL name onto its `_urban_` physical table", () => {
  registerCanonicalProjections();
  assert.equal(projectionRegistry.sqlTableFor("urban_open_user_tasks"), OPEN_USER_TASKS_TABLE);
  assert.equal(projectionRegistry.sqlTableFor("urban_instance_state"), INSTANCE_STATE_TABLE);
  // Idempotent: a second registration is a no-op, not a conflict throw.
  assert.doesNotThrow(() => registerCanonicalProjections());
  assert.deepEqual(
    CANONICAL_PROJECTIONS.map((p) => p.name).sort(),
    ["urban_instance_state", "urban_open_user_tasks"],
  );
});

test("a defineReadModel EXISTS over both projections materialises a VIEW that reads the sidecar tables", async () => {
  registerCanonicalProjections();
  await withDb((db) => {
    // Provision the two engine-truth sidecars exactly as the runtime boot path does.
    const openTasks = new OpenUserTasksStore(db, { clock: { now: () => 0 } });
    const instanceState = new InstanceStateStore(db, { clock: { now: () => 0 } });
    openTasks.ensureSchema();
    instanceState.ensureSchema();

    // The base domain table the read model derives over.
    db.exec("CREATE TABLE instances (process_instance_key TEXT, status TEXT);");
    for (const key of ["pi-active", "pi-human", "pi-terminated", "pi-both"]) {
      db.run("INSERT INTO instances (process_instance_key, status) VALUES (?, ?);", [key, "running"]);
    }

    // Record engine truth into the projections (the sources the VIEW derives from).
    instanceState.recordState("pi-active", "ACTIVE");
    instanceState.recordState("pi-human", "ACTIVE", true);
    openTasks.syncInstance("pi-human", [{ userTaskKey: "ut-1", elementId: "Approve" }]);
    instanceState.recordState("pi-terminated", "TERMINATED");
    // pi-both: terminated AND has an open task — terminated must win.
    instanceState.recordState("pi-both", "TERMINATED");
    openTasks.syncInstance("pi-both", [{ userTaskKey: "ut-2" }]);

    // Materialise the framework-derived managed VIEW and read the derived edge.
    const model = statusEdgeModel();
    db.exec(model.viewDdl());
    const rows = db.all<{ process_instance_key: string; status_edge: string }>(
      "SELECT process_instance_key, status_edge FROM urban_instance_status ORDER BY process_instance_key;",
    );
    const byKey = Object.fromEntries(rows.map((r) => [r.process_instance_key, r.status_edge]));
    assert.equal(byKey["pi-active"], "running", "no terminal/human edge ⇒ the base status survives");
    assert.equal(byKey["pi-human"], "awaiting_operator", "an open user task ⇒ awaiting_operator");
    assert.equal(byKey["pi-terminated"], "abandoned", "TERMINATED ⇒ abandoned");
    assert.equal(byKey["pi-both"], "abandoned", "terminated wins over waiting-on-human");
  });
});

test("the SQLite VIEW and the TS function agree over the canonical projections (parity guard)", async () => {
  registerCanonicalProjections();
  const model = statusEdgeModel();
  const samples: ParitySample[] = [
    // Terminal edge.
    {
      baseRow: { process_instance_key: "pi-1", status: "running" },
      projections: { urban_instance_state: [{ process_instance_key: "pi-1", state: "TERMINATED" }] },
    },
    // Wait-on-human edge.
    {
      baseRow: { process_instance_key: "pi-2", status: "running" },
      projections: { urban_open_user_tasks: [{ process_instance_key: "pi-2", user_task_key: "ut-1" }] },
    },
    // Neither edge ⇒ the base status survives.
    {
      baseRow: { process_instance_key: "pi-3", status: "running" },
      projections: {},
    },
    // Correlation: an open task for a DIFFERENT instance must not match.
    {
      baseRow: { process_instance_key: "pi-4", status: "running" },
      projections: { urban_open_user_tasks: [{ process_instance_key: "pi-x", user_task_key: "ut-2" }] },
    },
    // Precedence: terminated AND open task ⇒ abandoned (terminated wins).
    {
      baseRow: { process_instance_key: "pi-5", status: "running" },
      projections: {
        urban_instance_state: [{ process_instance_key: "pi-5", state: "TERMINATED" }],
        urban_open_user_tasks: [{ process_instance_key: "pi-5", user_task_key: "ut-3" }],
      },
    },
    // A non-terminal recorded state ⇒ no terminal edge.
    {
      baseRow: { process_instance_key: "pi-6", status: "converging" },
      projections: { urban_instance_state: [{ process_instance_key: "pi-6", state: "ACTIVE" }] },
    },
  ];

  await withDb((db) => {
    // The parity guard builds its own isolated TEMP fixtures for the base + projection tables and
    // asserts the SQL VIEW and the compiled TS function agree for every sample — no bespoke oracle.
    assert.doesNotThrow(() => assertReadModelParity(model, db, samples));
  });
});

test("the parity guard catches a divergence between the two backends", async () => {
  registerCanonicalProjections();
  const model = statusEdgeModel();
  // Feed the guard's SQL side a sample, but hand a mutated TS function that disagrees, to prove the
  // guard is actually comparing the two backends (not trivially passing).
  const mutated: ReadModel = { ...model, fnFor: () => () => "WRONG" };
  await withDb((db) => {
    assert.throws(
      () =>
        assertReadModelParity(mutated, db, [
          {
            baseRow: { process_instance_key: "pi-1", status: "running" },
            projections: { urban_instance_state: [{ process_instance_key: "pi-1", state: "TERMINATED" }] },
          },
        ]),
      /parity mismatch/,
    );
  });
});
