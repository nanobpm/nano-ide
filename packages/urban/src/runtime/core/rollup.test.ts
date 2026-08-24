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
  fromProjection,
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

test("defineRollup join source resolves group/predicate columns case-insensitively (SQLite folding) — parity-matches", async () => {
  // SQLite folds identifiers case-insensitively and the TS twin resolves join-mapped columns via the
  // case-insensitive `lookupColumn`, so a rollup referencing a join-mapped output column with DIFFERENT
  // casing than declared must resolve in SQL too. Before the fix `source.columns["PLAN_KEY"]` was a
  // case-sensitive miss: the SQL compilation threw `no mapped column` while the TS reduce resolved fine.
  const casedRollup = defineRollup({
    name: "plan_delivery_counts_cased",
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
    groupBy: ["PLAN_KEY"],
    aggregates: {
      prs_opened: count("PR_KEY"),
      prs_merged: countWhere(and(isNotNull(col("Pr_Key")), eq(col("PR_STATUS"), lit("merged")))),
    },
  });
  await withDb((db) => {
    assert.doesNotThrow(() =>
      assertRollupParity(casedRollup, db, [
        {
          plan_tasks: [
            { plan_key: "p1", pr_key: "pr1" },
            { plan_key: "p1", pr_key: "pr2" },
            { plan_key: "p2", pr_key: "pr3" },
          ],
          pull_requests: [
            { pr_key: "pr1", status: "merged" },
            { pr_key: "pr3", status: "merged" },
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

// ─── Regression guards: case-insensitive rcol alias resolution + null-prototype lookup map (#469 review).

test("rcol resolves case-insensitively (SQLite folding) — a differently-cased alias parity-matches", async () => {
  // Lookup aliases are validated/deduped case-insensitively and the SQL `resolveRollupColumn` folds the
  // alias, so `rcol("C", …)` against a lookup declared `as: "c"` compiles/validates fine. Before the fix
  // the TS backend read `lookups["C"]` verbatim → undefined → threw "without a resolved lookup row",
  // drifting from the working SQL LEFT JOIN. It must now resolve the same row on both backends.
  const foldedModel = defineReadModel({
    name: "plan_delivery_folded",
    baseTable: "plans",
    lookups: [
      {
        as: "c",
        rollup: planDeliveryCounts,
        on: [{ base: "plan_key", rollup: "plan_key" }],
        defaults: { prs_opened: 0 },
      },
    ],
    derive: { opened: rcol("C", "prs_opened") },
  });
  const evaluated = foldedModel.evaluate(
    { plan_key: "p1" },
    {},
    { c: [{ plan_key: "p1", prs_opened: 7 }] },
  );
  assert.equal(evaluated.opened, 7);
  await withDb((db) => {
    assert.doesNotThrow(() =>
      assertReadModelParity(foldedModel, db, [
        { baseRow: { plan_key: "p1" }, lookups: { c: [{ plan_key: "p1", prs_opened: 7 }] } },
        { baseRow: { plan_key: "p2" }, lookups: { c: [] } },
      ]),
    );
  });
});

test("resolveLookups uses a null-prototype map — a `__proto__` alias sets an own property, not the prototype", () => {
  // Lookup aliases are only identifier-validated, so `__proto__` is a legal alias. Building `resolved`
  // as a plain `{}` would route `resolved["__proto__"] = row` through the magic prototype setter,
  // corrupting the object's prototype chain instead of storing the row. A null-prototype dict avoids it.
  const evilModel = defineReadModel({
    name: "plan_delivery_proto",
    baseTable: "plans",
    lookups: [
      { as: "__proto__", rollup: planDeliveryCounts, on: [{ base: "plan_key", rollup: "plan_key" }] },
    ],
    derive: { opened: rcol("__proto__", "prs_opened") },
  });
  // Build the candidate input as a null-prototype dict: a plain `{ __proto__: [...] }` literal (or a
  // bracket assignment on a normal object) would trip the inherited `__proto__` setter instead of
  // storing an own "__proto__" property, so the row would never reach the resolver.
  const candidates: Record<string, ReadonlyArray<Record<string, unknown>>> = Object.create(null);
  candidates.__proto__ = [{ plan_key: "p1", prs_opened: 5 }];
  const resolved = evilModel.resolveLookups({ plan_key: "p1" }, candidates);
  assert.equal(Object.getPrototypeOf(resolved), null);
  assert.ok(Object.hasOwn(resolved, "__proto__"));
  assert.equal(Object.getPrototypeOf({}), Object.prototype);
  const evaluated = evilModel.evaluate({ plan_key: "p1" }, {}, candidates);
  assert.equal(evaluated.opened, 5);
});

test("resolveLookups reads candidates by OWN property — a `__proto__` alias over a plain `{}` yields no match, not a throw", () => {
  // The candidate input is a caller-supplied object; a normal `{}` inherits `Object.prototype`, so a
  // `__proto__` alias would resolve `lookupRows["__proto__"]` to `Object.prototype` (truthy, non-array)
  // and the internal `.filter(...)` would throw. Reading via `Object.hasOwn` treats it as absent instead.
  const evilModel = defineReadModel({
    name: "plan_delivery_proto_input",
    baseTable: "plans",
    lookups: [
      { as: "__proto__", rollup: planDeliveryCounts, on: [{ base: "plan_key", rollup: "plan_key" }] },
    ],
    derive: { opened: rcol("__proto__", "prs_opened") },
  });
  // A plain object literal with no own `__proto__` property: the lookup must fall back to "no candidates".
  const plainInput: Record<string, ReadonlyArray<Record<string, unknown>>> = {};
  assert.doesNotThrow(() => evilModel.resolveLookups({ plan_key: "p1" }, plainInput));
  const resolved = evilModel.resolveLookups({ plan_key: "p1" }, plainInput);
  assert.equal(resolved.__proto__.prs_opened, null);
  const evaluated = evilModel.evaluate({ plan_key: "p1" }, {}, plainInput);
  assert.equal(evaluated.opened, null);
});

test("resolveLookups reads candidates case-insensitively — a differently-cased alias key still matches", async () => {
  // Lookup aliases are case-insensitive SQL identifiers: `resolveLookups` stores its resolved row under
  // `foldSqlIdentifier(alias)` and `rcol` reads it folded. A caller that supplies candidates under a
  // different casing (e.g. `{ C: [...] }` for an alias declared `c`) must therefore still be matched —
  // a raw case-sensitive `lookupRows["c"]` would treat them as "no candidates" and NULL/default-fill,
  // drifting from the folded treatment (and from the SQL LEFT JOIN, which never sees this dictionary).
  const model = defineReadModel({
    name: "plan_delivery_cased_input",
    baseTable: "plans",
    lookups: [
      {
        as: "c",
        rollup: planDeliveryCounts,
        on: [{ base: "plan_key", rollup: "plan_key" }],
        defaults: { prs_opened: 0 },
      },
    ],
    derive: { opened: rcol("c", "prs_opened") },
  });
  // Candidate keyed under the UPPER-CASE alias for a lookup declared `as: "c"`.
  const resolved = model.resolveLookups({ plan_key: "p1" }, { C: [{ plan_key: "p1", prs_opened: 9 }] });
  assert.equal(resolved.c.prs_opened, 9);
  const evaluated = model.evaluate({ plan_key: "p1" }, {}, { C: [{ plan_key: "p1", prs_opened: 9 }] });
  assert.equal(evaluated.opened, 9);
  // Parity: the SQL VIEW reads the real rollup relation, so both backends must land the same value.
  await withDb((db) => {
    assert.doesNotThrow(() =>
      assertReadModelParity(model, db, [
        { baseRow: { plan_key: "p1" }, lookups: { c: [{ plan_key: "p1", prs_opened: 9 }] } },
        { baseRow: { plan_key: "p2" }, lookups: { c: [] } },
      ]),
    );
  });
});

test("assertRollupParity builds TEMP fixtures under the PHYSICAL table a projection name maps to", async () => {
  // A `fromProjection` source names a LOGICAL projection; the compiled VIEW resolves it to a physical
  // relation via `resolveProjectionTable` (e.g. `urban_instance_state` → `_urban_instance_state`). The
  // parity guard must create/insert its TEMP fixtures under that PHYSICAL name — otherwise the VIEW's
  // FROM points at a table the (logical-named) fixture never created and SQLite throws "no such table".
  // Sample rows stay keyed by the logical projection name (what `RollupInputs`/`reduce` read).
  const instanceRollup = defineRollup({
    name: "instance_state_counts",
    source: fromProjection("urban_instance_state"),
    groupBy: ["status"],
    aggregates: { total: count() },
  });
  const remap = (n: string): string => (n === "urban_instance_state" ? "_urban_instance_state" : n);
  await withDb((db) => {
    assert.doesNotThrow(() =>
      assertRollupParity(
        instanceRollup,
        db,
        [
          {
            urban_instance_state: [
              { status: "active", instance_key: "i1" },
              { status: "active", instance_key: "i2" },
              { status: "done", instance_key: "i3" },
            ],
          },
          { urban_instance_state: [] },
        ],
        { sql: { resolveProjectionTable: remap } },
      ),
    );
  });
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
