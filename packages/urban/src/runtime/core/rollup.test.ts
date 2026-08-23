import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createNodeHost } from "../adapters/node.ts";
import type { SqliteDb } from "./host.ts";
import {
  add,
  and,
  assertReadModelParity,
  assertRollupParity,
  caseWhen,
  coalesce,
  col,
  count,
  countWhere,
  defineReadModel,
  defineRollup,
  eq,
  fromRollup,
  gt,
  isNotNull,
  isNull,
  joinSource,
  lit,
  max,
  minWhere,
  neq,
  not,
  or,
  pcol,
  exists,
  ProjectionRegistry,
  projectionRegistry,
  rcol,
  RollupRegistry,
  when,
} from "./read-model.ts";
import type { Rollup } from "./read-model.ts";

async function withDb(fn: (db: SqliteDb) => void | Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "urban-rollup-"));
  const host = createNodeHost({ cwd: dir, log: () => {} });
  const db = host.openSqlite(join(dir, "test.db"));
  try {
    await fn(db);
  } finally {
    db.close();
    await rm(dir, { recursive: true, force: true });
  }
}

// ─── The plan-family rollups, single-sourced from the hand-authored VIEWs (nano-workforce 059/060/061).

// plan_delivery_counts — GROUP BY plan_key over plan_tasks LEFT JOIN pull_requests ON pr_key.
const planDeliveryCounts = defineRollup({
  name: "plan_delivery_counts",
  source: joinSource({
    left: { relation: "plan_tasks", alias: "t" },
    right: { relation: "pull_requests", alias: "p" },
    on: [{ left: "pr_key", right: "pr_key" }],
    columns: {
      plan_key: ["left", "plan_key"],
      pr_key: ["left", "pr_key"],
      pr_status: ["right", "status"],
    },
  }),
  groupBy: ["plan_key"],
  aggregates: {
    prs_opened: count("pr_key"),
    prs_merged: countWhere(and(isNotNull(col("pr_key")), eq(col("pr_status"), lit("merged")))),
    prs_in_flight: countWhere(
      and(
        isNotNull(col("pr_key")),
        or(
          isNull(col("pr_status")),
          not(
            or(
              eq(col("pr_status"), lit("converged")),
              eq(col("pr_status"), lit("merged")),
              eq(col("pr_status"), lit("abandoned")),
            ),
          ),
        ),
      ),
    ),
  },
});

// plan_wave_counts — GROUP BY (plan_key, wave), WHERE wave IS NOT NULL. The disjoint six-way partition.
const notMerged = not(eq(col("pr_status"), lit("merged")));
const planWaveCounts = defineRollup({
  name: "plan_wave_counts",
  source: joinSource({
    left: { relation: "plan_tasks", alias: "t" },
    right: { relation: "pull_requests", alias: "p" },
    on: [{ left: "pr_key", right: "pr_key" }],
    columns: {
      plan_key: ["left", "plan_key"],
      wave: ["left", "wave"],
      task_status: ["left", "status"],
      pr_status: ["right", "status"],
    },
  }),
  where: isNotNull(col("wave")),
  groupBy: ["plan_key", "wave"],
  aggregates: {
    total: count(),
    merged: countWhere(eq(col("pr_status"), lit("merged"))),
    skipped: countWhere(and(notMerged, eq(col("task_status"), lit("skipped")))),
    blocked: countWhere(and(notMerged, eq(col("task_status"), lit("blocked")))),
    escalated: countWhere(and(notMerged, eq(col("task_status"), lit("escalated")))),
    in_flight: countWhere(
      and(
        notMerged,
        not(
          or(
            eq(col("task_status"), lit("skipped")),
            eq(col("task_status"), lit("blocked")),
            eq(col("task_status"), lit("escalated")),
          ),
        ),
      ),
    ),
  },
});

// plan_wave_progress — COMPOSABLE: GROUP BY plan_key over plan_wave_counts (the wave frontier).
const planWaveProgress = defineRollup({
  name: "plan_wave_progress",
  source: fromRollup(planWaveCounts),
  groupBy: ["plan_key"],
  aggregates: {
    wave_count: add(max("wave"), 1),
    current_wave: coalesce(minWhere("wave", gt(col("in_flight"), lit(0))), max("wave")),
  },
});

test("defineRollup (join source, D2 count/countWhere) parity-matches its VIEW — plan_delivery_counts", async () => {
  await withDb((db) => {
    assert.doesNotThrow(() =>
      assertRollupParity(planDeliveryCounts, db, [
        {
          // p1: all merged → landed shape; p2: one in flight; p3: no PRs.
          plan_tasks: [
            { plan_key: "p1", pr_key: "pr1" },
            { plan_key: "p1", pr_key: "pr2" },
            { plan_key: "p2", pr_key: "pr3" },
            { plan_key: "p2", pr_key: "pr4" },
            { plan_key: "p3", pr_key: null },
          ],
          pull_requests: [
            { pr_key: "pr1", status: "merged" },
            { pr_key: "pr2", status: "merged" },
            { pr_key: "pr3", status: "merged" },
            // pr4 has no pull_requests row → in flight (MISSING_PR_STATUS sentinel).
          ],
        },
      ]),
    );
  });
});

test("defineRollup (two-level group key + WHERE) parity-matches — plan_wave_counts", async () => {
  await withDb((db) => {
    assert.doesNotThrow(() =>
      assertRollupParity(planWaveCounts, db, [
        {
          plan_tasks: [
            { plan_key: "p1", wave: 0, status: "merged", pr_key: "a" },
            { plan_key: "p1", wave: 0, status: "opened", pr_key: "b" },
            { plan_key: "p1", wave: 1, status: "blocked", pr_key: "c" },
            { plan_key: "p1", wave: 1, status: "skipped", pr_key: null },
            { plan_key: "p2", wave: 0, status: "escalated", pr_key: "d" },
            // NULL wave rows are excluded by WHERE wave IS NOT NULL.
            { plan_key: "p1", wave: null, status: "opened", pr_key: null },
          ],
          pull_requests: [
            { pr_key: "a", status: "merged" },
            { pr_key: "b", status: "opened" },
            { pr_key: "c", status: "opened" },
            { pr_key: "d", status: "opened" },
          ],
        },
      ]),
    );
  });
});

test("defineRollup COMPOSABLE over a rollup (add/coalesce/minWhere/max) parity-matches — wave frontier", async () => {
  await withDb((db) => {
    assert.doesNotThrow(() =>
      assertRollupParity(planWaveProgress, db, [
        {
          plan_tasks: [
            // p1: wave 0 fully merged, wave 1 in flight → wave_count=2, current_wave=1.
            { plan_key: "p1", wave: 0, status: "merged", pr_key: "a" },
            { plan_key: "p1", wave: 1, status: "opened", pr_key: "b" },
            // p2: all waves settled → current_wave pins to MAX(wave).
            { plan_key: "p2", wave: 0, status: "merged", pr_key: "c" },
            { plan_key: "p2", wave: 1, status: "merged", pr_key: "d" },
          ],
          pull_requests: [
            { pr_key: "a", status: "merged" },
            { pr_key: "b", status: "opened" },
            { pr_key: "c", status: "merged" },
            { pr_key: "d", status: "merged" },
          ],
        },
      ]),
    );
  });
});

test("the rollup parity guard FAILS when the TS reduce is deliberately drifted from the VIEW", async () => {
  const drifted: Rollup = {
    ...planDeliveryCounts,
    // Mutate the TS backend: drop one row so a group count diverges from the SQL VIEW.
    reduce: (inputs) => planDeliveryCounts.reduce(inputs).map((r) => ({ ...r, prs_opened: 999 })),
  };
  await withDb((db) => {
    assert.throws(
      () =>
        assertRollupParity(drifted, db, [
          { plan_tasks: [{ plan_key: "p1", pr_key: "pr1" }], pull_requests: [{ pr_key: "pr1", status: "merged" }] },
        ]),
      /rollup parity mismatch in "plan_delivery_counts"\.prs_opened/,
    );
  });
});

// ─── defineReadModel + key-correlated rollup lookup: the per-row delivery signal (nano-workforce 061).

const planDelivery = defineReadModel({
  name: "plan_delivery",
  baseTable: "plans",
  lookups: [
    {
      as: "c",
      rollup: planDeliveryCounts,
      on: [{ base: "plan_key", rollup: "plan_key" }],
      defaults: { prs_opened: 0, prs_in_flight: 0, prs_merged: 0 },
    },
  ],
  derive: {
    delivery: caseWhen(
      [
        when(or(neq(col("status"), lit("done")), eq(rcol("c", "prs_opened"), lit(0))), lit(null)),
        when(gt(rcol("c", "prs_in_flight"), lit(0)), lit("converging")),
        when(eq(rcol("c", "prs_merged"), rcol("c", "prs_opened")), lit("landed")),
      ],
      lit(null),
    ),
  },
});

test("defineReadModel rollup lookup (rcol + defaults) parity-matches — plan_delivery signal", async () => {
  await withDb((db) => {
    assert.doesNotThrow(() =>
      assertReadModelParity(planDelivery, db, [
        // done + all merged → landed.
        {
          baseRow: { plan_key: "p1", status: "done" },
          lookups: { c: [{ plan_key: "p1", prs_opened: 2, prs_merged: 2, prs_in_flight: 0 }] },
        },
        // done + some in flight → converging.
        {
          baseRow: { plan_key: "p2", status: "done" },
          lookups: { c: [{ plan_key: "p2", prs_opened: 3, prs_merged: 1, prs_in_flight: 2 }] },
        },
        // done + no PRs (LEFT-JOIN miss → COALESCE defaults) → null.
        { baseRow: { plan_key: "p3", status: "done" }, lookups: { c: [] } },
        // not done → null (regardless of counts).
        {
          baseRow: { plan_key: "p4", status: "running" },
          lookups: { c: [{ plan_key: "p4", prs_opened: 2, prs_merged: 2, prs_in_flight: 0 }] },
        },
        // done, resolved-not-landed (terminal but not all merged) → null.
        {
          baseRow: { plan_key: "p5", status: "done" },
          lookups: { c: [{ plan_key: "p5", prs_opened: 3, prs_merged: 2, prs_in_flight: 0 }] },
        },
      ]),
    );
  });
});

test("defineReadModel evaluate resolves the lookup + defaults the same way the VIEW does", () => {
  const landed = planDelivery.evaluate(
    { plan_key: "p1", status: "done" },
    {},
    { c: [{ plan_key: "p1", prs_opened: 2, prs_merged: 2, prs_in_flight: 0 }] },
  );
  assert.equal(landed.delivery, "landed");
  const noPrs = planDelivery.evaluate({ plan_key: "p3", status: "done" }, {}, { c: [] });
  assert.equal(noPrs.delivery, null);
});

test("a bare fnFor call on an rcol column fails loudly (must resolve lookups via evaluate)", () => {
  // rcol needs a resolved lookup row; a caller that skips resolution (bare fnFor, no lookups arg) must
  // get a clear error rather than a silent NULL that would drift from the VIEW's LEFT JOIN.
  assert.throws(
    () => planDelivery.fnFor("delivery")({ plan_key: "p1", status: "done" }),
    /without a resolved lookup row/,
  );
});

test("a rollup lookup with MORE than one candidate match throws (single-valued, no silent fan-out)", () => {
  // The join covers the rollup's full group key, so at most one row matches. Two matching candidate rows
  // would fan out in SQL's LEFT JOIN while the TS resolver silently kept one — detect and fail loudly.
  assert.throws(
    () =>
      planDelivery.resolveLookups({ plan_key: "p1", status: "done" }, {
        c: [
          { plan_key: "p1", prs_opened: 2, prs_merged: 2, prs_in_flight: 0 },
          { plan_key: "p1", prs_opened: 9, prs_merged: 0, prs_in_flight: 9 },
        ],
      }),
    /matched 2 rows for the join key/,
  );
});

test("a read model can carry TWO distinct rollup lookups (plan_read_model shape)", async () => {
  const planSummary = defineReadModel({
    name: "plan_summary_rm",
    baseTable: "plans",
    selectBaseColumns: false,
    lookups: [
      { as: "w", rollup: planWaveProgress, on: [{ base: "plan_key", rollup: "plan_key" }] },
      {
        as: "d",
        rollup: planDeliveryCounts,
        on: [{ base: "plan_key", rollup: "plan_key" }],
        defaults: { prs_opened: 0 },
      },
    ],
    derive: {
      wave_count: rcol("w", "wave_count"),
      current_wave: rcol("w", "current_wave"),
      has_prs: gt(rcol("d", "prs_opened"), lit(0)),
    },
  });
  await withDb((db) => {
    assert.doesNotThrow(() =>
      assertReadModelParity(planSummary, db, [
        {
          baseRow: { plan_key: "p1" },
          lookups: {
            w: [{ plan_key: "p1", wave_count: 3, current_wave: 1 }],
            d: [{ plan_key: "p1", prs_opened: 4 }],
          },
        },
        { baseRow: { plan_key: "p2" }, lookups: { w: [], d: [] } },
      ]),
    );
  });
});

// ─── Registry + validation.

test("RollupRegistry.ensureViews applies composed VIEWs in dependency order and registers the projection", async () => {
  const registry = new RollupRegistry();
  const projections = new ProjectionRegistry();
  registry.register(planWaveCounts, projections);
  registry.register(planWaveProgress, projections);
  assert.ok(projections.has("plan_wave_counts"));
  assert.ok(projections.has("plan_wave_progress"));
  await withDb((db) => {
    // A composed rollup's VIEW references its dependency's VIEW, so applying out of order would fail;
    // ensureViews must topologically order the chain (dependency first).
    assert.doesNotThrow(() => registry.ensureViews(db));
    db.exec(`CREATE TABLE plan_tasks (plan_key TEXT, wave INTEGER, status TEXT, pr_key TEXT);`);
    db.exec(`CREATE TABLE pull_requests (pr_key TEXT, status TEXT);`);
    db.run(`INSERT INTO plan_tasks VALUES (?,?,?,?)`, ["p1", 0, "merged", "a"]);
    db.run(`INSERT INTO pull_requests VALUES (?,?)`, ["a", "merged"]);
    const rows = db.all<Record<string, unknown>>(`SELECT wave_count, current_wave FROM plan_wave_progress;`);
    assert.equal(Number(rows[0].wave_count), 1);
    assert.equal(Number(rows[0].current_wave), 0);
  });
});

test("a rollup lookup must join on the rollup's full group key (single-valued)", () => {
  assert.throws(
    () =>
      defineReadModel({
        name: "bad_lookup_rm",
        baseTable: "plans",
        lookups: [{ as: "c", rollup: planWaveCounts, on: [{ base: "plan_key", rollup: "plan_key" }] }],
        derive: { x: rcol("c", "total") },
      }),
    /must join on the rollup's full group key \[plan_key, wave\]/,
  );
});

test("add() rejects a non-integer literal at build time", () => {
  assert.throws(() => add(count(), 1.5), /must be an integer/);
});

test("a rollup aggregate predicate rejects exists(...) — the rollup surface stays closed", () => {
  assert.throws(
    () =>
      defineRollup({
        name: "bad_pred_rollup",
        source: { kind: "table", table: "t" },
        groupBy: ["k"],
        aggregates: { n: countWhere(exists("proj", eq(pcol("k"), col("k")))) },
      }),
    /is not valid in a rollup predicate/,
  );
});

test("rcol referencing an undeclared lookup alias is rejected at declaration", () => {
  assert.throws(
    () =>
      defineReadModel({
        name: "unknown_alias_rm",
        baseTable: "plans",
        lookups: [{ as: "c", rollup: planDeliveryCounts, on: [{ base: "plan_key", rollup: "plan_key" }] }],
        derive: { x: rcol("nope", "prs_opened") },
      }),
    /rollup-lookup alias "nope"/,
  );
});

test("rcol referencing a non-existent rollup column is rejected at declaration", () => {
  assert.throws(
    () =>
      defineReadModel({
        name: "unknown_col_rm",
        baseTable: "plans",
        lookups: [{ as: "c", rollup: planDeliveryCounts, on: [{ base: "plan_key", rollup: "plan_key" }] }],
        derive: { x: rcol("c", "not_a_column") },
      }),
    /"not_a_column" is not a column of rollup/,
  );
});

test("the rollup VIEW DDL is a closed GROUP BY select (no raw SQL, deterministic)", () => {
  const ddl = planDeliveryCounts.viewDdl();
  assert.match(ddl, /^CREATE VIEW IF NOT EXISTS "plan_delivery_counts" AS/);
  assert.match(ddl, /GROUP BY "t"\."plan_key"/);
  assert.match(ddl, /LEFT JOIN "pull_requests" "p" ON "t"\."pr_key" = "p"\."pr_key"/);
  assert.match(ddl, /COUNT\("t"\."pr_key"\) AS "prs_opened"/);
});

// A projection referenced by exists() still resolves through the process-wide registry after a rollup
// registers its name there — sanity that the two seams coexist.
test("registering a rollup exposes its name via the process-wide projectionRegistry", () => {
  const before = projectionRegistry.has("plan_delivery_counts");
  try {
    new RollupRegistry().register(planDeliveryCounts);
    assert.ok(projectionRegistry.has("plan_delivery_counts"));
  } finally {
    if (!before) projectionRegistry.clear();
  }
});
