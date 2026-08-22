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
    reg.ensureViews(db); // IF NOT EXISTS → safe to re-run
    db.run(`INSERT INTO tasks VALUES (?, ?, ?, ?)`, ["t1", "pi-1", "done", 9]);
    const row = db.all<{ display_status: string }>(`SELECT display_status FROM tasks_display`)[0];
    assert.equal(row.display_status, "completed");
  });
});

test("an invalid SQL identifier is rejected at declaration time (injection guard)", () => {
  assert.throws(() => defineReadModel({ name: "bad name", baseTable: "t", derive: { c: lit(1) } }), /invalid/);
  assert.throws(() => defineReadModel({ name: "ok", baseTable: "t; DROP TABLE x", derive: { c: lit(1) } }), /invalid/);
});
