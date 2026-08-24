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
  lt,
  neq,
  not,
  or,
  pcol,
  ProjectionRegistry,
  projectionRegistry,
  rcol,
  ReadModelRegistry,
  isReservedObjectName,
  RESERVED_OBJECT_PREFIXES,
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

test("isReservedObjectName flags every reserved prefix, case-insensitively, and clears domain names", () => {
  // Single source of truth for the prefixes the datasource surface hides (gateway.schema()) and the
  // provenance recorder skips (datasource.ts). SQLite folds ASCII object names, so a cased reserved
  // name must not slip through.
  assert.deepEqual([...RESERVED_OBJECT_PREFIXES], ["_urban_", "_nano_", "sqlite_"]);
  for (const name of ["_urban_x", "_URBAN_x", "_nano_y", "sqlite_master", "SQLITE_stat1"]) {
    assert.ok(isReservedObjectName(name), `expected "${name}" reserved`);
  }
  for (const name of ["orders", "plans__tracking", "urban_things", "nano", "sqlitely"]) {
    assert.ok(!isReservedObjectName(name), `expected "${name}" NOT reserved`);
  }
});

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
  assert.match(sql, /EXISTS \(SELECT 1 FROM "urban_open_user_tasks" AS "__urban_proj_0" WHERE/);
  assert.match(sql, /"base"\."state" = 'done'/);
});

test("compileToFn / compileToSqlSelect are driven from the same AST (single-declaration guarantee)", () => {
  const expr = and(eq(col("a"), lit(1)), gt(col("b"), lit(2)));
  const fn = compileToFn(expr);
  assert.equal(fn({ a: 1, b: 5 }), true);
  assert.equal(fn({ a: 1, b: 2 }), false);
  assert.equal(fn({ a: 0, b: 5 }), false);
  // Comparisons and the AND are COALESCE'd to 0 so a NULL operand can't make SQL yield NULL where the
  // TS backend yields false (see the NULL-parity test below); the AST is still the single source.
  assert.equal(
    compileToSqlSelect(expr),
    `COALESCE((COALESCE(("base"."a" = 1), 0) AND COALESCE(("base"."b" > 2), 0)), 0)`,
  );
});

test("both backends agree on NULL inputs: SQL NULL propagation is COALESCE'd to the TS 'NULL → false' rule", async () => {
  // SQLite propagates NULL through comparisons and AND/OR/NOT (`a = NULL` → NULL, `NOT NULL` → NULL),
  // but the TS backend collapses any nullish operand to false (compareValues/truthy). Without the
  // COALESCE guards in compileToSqlSelect the two backends would silently diverge on a NULL base value.
  const model = defineReadModel({
    name: "null_parity_read_model",
    baseTable: "null_rows",
    derive: {
      eq_is_true: eq(col("a"), lit(1)),
      neq_is_true: neq(col("a"), lit(1)),
      and_is_true: and(eq(col("a"), lit(1)), gt(col("b"), lit(2))),
      or_is_true: or(eq(col("a"), lit(1)), gt(col("b"), lit(2))),
      not_is_true: not(eq(col("a"), lit(1))),
    },
  });
  await withDb((db) => {
    assert.doesNotThrow(() =>
      assertReadModelParity(model, db, [
        { baseRow: { a: null, b: null } },
        { baseRow: { a: null, b: 5 } },
        { baseRow: { a: 1, b: null } },
        { baseRow: { a: 1, b: 5 } },
        { baseRow: { a: 2, b: 1 } },
      ]),
    );
  });
});

test("compileToFn resolves col/pcol identifiers case-insensitively (SQLite identifier folding)", () => {
  // SQLite folds identifier case even for quoted identifiers, so `col("Status")` in the VIEW binds to a
  // column DECLARED `status`. The TS backend must fold too — a case-sensitive `row["Status"]` returns
  // null and silently diverges from the VIEW on the no-edge fallback and on keyField correlation.
  assert.equal(compileToFn(col("Status"))({ status: "abandoned" }), "abandoned"); // folds to declared column
  assert.equal(compileToFn(col("status"))({ status: "abandoned" }), "abandoned"); // exact match still works
  assert.equal(compileToFn(col("Missing"))({ status: "x" }), null); // a truly-absent column → null (not a fold)
  // pcol inside EXISTS folds too, so keyField correlation matches the VIEW's join.
  const corr = compileToFn(exists("p", eq(pcol("Process_Instance_Key"), col("Key"))));
  assert.equal(corr({ key: "pi-1" }, { p: [{ process_instance_key: "pi-1" }] }), true);
  assert.equal(corr({ key: "pi-1" }, { p: [{ process_instance_key: "pi-2" }] }), false);
});

test("compileToFn / rcol reads the resolved lookup row by OWN property (a `__proto__` alias can't resolve Object.prototype)", () => {
  // Lookup aliases are only identifier-validated, so `__proto__` is a legal alias. A bare `fnFor` caller
  // supplies a plain `{}` for `lookups`; a raw `lookups["__proto__"]` resolves the inherited
  // `Object.prototype` (truthy), bypassing the "missing lookup row → throw" guard and reading NULLs off the
  // prototype chain. Reading by OWN property keeps the guard fail-loud on the bare-caller path.
  const fn = compileToFn(rcol("__proto__", "amount"));
  assert.throws(() => fn({}), /without a resolved lookup row/);
  // A genuinely-supplied own `__proto__` row still resolves (null-prototype dict, an own property).
  const lookups: Record<string, Record<string, unknown>> = Object.create(null);
  lookups.__proto__ = { amount: 7 };
  assert.equal(fn({}, {}, lookups), 7);
});

test("compileToFn / exists reads projections by OWN property (a `__proto__` projection can't resolve Object.prototype)", () => {
  // Projection names are user-controlled, so `__proto__` is legal. A bare `fnFor` caller passes a plain
  // `{}` for projections; a raw `projections["__proto__"]` resolves the inherited `Object.prototype`
  // (truthy, non-array), so `.some(...)` throws a TypeError. Reading by OWN property yields an empty EXISTS.
  const fn = compileToFn(exists("__proto__", eq(col("k"), lit(1))));
  assert.equal(fn({ k: 1 }), false); // no such projection → empty EXISTS, not a prototype read
  // A genuinely-supplied own `__proto__` projection still matches.
  const projections: Record<string, ReadonlyArray<Record<string, unknown>>> = Object.create(null);
  projections.__proto__ = [{ k: 1 }];
  assert.equal(fn({ k: 1 }, projections), true);
});

test("mixed-case col/pcol identifiers: the VIEW and TS backends agree (VIEW/TS parity on the no-edge fallback)", async () => {  // End-to-end guard for the case-fold fix: author a model with mixed-case identifiers over lowercase
  // columns and confirm the SQLite VIEW and the TS backend derive the SAME value — including the
  // parity-critical no-edge fallback that passes the stored status through.
  const mixed: ReadModel = defineReadModel({
    name: "mixed_case_display",
    baseTable: "widgets",
    derive: {
      effective: caseWhen(
        [
          when(
            exists("urban_open_user_tasks", eq(pcol("Process_Instance_Key"), col("Process_Key"))),
            lit("awaiting_operator"),
          ),
        ],
        col("Status"), // no-edge fallback → the stored status, read via a mixed-case identifier
      ),
    },
  });
  await withDb((db) => {
    db.exec(`CREATE TABLE widgets (id TEXT, process_key TEXT, status TEXT);`);
    db.exec(`CREATE TABLE urban_open_user_tasks (process_instance_key TEXT);`);
    db.exec(mixed.viewDdl());
    db.run(`INSERT INTO widgets VALUES (?, ?, ?)`, ["w1", "pi-1", "dispatched"]); // no open task → fallback
    db.run(`INSERT INTO widgets VALUES (?, ?, ?)`, ["w2", "pi-2", "dispatched"]);
    db.run(`INSERT INTO urban_open_user_tasks VALUES (?)`, ["pi-2"]); // w2 waiting on a human
    // SQL backend: the VIEW resolves the mixed-case identifiers against the lowercase columns.
    const sqlRows = db
      .all<{ id: string; effective: string }>(`SELECT id, effective FROM mixed_case_display ORDER BY id`)
      .map((r) => ({ ...r }));
    assert.deepEqual(sqlRows, [
      { id: "w1", effective: "dispatched" }, // no-edge fallback → stored status (the parity-critical path)
      { id: "w2", effective: "awaiting_operator" },
    ]);
    // TS backend: base/projection rows arrive keyed as SQLite stored them (lowercase).
    const projections = { urban_open_user_tasks: [{ process_instance_key: "pi-2" }] };
    assert.equal(mixed.evaluate({ id: "w1", process_key: "pi-1", status: "dispatched" }, projections).effective, "dispatched");
    assert.equal(mixed.evaluate({ id: "w2", process_key: "pi-2", status: "dispatched" }, projections).effective, "awaiting_operator");
  });
});

test("EXISTS references a projection by name; the projection registry resolves the physical table", () => {
  const reg = new ProjectionRegistry();
  reg.register({ name: "urban_instance_state", sqlTable: "_urban_instance_state" });
  const sql = compileToSqlSelect(exists("urban_instance_state", eq(pcol("k"), col("k"))), {
    resolveProjectionTable: (n) => reg.sqlTableFor(n),
  });
  assert.match(sql, /FROM "_urban_instance_state" AS "__urban_proj_0" WHERE/);
  // An unregistered name falls back to itself, so a read model compiles before its sidecar lands.
  assert.equal(reg.sqlTableFor("not_yet_landed"), "not_yet_landed");
});

test("EXISTS aliases the projection relation distinctly from the base alias so col(...) correlates to the OUTER base row", () => {
  // A projection whose PHYSICAL table equals the base alias must not shadow the outer base row inside
  // the sub-select: the projection relation gets a reserved alias, pcol binds to it, and col still binds
  // to the outer base alias — otherwise `col(...)` would silently bind to the inner projection row.
  const sql = compileToSqlSelect(exists("p", eq(pcol("k"), col("k"))), {
    baseAlias: "base",
    resolveProjectionTable: () => "base", // physical projection table collides with the base alias
  });
  assert.match(sql, /FROM "base" AS "__urban_proj_0" WHERE COALESCE\(\("__urban_proj_0"\."k" = "base"\."k"\), 0\)/);

  // If the base alias IS the reserved alias itself, the projection alias is prefixed further so the two
  // stay distinct — the derivation is collision-free for any base alias.
  const collide = compileToSqlSelect(exists("p", eq(pcol("k"), col("k"))), {
    baseAlias: "__urban_proj_0",
    resolveProjectionTable: () => "__urban_proj_0",
  });
  assert.match(collide, /FROM "__urban_proj_0" AS "___urban_proj_0" WHERE COALESCE\(\("___urban_proj_0"\."k" = "__urban_proj_0"\."k"\), 0\)/);
});

test("projection alias avoids a base alias that collides only by case (SQLite idents are case-insensitive)", () => {
  // SQLite compares identifiers case-insensitively, so "__URBAN_PROJ_0" and "__urban_proj_0" are the
  // SAME relation. The reserved projection alias must still be prefixed away from such a base alias,
  // or `col(...)` inside EXISTS would correlate to the projection row instead of the outer base row.
  const collide = compileToSqlSelect(exists("p", eq(pcol("k"), col("k"))), {
    baseAlias: "__URBAN_PROJ_0",
    resolveProjectionTable: () => "p",
  });
  assert.match(collide, /FROM "p" AS "___urban_proj_0" WHERE COALESCE\(\("___urban_proj_0"\."k" = "__URBAN_PROJ_0"\."k"\), 0\)/);
});

test("a base alias that is not a SQL identifier is rejected at compile time", () => {
  assert.throws(
    () => compileToSqlSelect(col("k"), { baseAlias: 'evil"; DROP TABLE t; --' }),
    /invalid base alias/,
  );
});

test("nested EXISTS bind each pcol(...) to its own projection via depth-indexed aliases", () => {
  const sql = compileToSqlSelect(
    exists("outer", and(eq(pcol("ok"), col("bk")), exists("inner", eq(pcol("ik"), col("bk"))))),
  );
  // The outer projection is __urban_proj_0, the nested one __urban_proj_1 — so the inner pcol cannot
  // shadow the outer projection's row.
  assert.match(sql, /FROM "outer" AS "__urban_proj_0" WHERE/);
  assert.match(sql, /FROM "inner" AS "__urban_proj_1" WHERE COALESCE\(\("__urban_proj_1"\."ik" = "base"\."bk"\), 0\)/);
  assert.match(sql, /"__urban_proj_0"\."ok" = "base"\."bk"/);
});

test("the parity guard threads custom SQL options (resolver + VIEW) and keeps EXISTS correlation when the projection table equals the base alias", async () => {
  // End-to-end: the guard must (a) resolve the projection NAME through options.sql.resolveProjectionTable,
  // (b) materialise the VIEW with those same options, and (c) alias the EXISTS relation so a projection
  // physically named like the base alias still correlates — all three together keep the backends in parity.
  const model = defineReadModel({
    name: "collide_alias_read_model",
    baseTable: "rows",
    derive: {
      has_match: caseWhen([when(exists("p", eq(pcol("bk"), col("bk"))), lit(1))], lit(0)),
    },
  });
  const sql = { resolveProjectionTable: (n: string) => (n === "p" ? "base" : n) };
  await withDb((db) => {
    assert.doesNotThrow(() =>
      assertReadModelParity(
        model,
        db,
        [
          { baseRow: { bk: "x" }, projections: { p: [{ bk: "x" }] } },
          { baseRow: { bk: "y" }, projections: { p: [{ bk: "x" }] } },
        ],
        { sql },
      ),
    );
  });
});

test("the parity guard resolves projection tables through options.sql and validates them like the SQL compiler", async () => {
  // The guard must consult options.sql.resolveProjectionTable and apply the SAME identifier validation the
  // SQL compiler uses — so a resolver returning an invalid table name is rejected up front, not silently
  // ignored (which would build fixtures against a different physical table than the runtime VIEW).
  const model = defineReadModel({
    name: "bad_resolver_read_model",
    baseTable: "rows",
    derive: {
      has_match: caseWhen([when(exists("p", eq(pcol("k"), col("k"))), lit(1))], lit(0)),
    },
  });
  await withDb((db) => {
    assert.throws(
      () =>
        assertReadModelParity(model, db, [{ baseRow: { k: "x" }, projections: { p: [{ k: "x" }] } }], {
          sql: { resolveProjectionTable: () => "bad table" },
        }),
      /invalid projection table "bad table"/,
    );
  });
});

test("the parity guard rejects a projection resolving to the base table's physical name (would collide with the base fixture)", async () => {
  // A projection that resolves to the SAME physical table as the base table would make the guard build
  // (and later drop/insert) one fixture table twice — once as the base, once as the projection — failing
  // with a confusing SQLite "table already exists" error. The guard must reject it up front with an
  // actionable message, mirroring the many-to-one projection-table check.
  const model = defineReadModel({
    name: "base_collision_read_model",
    baseTable: "rows",
    derive: {
      has_match: caseWhen([when(exists("p", eq(pcol("k"), col("k"))), lit(1))], lit(0)),
    },
  });
  await withDb((db) => {
    assert.throws(
      () =>
        assertReadModelParity(model, db, [{ baseRow: { k: "x" }, projections: { p: [{ k: "x" }] } }], {
          sql: { resolveProjectionTable: () => "rows" },
        }),
      /maps projection "p" to its base table "rows"/,
    );
  });
});

test("the parity guard rejects a projection whose physical name matches the base table only by case", async () => {
  // SQLite folds identifiers, so a projection resolving to "ROWS" is the SAME physical table as the base
  // "rows" and would make the guard build one fixture twice. The case-fold in the guard must catch it.
  const model = defineReadModel({
    name: "base_case_collision_read_model",
    baseTable: "rows",
    derive: {
      has_match: caseWhen([when(exists("p", eq(pcol("k"), col("k"))), lit(1))], lit(0)),
    },
  });
  await withDb((db) => {
    assert.throws(
      () =>
        assertReadModelParity(model, db, [{ baseRow: { k: "x" }, projections: { p: [{ k: "x" }] } }], {
          sql: { resolveProjectionTable: () => "ROWS" },
        }),
      /maps projection "p" to its base table "rows"/,
    );
  });
});

test("the process-wide projectionRegistry is idempotent and rejects a conflicting redefinition", () => {
  try {
    projectionRegistry.register({ name: "urban_open_user_tasks" });
    // Same registration is a no-op.
    assert.doesNotThrow(() => projectionRegistry.register({ name: "urban_open_user_tasks" }));
    assert.ok(projectionRegistry.has("urban_open_user_tasks"));
    assert.throws(
      () => projectionRegistry.register({ name: "urban_open_user_tasks", sqlTable: "something_else" }),
      /already registered/,
    );
  } finally {
    // Reset the process-wide singleton so this test cannot leak registrations into others.
    projectionRegistry.clear();
  }
});

test("projectionRegistry.clear() resets all registrations for deterministic test isolation", () => {
  try {
    projectionRegistry.register({ name: "proj_clear_a", sqlTable: "tbl_a" });
    projectionRegistry.register({ name: "proj_clear_b", sqlTable: "tbl_b" });
    assert.ok(projectionRegistry.has("proj_clear_a"));
    assert.ok(projectionRegistry.has("proj_clear_b"));

    projectionRegistry.clear();

    assert.equal(projectionRegistry.has("proj_clear_a"), false);
    assert.equal(projectionRegistry.has("proj_clear_b"), false);
    assert.deepEqual(projectionRegistry.names(), []);
    // Falls back to the name itself once cleared (same as an unregistered name).
    assert.equal(projectionRegistry.sqlTableFor("proj_clear_a"), "proj_clear_a");
    // Cleared registry accepts a fresh, previously-conflicting registration.
    assert.doesNotThrow(() => projectionRegistry.register({ name: "proj_clear_a", sqlTable: "tbl_different" }));
  } finally {
    projectionRegistry.clear();
  }
});

test("defineReadModel rejects a read model whose name equals its base table (SQLite forbids a VIEW and table sharing a name)", () => {
  // SQLite cannot hold a VIEW and a table under one name, so provisioning such a read model would fail
  // opaquely with a raw SQL error at `ensureViews`. Reject it at declaration time with an actionable one.
  assert.throws(
    () =>
      defineReadModel({
        name: "shared_name",
        baseTable: "shared_name",
        derive: { c: col("x") },
      }),
    /cannot share its name with its base table "shared_name"/,
  );
});

test("defineReadModel rejects a name/base-table collision that differs only in case (SQLite folds identifiers)", () => {
  // SQLite matches identifiers case-insensitively, so a VIEW named "TASKS" still collides with a table
  // "tasks". The declaration-time guard must case-fold or the collision would slip through to opaque
  // failure at `ensureViews`.
  assert.throws(
    () =>
      defineReadModel({
        name: "TASKS",
        baseTable: "tasks",
        derive: { c: col("x") },
      }),
    /cannot share its name with its base table "tasks"/,
  );
});

test("ProjectionRegistry rejects two projection names that collide only under SQLite case-folding", () => {
  // SQLite matches identifiers case-insensitively, so "Foo" and "foo" denote ONE physical relation.
  // Keying the registry by exact name would let both register as distinct entries and silently alias;
  // the dedup key must fold, mirroring every other identity check in this module.
  const reg = new ProjectionRegistry();
  reg.register({ name: "Foo", sqlTable: "foo_table" });
  assert.throws(
    () => reg.register({ name: "foo", sqlTable: "foo_table" }),
    /already registered as "Foo"/,
  );
  // Lookups fold too: a case-variant name resolves to the registered physical table.
  assert.equal(reg.sqlTableFor("FOO"), "foo_table");
  assert.ok(reg.has("fOo"));
  // Exact re-registration stays an idempotent no-op.
  assert.doesNotThrow(() => reg.register({ name: "Foo", sqlTable: "foo_table" }));
});

test("ReadModelRegistry rejects two read-model names that collide only under SQLite case-folding", () => {
  // SQLite folds VIEW names, so "TASKS" and "tasks" would collide at `ensureViews`. The registry must
  // reject the case-only collision at registration time rather than letting drop/create race opaquely.
  const upper = defineReadModel({ name: "MODELCASE", baseTable: "rows", derive: { c: col("x") } });
  const lower = defineReadModel({ name: "modelcase", baseTable: "rows", derive: { c: col("x") } });
  const reg = new ReadModelRegistry();
  reg.register(upper);
  assert.throws(() => reg.register(lower), /already registered as "MODELCASE"/);
  // A case-variant lookup resolves to the registered model.
  assert.equal(reg.get("ModelCase"), upper);
});

test("evaluate() writes derived columns as own properties on a null-prototype bag (no prototype pollution via a `__proto__` column)", () => {
  // Derived column names are user-controlled and only identifier-validated, so `__proto__` is a legal
  // name. On a plain `{}` bag, `out["__proto__"] = <value>` trips `Object.prototype`'s magic accessor
  // instead of creating an own property; a null-prototype bag makes every name a safe own key. The
  // computed key here defines a real own `__proto__` property on `derive` (a literal key would set the
  // prototype instead).
  const model = defineReadModel({
    name: "proto_pollution_read_model",
    baseTable: "tasks",
    derive: { ["__proto__"]: col("x") },
  });
  const out = model.evaluate({ x: 42 }, {});
  assert.equal(Object.getPrototypeOf(out), null, "output bag must have a null prototype");
  assert.equal(out["__proto__"], 42, "the `__proto__` column must be stored as a real own property");
  const probe: Record<string, unknown> = {};
  assert.equal(probe["polluted"], undefined, "evaluate() must not pollute Object.prototype");
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

test("the read-model registry treats declarations that differ only in derive key order as identical", () => {
  // The registry compares viewDdl() strings for idempotency; column order must be canonicalised (sorted)
  // so two equivalent declarations don't get flagged as a conflicting redefinition (advisory :599).
  const forward = defineReadModel({
    name: "order_read_model",
    baseTable: "order_rows",
    derive: { alpha: gt(col("a"), lit(1)), beta: gt(col("b"), lit(2)) },
  });
  const reversed = defineReadModel({
    name: "order_read_model",
    baseTable: "order_rows",
    derive: { beta: gt(col("b"), lit(2)), alpha: gt(col("a"), lit(1)) },
  });
  assert.equal(forward.viewDdl(), reversed.viewDdl(), "key insertion order must not change the VIEW DDL");
  const reg = new ReadModelRegistry();
  reg.register(forward);
  assert.doesNotThrow(() => reg.register(reversed), "reordered-but-equivalent redefinition is a no-op");
});

test("compareOrderable orders a 64-bit numeric key BEFORE a numeric-looking TEXT value without truncation", () => {
  // A 64-bit key reaching the TS backend as `bigint`, compared to a TEXT literal, must follow SQLite's
  // storage-class ordering (INTEGER/REAL < TEXT) — the numeric value is "less", never equal — WITHOUT
  // coercing the bigint through Number() (which would collapse distinct keys). See advisory on line 409.
  const big = 9007199254740993n; // 2^53 + 1 — not representable as a JS number
  const twoP53 = 9007199254740992n; // 2^53 — Number() maps `big` onto this
  const text = "9007199254740992";
  // A numeric key is never equal to a text value, even one that "looks like" the same integer.
  assert.equal(compileToFn(eq(col("k"), lit(text)))({ k: big }), false);
  assert.equal(compileToFn(eq(col("k"), lit(text)))({ k: twoP53 }), false);
  assert.equal(compileToFn(neq(col("k"), lit(text)))({ k: big }), true);
  // The numeric key sorts BEFORE the text value (lt true, gt false) — a definite ordering, not NaN.
  assert.equal(compileToFn(lt(col("k"), lit(text)))({ k: big }), true);
  assert.equal(compileToFn(gt(col("k"), lit(text)))({ k: big }), false);
  // Symmetric: the TEXT value sorts AFTER the numeric key (text > numeric).
  assert.equal(compileToFn(gt(lit(text), col("k")))({ k: big }), true);
  // Distinct 64-bit keys must not collapse when both are compared to the same text value.
  assert.equal(compileToFn(lt(col("k"), lit(text)))({ k: twoP53 }), true);
});

test("the parity guard agrees with the SQL VIEW for a numeric key compared to a TEXT literal", async () => {
  // End-to-end: the managed VIEW compares an (untyped) numeric column to a numeric-looking text literal
  // by storage class, and the TS backend must match — including for 64-bit keys past 2^53.
  const model = defineReadModel({
    name: "keytext_read_model",
    baseTable: "keytext_rows",
    derive: {
      eq_text: eq(col("k"), lit("9007199254740992")),
      lt_text: lt(col("k"), lit("9007199254740992")),
      gt_text: gt(col("k"), lit("9007199254740992")),
    },
  });
  await withDb((db) => {
    assert.doesNotThrow(() =>
      assertReadModelParity(model, db, [
        { baseRow: { k: 9007199254740993n } },
        { baseRow: { k: 9007199254740992n } },
        { baseRow: { k: 5n } },
      ]),
    );
  });
});


test("the parity guard reports a mismatch (not a bigint serialisation TypeError) when a divergent value is a bigint", async () => {
  // A derived INTEGER > 2^53 can reach the mismatch formatter as a `bigint`. `JSON.stringify` throws
  // a TypeError on bigint, which would mask the real parity failure — the guard must still name the
  // mismatch. Drift the TS backend so it returns a bigint the SQL VIEW does not, then assert the
  // thrown error is the parity mismatch (mentioning the bigint value), not a TypeError.
  const model = defineReadModel({
    name: "bigint_mismatch_read_model",
    baseTable: "bigint_mismatch_rows",
    derive: {
      key: col("k"),
    },
  });
  const drifted: ReadModel = {
    ...model,
    fnFor: (column) => (column === "key" ? () => 9007199254740993n : model.fnFor(column)),
  };
  await withDb((db) => {
    assert.throws(
      () => assertReadModelParity(drifted, db, [{ baseRow: { k: 1 } }]),
      /parity mismatch in "bigint_mismatch_read_model"\.key.*TS=9007199254740993n/,
    );
  });
});

test("the parity guard treats a lossless bigint and its number equal (parity) but keeps a bigint past 2^53 exact (mismatch)", async () => {
  // A SQLite INTEGER can surface as `number` on the SQL side and `bigint` on the TS side (or vice
  // versa) depending on the driver — the guard compares with `Object.is`, so `1` vs `1n` would be a
  // SPURIOUS mismatch. normaliseSqlValue collapses a LOSSLESS bigint to number so identical integers
  // are parity; a bigint past 2^53 stays EXACT so a genuine divergence is never masked.
  const model = defineReadModel({
    name: "bigint_norm_read_model",
    baseTable: "bigint_norm_rows",
    derive: { key: col("k") },
  });
  // baseRow { k: 1 } → the SQL VIEW yields the number 1.
  const losslessDrift: ReadModel = {
    ...model,
    fnFor: (column) => (column === "key" ? () => 1n : model.fnFor(column)),
  };
  const exactDrift: ReadModel = {
    ...model,
    fnFor: (column) => (column === "key" ? () => 9007199254740993n : model.fnFor(column)),
  };
  await withDb((db) => {
    // 1n (TS) vs 1 (SQL) is parity — the lossless bigint normalises to number.
    assert.doesNotThrow(() => assertReadModelParity(losslessDrift, db, [{ baseRow: { k: 1 } }]));
    // 2^53+1 (TS) vs 1 (SQL) stays a mismatch — a bigint past 2^53 is not collapsed onto a number.
    assert.throws(
      () => assertReadModelParity(exactDrift, db, [{ baseRow: { k: 1 } }]),
      /parity mismatch in "bigint_norm_read_model"\.key/,
    );
  });
});


test("the parity guard runs entirely in the TEMP schema and never clobbers real main-schema tables/views the DB already holds under the model's names", async () => {
  // The guard drops/creates the base table, projection tables and managed VIEW by the model's REAL
  // names. If it did so in the `main` schema, calling it against a DB that already holds application
  // tables/views with those names would silently DELETE the caller's data. It must instead operate in
  // SQLite's TEMP schema (CREATE TEMP TABLE/VIEW, temp.-qualified drops), leaving `main` untouched.
  await withDb((db) => {
    // Real application objects in `main`, under the SAME names the guard uses, holding real rows.
    db.exec(`CREATE TABLE tasks (id TEXT, process_instance_key TEXT, state TEXT, priority INTEGER);`);
    db.exec(`CREATE TABLE urban_open_user_tasks (process_instance_key TEXT);`);
    db.exec(taskReadModel.viewDdl());
    db.run(`INSERT INTO tasks (id, process_instance_key, state, priority) VALUES (?, ?, ?, ?)`, [
      "real-1",
      "pi-real",
      "done",
      7,
    ]);
    db.run(`INSERT INTO urban_open_user_tasks (process_instance_key) VALUES (?)`, ["pi-real"]);

    assert.doesNotThrow(() =>
      assertReadModelParity(taskReadModel, db, [
        { baseRow: { process_instance_key: "pi-1", state: "done", priority: 9 }, projections: {} },
        {
          baseRow: { process_instance_key: "pi-2", state: "running", priority: 3 },
          projections: { urban_open_user_tasks: [{ process_instance_key: "pi-2" }] },
        },
      ]),
    );

    // The real main-schema base table, projection table AND managed VIEW survive with their data.
    const tasks = db.all<{ id: string }>(`SELECT id FROM main.tasks`);
    assert.equal(tasks.length, 1);
    assert.equal(tasks[0]?.id, "real-1");
    const proj = db.all<{ process_instance_key: string }>(
      `SELECT process_instance_key FROM main.urban_open_user_tasks`,
    );
    assert.equal(proj.length, 1);
    assert.equal(proj[0]?.process_instance_key, "pi-real");
    const view = db.all<{ display_status: string }>(
      `SELECT display_status FROM main.tasks_display WHERE id = 'real-1'`,
    );
    assert.equal(view.length, 1);
    assert.equal(view[0]?.display_status, "completed");
  });
});


test("the parity guard drops its TEMP fixtures/VIEW after running so a long-lived connection is left clean (even on mismatch)", async () => {
  // The guard builds TEMP tables + a TEMP VIEW under the model's real names. If it left them behind,
  // subsequent UNqualified reads/writes on that same long-lived handle would silently resolve to the
  // leftover TEMP fixtures (TEMP shadows same-named `main` objects for the connection's lifetime), and
  // the TEMP VIEW would shadow the managed `main` VIEW. It must drop everything it created in a
  // `finally`, on both the passing path AND the throwing (mismatch) path.
  const leftoverTempObjects = (db: SqliteDb): string[] =>
    db
      .all<{ name: string }>(`SELECT name FROM temp.sqlite_master WHERE type IN ('table', 'view')`)
      .map((r) => r.name);

  // Passing run: TEMP schema is empty afterwards.
  await withDb((db) => {
    assertReadModelParity(taskReadModel, db, [
      { baseRow: { process_instance_key: "pi-1", state: "done", priority: 9 }, projections: {} },
    ]);
    assert.deepEqual(leftoverTempObjects(db), []);
  });

  // Throwing run (deliberate drift): the `finally` still drops everything before the throw propagates.
  const drifted: ReadModel = {
    ...taskReadModel,
    fnFor: (column) =>
      column === "display_status"
        ? compileToFn(caseWhen([when(neq(col("state"), lit("done")), lit("completed"))], lit("active")))
        : taskReadModel.fnFor(column),
  };
  await withDb((db) => {
    assert.throws(() =>
      assertReadModelParity(drifted, db, [
        { baseRow: { process_instance_key: "pi-1", state: "done", priority: 9 }, projections: {} },
      ]),
    );
    assert.deepEqual(leftoverTempObjects(db), []);
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

test("ensureViews drops the MAIN managed view even when a TEMP view shadows the name (no stale main body)", async () => {
  // An unqualified `DROP VIEW IF EXISTS "n"` resolves TEMP first, so a stray TEMP view of the same
  // name (e.g. leaked from a parity-guard run on a long-lived handle) would be dropped INSTEAD of the
  // managed `main` view; the following `CREATE VIEW IF NOT EXISTS "n"` would then no-op against the
  // surviving main view, leaving a changed definition's STALE body live in production. ensureViews
  // qualifies the DROP to `main`, so a redefinition always refreshes the managed main body.
  await withDb((db) => {
    db.exec(`CREATE TABLE shadow_base (id TEXT);`);
    db.run(`INSERT INTO shadow_base VALUES (?)`, ["x"]);

    const v1 = defineReadModel({ name: "shadow_rm", baseTable: "shadow_base", derive: { label: lit("A") } });
    const regA = new ReadModelRegistry();
    regA.register(v1);
    regA.ensureViews(db); // main.shadow_rm = body A

    // A stray TEMP view of the same name that would swallow an unqualified DROP.
    db.exec(`CREATE TEMP VIEW shadow_rm AS SELECT 'temp' AS label;`);

    const v2 = defineReadModel({ name: "shadow_rm", baseTable: "shadow_base", derive: { label: lit("B") } });
    const regB = new ReadModelRegistry();
    regB.register(v2);
    regB.ensureViews(db); // must replace the MAIN body with B, not leave A behind the TEMP shadow

    const mainRow = db.all<{ label: string }>(`SELECT label FROM main.shadow_rm`)[0];
    assert.equal(mainRow.label, "B", "the managed main view must refresh to the new body, not stay stale behind a TEMP shadow");
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
  try {
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
  } finally {
    // Reset the process-wide singleton so this test cannot leak registrations into others.
    projectionRegistry.clear();
  }
});

test("the parity guard rejects two projections whose physical tables match only by case", async () => {
  // SQLite folds identifiers, so "Dup_Shared" and "dup_shared" are ONE physical table. The many-to-one
  // dedup keys by the case-folded name, so this collision must be rejected up front just like an exact one.
  try {
    projectionRegistry.register({ name: "dupcase_proj_a", sqlTable: "Dup_Shared" });
    projectionRegistry.register({ name: "dupcase_proj_b", sqlTable: "dup_shared" });
    const model = defineReadModel({
      name: "dupcase_table_read_model",
      baseTable: "dupcase_rows",
      derive: {
        label: caseWhen(
          [
            when(exists("dupcase_proj_a", eq(pcol("k"), col("k"))), lit("a")),
            when(exists("dupcase_proj_b", eq(pcol("k"), col("k"))), lit("b")),
          ],
          lit("none"),
        ),
      },
    });
    await withDb((db) => {
      assert.throws(
        () => assertReadModelParity(model, db, [{ baseRow: { k: "x" } }]),
        /maps projections "dupcase_proj_a" and "dupcase_proj_b" to the same physical table/,
      );
    });
  } finally {
    // Reset the process-wide singleton so this test cannot leak registrations into others.
    projectionRegistry.clear();
  }
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
  // A projection name referenced via exists(...) must be validated at declaration time too, so a bad
  // name fails immediately here rather than later at registry.register / view-apply time.
  assert.throws(
    () =>
      defineReadModel({
        name: "ok",
        baseTable: "t",
        derive: { c: exists("bad projection", eq(pcol("x"), lit(1))) },
      }),
    /invalid/,
  );
});
