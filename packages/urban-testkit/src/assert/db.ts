// `assertThatDb` — fluent assertions over the app's provisioned SQLite (`app.db`),
// the first of the two Urban surfaces the process-engine DSL has no analog for.
//
// `assertThatDb(app).table(name)` narrows to one table; the row matchers read every
// row through the record-oriented `DataLayer` gateway (`app.db.table(name).all()`,
// an ADR-0055 `Table<T>` surface). That read is asynchronous — it awaits a
// deterministic SQLite query, NOT wall-clock time — so the matchers return a
// `Promise` and stay chainable via `await`. No `Date.now`/`setTimeout`/`Math.random`
// is ever touched; a failure is a pure function of the table's contents.

import type { TestApp } from "../boot-app.ts";
import { deepSubset, failAssertion, formatValue } from "./format.ts";

/** Fluent assertions over the rows of a single SQLite table. Each matcher awaits a
 *  fresh read of the table and resolves to the same object so calls chain. */
export interface TableAssert {
  /** Assert the table contains at least one row whose columns deep-match `subset`
   *  (a SUBSET match — extra columns on the row are ignored). */
  hasRow(subset: Record<string, unknown>): Promise<TableAssert>;
  /** Assert the table holds exactly `n` rows. */
  rowCount(n: number): Promise<TableAssert>;
  /** Assert the table holds no rows. */
  isEmpty(): Promise<TableAssert>;
}

/** Entry point for SQLite-table assertions; `table(name)` narrows to one table. */
export interface DbAssert {
  table(name: string): TableAssert;
}

/** Assert over the app's provisioned SQLite (`app.db`). */
export function assertThatDb(app: TestApp): DbAssert {
  return {
    table: (name: string): TableAssert => makeTableAssert(app, name),
  };
}

function makeTableAssert(app: TestApp, name: string): TableAssert {
  // Read every row of the table through the record-oriented gateway. This awaits a
  // SQLite query (a deterministic data read), never real time.
  const readRows = (): Promise<Record<string, unknown>[]> =>
    app.db.table<Record<string, unknown>>(name).all();

  const self: TableAssert = {
    hasRow: async (subset) => {
      const rows = await readRows();
      if (!rows.some((row) => deepSubset(row, subset))) {
        failAssertion({
          message: `assertThatDb().table(${JSON.stringify(name)}).hasRow: no row matches the expected subset (${rows.length} row(s) in the table)`,
          actual: rows,
          expected: subset,
          operator: "assertThatDb.hasRow",
        });
      }
      return self;
    },
    rowCount: async (n) => {
      const rows = await readRows();
      if (rows.length !== n) {
        failAssertion({
          message: `assertThatDb().table(${JSON.stringify(name)}).rowCount: expected ${n} row(s) but found ${rows.length}\n  rows: ${formatValue(rows)}`,
          actual: rows.length,
          expected: n,
          operator: "assertThatDb.rowCount",
        });
      }
      return self;
    },
    isEmpty: async () => {
      const rows = await readRows();
      if (rows.length !== 0) {
        failAssertion({
          message: `assertThatDb().table(${JSON.stringify(name)}).isEmpty: expected no rows but found ${rows.length}\n  rows: ${formatValue(rows)}`,
          actual: rows.length,
          expected: 0,
          operator: "assertThatDb.isEmpty",
        });
      }
      return self;
    },
  };
  return self;
}
