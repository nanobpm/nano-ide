import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createNodeHost } from "../adapters/node.ts";
import type { SqliteDb } from "./host.ts";
import {
  and,
  assertReadModelParity,
  caseWhen,
  col,
  compileToFn,
  compileToSqlSelect,
  defineReadModel,
  eq,
  exists,
  gt,
  lit,
  neq,
  pcol,
  ProjectionRegistry,
  projectionRegistry,
  ReadModelRegistry,
  when,
} from "./read-model.ts";
import type { ReadModel } from "./read-model.ts";

async function withDb(fn: (db: SqliteDb) => void | Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "urban-read-model-"));
  const host = createNodeHost({ cwd: dir, log: () => {} });
  const db = host.openSqlite(join(dir, "test.db"));
  try {
    await fn(db);
  } finally {
    db.close();
    await rm(dir, { recursive: true, force: true });
  }
}

// A representative read model exercising CASE + EXISTS + a comparison, declared ONCE. Its base rows
// are `tasks`; it references the (fixture) canonical projection `urban_open_user_tasks` by name.
const taskReadModel: ReadModel = defineReadModel({
  name: "tasks_display",
  baseTable: "tasks",
  derive: {
    // done → completed; else if an open user task exists for the instance → awaiting_operator; else active.
    display_status: caseWhen(
      [
        when(eq(col("state"), lit("done")), lit("completed")),
        when(
          exists("urban_open_user_tasks", eq(pcol("process_instance_key"), col("process_instance_key"))),
          lit("awaiting_operator"),
        ),
      ],
      lit("active"),
    ),
    // A plain comparison → a boolean derived column (round-trips as 0/1 in SQLite).
    is_high_priority: gt(col("priority"), lit(5)),
  },
});

function seedFixtures(db: SqliteDb): void {
  db.exec(`CREATE TABLE tasks (id TEXT, process_instance_key TEXT, state TEXT, priority INTEGER);`);
  db.exec(`CREATE TABLE urban_open_user_tasks (process_instance_key TEXT);`);
  db.exec(taskReadModel.viewDdl());
  // t1: done, high priority → completed / high; no open user task.
  db.run(`INSERT INTO tasks VALUES (?, ?, ?, ?)`, ["t1", "pi-1", "done", 9]);
  // t2: running, has an open user task → awaiting_operator / not high.
  db.run(`INSERT INTO tasks VALUES (?, ?, ?, ?)`, ["t2", "pi-2", "running", 3]);
  db.run(`INSERT INTO urban_open_user_tasks VALUES (?)`, ["pi-2"]);
  // t3: running, no open user task → active / high.
  db.run(`INSERT INTO tasks VALUES (?, ?, ?, ?)`, ["t3", "pi-3", "running", 8]);
}

const EXPECTED: Record<string, { display_status: string; is_high_priority: number }> = {
  t1: { display_status: "completed", is_high_priority: 1 },
  t2: { display_status: "awaiting_operator", is_high_priority: 0 },
  t3: { display_status: "active", is_high_priority: 1 },
};

test("(i) the read model with CASE + EXISTS compiles to a SQLite VIEW returning the expected values", async () => {
  await withDb((db) => {
    seedFixtures(db);
    const rows = db
      .all<{ id: string; display_status: string; is_high_priority: number }>(
        `SELECT id, display_status, is_high_priority FROM tasks_display ORDER BY id`,
      )
      .map((r) => ({ ...r }));
    assert.deepEqual(
      rows,
      [
        { id: "t1", ...EXPECTED.t1 },
        { id: "t2", ...EXPECTED.t2 },
        { id: "t3", ...EXPECTED.t3 },
      ],
      "SQLite VIEW derived columns must match the expected derivation",
    );
    // The managed VIEW re-exports the base columns alongside the derived ones.
    const full = db.all<Record<string, unknown>>(`SELECT * FROM tasks_display WHERE id = 't1'`)[0];
    assert.equal(full.state, "done");
    assert.equal(full.priority, 9);
  });
});

test("(ii) the TS function returns the SAME values as the SQL VIEW for the same inputs", () => {
  const projections = { urban_open_user_tasks: [{ process_instance_key: "pi-2" }] };
  const inputs: Record<string, { process_instance_key: string; state: string; priority: number }> = {
    t1: { process_instance_key: "pi-1", state: "done", priority: 9 },
    t2: { process_instance_key: "pi-2", state: "running", priority: 3 },
    t3: { process_instance_key: "pi-3", state: "running", priority: 8 },
  };
  for (const [id, base] of Object.entries(inputs)) {
    const out = taskReadModel.evaluate(base, projections);
    assert.equal(out.display_status, EXPECTED[id].display_status, `display_status for ${id}`);
    // The TS backend yields a boolean; SQLite yields 0/1 — same truth value.
    assert.equal(out.is_high_priority ? 1 : 0, EXPECTED[id].is_high_priority, `is_high_priority for ${id}`);
  }
});

test("(iii) the parity guard PASSES when the two backends agree", async () => {
  await withDb((db) => {
    assert.doesNotThrow(() =>
      assertReadModelParity(taskReadModel, db, [
        { baseRow: { process_instance_key: "pi-1", state: "done", priority: 9 }, projections: {} },
        {
          baseRow: { process_instance_key: "pi-2", state: "running", priority: 3 },
          projections: { urban_open_user_tasks: [{ process_instance_key: "pi-2" }] },
        },
        {
          baseRow: { process_instance_key: "pi-3", state: "running", priority: 8 },
          projections: { urban_open_user_tasks: [{ process_instance_key: "pi-9" }] },
        },
      ]),
    );
  });
});

test("(iii) the parity guard FAILS when a deliberately-mutated AST makes the backends diverge", async () => {
  // A drifted model: the SQL backend stays the real declaration, but the TS backend is compiled from
  // a MUTATED AST (the display_status CASE with its comparison flipped `eq` → `neq`). This is exactly
  // the surface-#2 drift the guard exists to catch — the two would silently diverge without it.
  const mutatedDisplayStatus = caseWhen(
    [
      when(neq(col("state"), lit("done")), lit("completed")), // ← flipped from eq
      when(
        exists("urban_open_user_tasks", eq(pcol("process_instance_key"), col("process_instance_key"))),
        lit("awaiting_operator"),
      ),
    ],
    lit("active"),
  );
  const drifted: ReadModel = {
    ...taskReadModel,
    fnFor: (column) =>
      column === "display_status" ? compileToFn(mutatedDisplayStatus) : taskReadModel.fnFor(column),
  };

  await withDb((db) => {
    assert.throws(
      () =>
        assertReadModelParity(drifted, db, [
          { baseRow: { process_instance_key: "pi-1", state: "done", priority: 9 }, projections: {} },
        ]),
      /parity mismatch in "tasks_display"\.display_status/,
    );
  });
});

test("compileToSqlSelect emits a closed, injection-free SQL expression for CASE + EXISTS", () => {
  const sql = taskReadModel.sqlSelectFor("display_status");
  assert.match(sql, /^CASE WHEN/);
  assert.match(sql, /EXISTS \(SELECT 1 FROM "urban_open_user_tasks" WHERE/);
  assert.match(sql, /"base"\."state" = 'done'/);
});

test("compileToFn / compileToSqlSelect are driven from the same AST (single-declaration guarantee)", () => {
  const expr = and(eq(col("a"), lit(1)), gt(col("b"), lit(2)));
  const fn = compileToFn(expr);
  assert.equal(fn({ a: 1, b: 5 }), true);
  assert.equal(fn({ a: 1, b: 2 }), false);
  assert.equal(fn({ a: 0, b: 5 }), false);
  assert.equal(compileToSqlSelect(expr), `(("base"."a" = 1) AND ("base"."b" > 2))`);
});

test("EXISTS references a projection by name; the projection registry resolves the physical table", () => {
  const reg = new ProjectionRegistry();
  reg.register({ name: "urban_instance_state", sqlTable: "_urban_instance_state" });
  const sql = compileToSqlSelect(exists("urban_instance_state", eq(pcol("k"), col("k"))), {
    resolveProjectionTable: (n) => reg.sqlTableFor(n),
  });
  assert.match(sql, /FROM "_urban_instance_state" WHERE/);
  // An unregistered name falls back to itself, so a read model compiles before its sidecar lands.
  assert.equal(reg.sqlTableFor("not_yet_landed"), "not_yet_landed");
});

test("the process-wide projectionRegistry is idempotent and rejects a conflicting redefinition", () => {
  projectionRegistry.register({ name: "urban_open_user_tasks" });
  // Same registration is a no-op.
  assert.doesNotThrow(() => projectionRegistry.register({ name: "urban_open_user_tasks" }));
  assert.ok(projectionRegistry.has("urban_open_user_tasks"));
  assert.throws(
    () => projectionRegistry.register({ name: "urban_open_user_tasks", sqlTable: "something_else" }),
    /already registered/,
  );
});

test("the read-model registry provisions every managed VIEW and rejects a conflicting redefinition", async () => {
  await withDb((db) => {
    const reg = new ReadModelRegistry();
    reg.register(taskReadModel);
    reg.register(taskReadModel); // idempotent
    // A conflicting redefinition under the same name throws.
    const conflicting = defineReadModel({
      name: "tasks_display",
      baseTable: "tasks",
      derive: { display_status: lit("x") },
    });
    assert.throws(() => reg.register(conflicting), /different definition/);

    db.exec(`CREATE TABLE tasks (id TEXT, process_instance_key TEXT, state TEXT, priority INTEGER);`);
    db.exec(`CREATE TABLE urban_open_user_tasks (process_instance_key TEXT);`);
    reg.ensureViews(db);
    reg.ensureViews(db); // drop-and-recreate → safe to re-run
    db.run(`INSERT INTO tasks VALUES (?, ?, ?, ?)`, ["t1", "pi-1", "done", 9]);
    const row = db.all<{ display_status: string }>(`SELECT display_status FROM tasks_display`)[0];
    assert.equal(row.display_status, "completed");
  });
});

test("eq/neq coerce booleans like SQLite (1/0) so the TS backend cannot drift from the VIEW", () => {
  // `lit(true)` compiles to SQL `1`; strict `===` would make `1 === true` false and diverge.
  const on = compileToFn(eq(col("flag"), lit(true)));
  assert.equal(on({ flag: 1 }), true);
  assert.equal(on({ flag: 0 }), false);
  const off = compileToFn(neq(col("flag"), lit(true)));
  assert.equal(off({ flag: 1 }), false);
  assert.equal(off({ flag: 0 }), true);
});

test("eq/neq compare bigint INTEGERs numerically so the TS backend cannot drift from the VIEW", () => {
  // A 64-bit key can reach the TS backend as a `bigint`; it must equal the SQL literal `1`, not the
  // string "1" — stringifying via `orderable` would make `1n === 1` false and drift from the VIEW.
  const on = compileToFn(eq(col("k"), lit(1)));
  assert.equal(on({ k: 1n }), true);
  assert.equal(on({ k: 2n }), false);
  const off = compileToFn(neq(col("k"), lit(1)));
  assert.equal(off({ k: 1n }), false);
  assert.equal(off({ k: 2n }), true);
});

test("eq/neq/gt compare 64-bit bigint keys EXACTLY so distinct keys past 2^53 don't collapse", () => {
  // Number(9007199254740993n) === Number(9007199254740992n) → both round to 9007199254740992, so
  // truncating a 64-bit key through Number() would make two DISTINCT keys compare equal and drift from
  // the SQL VIEW. The TS backend must compare the bigints exactly.
  const big = 9007199254740993n; // 2^53 + 1 — NOT representable as a JS number
  const twoP53 = 9007199254740992n; // 2^53 — Number() maps `big` onto this
  const same = compileToFn(eq(col("a"), col("b")));
  assert.equal(same({ a: big, b: big }), true, "a 64-bit key equals itself exactly");
  assert.equal(same({ a: big, b: twoP53 }), false, "keys differing only past 2^53 must NOT be equal");
  const different = compileToFn(neq(col("a"), col("b")));
  assert.equal(different({ a: big, b: twoP53 }), true, "distinct 64-bit keys are unequal");
  const greater = compileToFn(gt(col("a"), col("b")));
  assert.equal(greater({ a: big, b: twoP53 }), true, "2^53+1 > 2^53 holds without truncation");
});

test("CASE-WHEN coerces string conditions numerically like SQLite ('0'/'abc' false, '2abc' true)", async () => {
  // SQLite evaluates a string in a boolean context by its leading numeric prefix, so a non-boolean
  // column flowing into a CASE condition must coerce identically in TS or the two backends diverge.
  const model = defineReadModel({
    name: "flagword_read_model",
    baseTable: "flagword_rows",
    derive: { label: caseWhen([when(col("word"), lit("truthy"))], lit("falsy")) },
  });
  await withDb((db) => {
    assert.doesNotThrow(() =>
      assertReadModelParity(model, db, [
        { baseRow: { word: "0" } },
        { baseRow: { word: "abc" } },
        { baseRow: { word: "2abc" } },
        { baseRow: { word: "1" } },
        { baseRow: { word: "" } },
      ]),
    );
  });
});

test("the parity guard PASSES for a boolean-equality derived column across both backends", async () => {
  const model = defineReadModel({
    name: "flags_read_model",
    baseTable: "flag_rows",
    derive: { is_on: eq(col("flag"), lit(true)) },
  });
  await withDb((db) => {
    assert.doesNotThrow(() =>
      assertReadModelParity(model, db, [{ baseRow: { flag: 1 } }, { baseRow: { flag: 0 } }]),
    );
  });
});

test("ensureViews replaces a stale VIEW body (managed provisioning, not IF NOT EXISTS)", async () => {
  await withDb((db) => {
    db.exec(`CREATE TABLE tasks (id TEXT, process_instance_key TEXT, state TEXT, priority INTEGER);`);
    db.exec(`CREATE TABLE urban_open_user_tasks (process_instance_key TEXT);`);
    // A stale VIEW from an older definition already exists under the managed name.
    db.exec(`CREATE VIEW tasks_display AS SELECT 'stale' AS display_status;`);
    const reg = new ReadModelRegistry();
    reg.register(taskReadModel);
    reg.ensureViews(db);
    db.run(`INSERT INTO tasks VALUES (?, ?, ?, ?)`, ["t1", "pi-1", "done", 9]);
    const row = db.all<{ display_status: string }>(`SELECT display_status FROM tasks_display`)[0];
    assert.equal(row.display_status, "completed"); // stale body was dropped and replaced
  });
});

test("the parity guard rejects an unknown column with an actionable error", async () => {
  await withDb((db) => {
    assert.throws(
      () =>
        assertReadModelParity(
          taskReadModel,
          db,
          [{ baseRow: { process_instance_key: "pi-1", state: "done", priority: 9 } }],
          { columns: ["not_a_column"] },
        ),
      /no derived column "not_a_column"/,
    );
  });
});

test("the parity guard rejects two projections mapped to one physical table with an actionable error", async () => {
  // A mapping bug: two DSL projection names resolving to ONE physical table would make the guard
  // CREATE (then drop/insert) that table twice and fail for a non-parity reason. It must reject up
  // front with an actionable error (idempotent registrations, so safe to re-run).
  projectionRegistry.register({ name: "dup_proj_a", sqlTable: "dup_shared_table" });
  projectionRegistry.register({ name: "dup_proj_b", sqlTable: "dup_shared_table" });
  const model = defineReadModel({
    name: "dup_table_read_model",
    baseTable: "dup_rows",
    derive: {
      label: caseWhen(
        [
          when(exists("dup_proj_a", eq(pcol("k"), col("k"))), lit("a")),
          when(exists("dup_proj_b", eq(pcol("k"), col("k"))), lit("b")),
        ],
        lit("none"),
      ),
    },
  });
  await withDb((db) => {
    assert.throws(
      () => assertReadModelParity(model, db, [{ baseRow: { k: "x" } }]),
      /maps projections "dup_proj_a" and "dup_proj_b" to the same physical table "dup_shared_table"/,
    );
  });
});

test("the parity guard ignores projections the model does not reference", async () => {
  await withDb((db) => {
    assert.doesNotThrow(() =>
      assertReadModelParity(taskReadModel, db, [
        {
          baseRow: { process_instance_key: "pi-1", state: "done", priority: 9 },
          projections: { urban_open_user_tasks: [], unrelated_projection: [{ foo: "bar" }] },
        },
      ]),
    );
  });
});

test("the parity guard materialises a keyless sample row (DEFAULT VALUES, not skipped)", async () => {
  // A constant-derived model referencing no base columns: a `{ baseRow: {} }` sample must still
  // produce one VIEW row, else SQL returns 0 rows (undefined) while the TS fn returns the constant.
  const model = defineReadModel({
    name: "constant_read_model",
    baseTable: "constant_rows",
    derive: { label: lit("active") },
  });
  await withDb((db) => {
    assert.doesNotThrow(() => assertReadModelParity(model, db, [{ baseRow: {} }]));
  });
});

test("an invalid SQL identifier is rejected at declaration time (injection guard)", () => {
  assert.throws(() => defineReadModel({ name: "bad name", baseTable: "t", derive: { c: lit(1) } }), /invalid/);
  assert.throws(() => defineReadModel({ name: "ok", baseTable: "t; DROP TABLE x", derive: { c: lit(1) } }), /invalid/);
});
