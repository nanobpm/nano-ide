// The record-oriented datasource gateway (ADR 0024 / ADR 0029 §6, ADR 0055 phase 1).
//
// This is the runtime port of the console-generated `data-sdk.ts` `DataSource` + `Table<T>`:
// the RAD "TTable" a handler binds to instead of hand-writing SQL. It sits on the runtime's
// synchronous `SqliteDb` host seam but keeps the *async* app-facing contract (every method
// returns a Promise), so an app-hosted worker/action/surface handler reaches typed records the
// same way regardless of which driver backs the source underneath.
//
//   const db = app.data.open();                 // the default source as a DataSource
//   await db.exec("INSERT INTO orders(id) VALUES (?)", [id]);
//   const orders = db.table<Order>("orders");   // a typed gateway over one table
//   await orders.insert({ id, status: "new" });
//   const o = await orders.get(id);

import type { SqliteDb } from "../host.ts";
import { RESERVED_OBJECT_PREFIXES } from "../read-model.ts";

export type Row = Record<string, unknown>;

/** Best-effort observer invoked after a successful {@link Table.insert}, with the table name and
 *  the new primary-key value. The DataLayer uses it to capture write-provenance. It MUST NOT
 *  throw — an app insert must never fail because provenance capture did — but {@link Table.insert}
 *  also wraps it defensively. */
export type InsertObserver = (table: string, pk: number | bigint) => void;

export interface ExecResult {
  /** Rows changed by an INSERT/UPDATE/DELETE. */
  changed: number;
  /** Rowid of the last inserted row, when the driver reports one. */
  lastInsertId?: number | bigint;
}

/** One column of a table, from the datasource's introspected schema. */
export interface ColumnMeta {
  name: string;
  type: string;
  notNull: boolean;
  primaryKey: boolean;
}

/** One foreign-key constraint: `column` references `refTable(refColumn)`. `refColumn` is empty
 * when the FK targets the parent's primary key without naming a column; `onDelete` is the
 * referential action (e.g. `CASCADE`), empty when none was declared. */
export interface ForeignKeyMeta {
  column: string;
  refTable: string;
  refColumn: string;
  onDelete: string;
}

/** One introspected datasource object: its columns, index names, and foreign keys. Powers
 * domain-type projection and the page runtime's list/detail binding. `kind` distinguishes a
 * base `table` (read/write) from a SQL `view` (read-only): a view is readable through the same
 * `SELECT * FROM <name>` path as a table, but Urban treats every view as read-only (a plain
 * SQLite view rejects writes unless someone attaches INSTEAD OF triggers, which Urban never
 * does), so write surfaces (DB Manager, forms, the domain writer bindings) must not offer
 * insert/update/delete against a view. */
export interface TableMeta {
  name: string;
  /** `table` for a base table (read/write); `view` for a read-only SQL VIEW. */
  kind: "table" | "view";
  columns: ColumnMeta[];
  indexes: string[];
  foreignKeys: ForeignKeyMeta[];
}

/** The one thin, uniform interface behind every driver (ADR 0024 §2) — the `TDataSet`
 * equivalent. Every consumer shares exactly this surface, so the driver underneath is
 * interchangeable. */
export interface DataSource {
  /** Run a SELECT (or any row-returning statement) and collect the rows. */
  query<T extends object = Row>(sql: string, params?: unknown[]): Promise<T[]>;
  /** Run a non-row statement (INSERT/UPDATE/DELETE/DDL). */
  exec(sql: string, params?: unknown[]): Promise<ExecResult>;
  /** Run `fn` inside a transaction, committing on success and rolling back on throw. The
   * handle passed to `fn` targets the same connection. */
  tx<T>(fn: (t: DataSource) => Promise<T>): Promise<T>;
  /** Introspect the datasource's tables/columns/indexes/foreign keys. */
  schema(): Promise<TableMeta[]>;
  /** A typed gateway over one table — the RAD "TTable". `pk` is the primary-key column
   * (default "id"). */
  table<T extends object = Row>(name: string, pk?: string): Table<T>;
}

/** Double-quote a SQL identifier (table/column), escaping embedded quotes. */
export function quoteIdent(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

/** Build a parameterised ` WHERE a = ? AND b = ?` clause from an equality map; an empty map
 * yields an empty clause (matches all rows). Takes `object` (not `Row`) so a `Partial<T>` for a
 * generated `interface` row type (which lacks a string index signature) is accepted. */
function whereClause(where: object): { clause: string; params: unknown[] } {
  const entries = Object.entries(where);
  if (entries.length === 0) return { clause: "", params: [] };
  const clause = " WHERE " + entries.map(([k]) => `${quoteIdent(k)} = ?`).join(" AND ");
  return { clause, params: entries.map(([, v]) => v) };
}

/** A typed gateway over a single table — the record-oriented data object a handler binds to
 * instead of hand-writing SQL (the Delphi `TTable`/data-module idea, ADR 0029 §6). It builds
 * parameterised SQL from a typed row object's own keys, so callers manipulate rows as records.
 * `T` comes from a generated row type; this class is generic *runtime* and knows nothing about
 * any specific schema. `pk` is the primary-key column (default `id`). */
export class Table<T extends object = Row> {
  readonly name: string;
  readonly pk: string;
  readonly #src: DataSource;
  readonly #onInsert?: InsertObserver;

  constructor(src: DataSource, name: string, pk = "id", onInsert?: InsertObserver) {
    this.#src = src;
    this.name = name;
    this.pk = pk;
    this.#onInsert = onInsert;
  }

  /** Insert one row; returns the new primary-key value (the inserted rowid for an INTEGER
   * PRIMARY KEY). Keys whose value is `undefined` are omitted, so the table's own column
   * `DEFAULT`/`NULL` governs — `undefined` means "not provided, let the schema decide", never
   * a bound value. An explicit `null` is preserved (it stores `NULL`). */
  async insert(row: Partial<T>): Promise<number | bigint> {
    const provided = Object.entries(row);
    const entries = provided.filter(([, v]) => v !== undefined);
    if (entries.length === 0) {
      throw new Error(
        provided.length === 0
          ? `Table(${this.name}).insert: no columns to insert (empty row)`
          : `Table(${this.name}).insert: no columns to insert (all values were undefined)`,
      );
    }
    const cols = entries.map(([k]) => quoteIdent(k)).join(", ");
    const ph = entries.map(() => "?").join(", ");
    const r = await this.#src.exec(
      `INSERT INTO ${quoteIdent(this.name)} (${cols}) VALUES (${ph})`,
      entries.map(([, v]) => v),
    );
    if (r.lastInsertId == null) {
      // The driver reported no rowid — treat as a failed/ambiguous insert rather than
      // silently returning 0, which a caller could mistake for a real primary key.
      throw new Error(`Table(${this.name}).insert: driver reported no lastInsertId`);
    }
    if (this.#onInsert) {
      // Provenance capture is strictly observational: never let it break the app insert, which
      // executed successfully above. If this insert runs inside a transaction, commit/rollback
      // semantics still belong to that surrounding transaction.
      try {
        this.#onInsert(this.name, r.lastInsertId);
      } catch {
        // swallow — an insert must never fail because provenance capture did
      }
    }
    return r.lastInsertId;
  }

  /** Fetch the row with the given primary key, or `undefined`. */
  async get(id: unknown): Promise<T | undefined> {
    const rows = await this.#src.query<T>(
      `SELECT * FROM ${quoteIdent(this.name)} WHERE ${quoteIdent(this.pk)} = ? LIMIT 1`,
      [id],
    );
    return rows[0];
  }

  /** Every row (optionally capped at `limit`). */
  async all(limit?: number): Promise<T[]> {
    const lim =
      typeof limit === "number" && Number.isFinite(limit)
        ? ` LIMIT ${Math.max(0, Math.floor(limit))}`
        : "";
    return this.#src.query<T>(`SELECT * FROM ${quoteIdent(this.name)}${lim}`);
  }

  /** Rows matching an equality filter (keys ANDed). An empty filter matches all rows. */
  async find(where: Partial<T> = {}): Promise<T[]> {
    const { clause, params } = whereClause(where);
    return this.#src.query<T>(
      `SELECT * FROM ${quoteIdent(this.name)}${clause}`,
      params,
    );
  }

  /** The first row matching an equality filter, or `undefined`. */
  async findOne(where: Partial<T> = {}): Promise<T | undefined> {
    const { clause, params } = whereClause(where);
    const rows = await this.#src.query<T>(
      `SELECT * FROM ${quoteIdent(this.name)}${clause} LIMIT 1`,
      params,
    );
    return rows[0];
  }

  /** Patch the row with the given primary key; returns rows changed. Keys whose value is
   * `undefined` are skipped (that column is left unchanged); an explicit `null` clears the
   * column to `NULL`. A patch with no defined keys is a no-op. */
  async update(id: unknown, patch: Partial<T>): Promise<number> {
    const entries = Object.entries(patch).filter(([, v]) => v !== undefined);
    if (entries.length === 0) return 0;
    const set = entries.map(([k]) => `${quoteIdent(k)} = ?`).join(", ");
    const r = await this.#src.exec(
      `UPDATE ${quoteIdent(this.name)} SET ${set} WHERE ${quoteIdent(this.pk)} = ?`,
      [...entries.map(([, v]) => v), id],
    );
    return r.changed;
  }

  /** Delete the row with the given primary key; returns rows changed. */
  async delete(id: unknown): Promise<number> {
    const r = await this.#src.exec(
      `DELETE FROM ${quoteIdent(this.name)} WHERE ${quoteIdent(this.pk)} = ?`,
      [id],
    );
    return r.changed;
  }

  /** Count rows matching an equality filter (all rows when omitted). */
  async count(where: Partial<T> = {}): Promise<number> {
    const { clause, params } = whereClause(where);
    const rows = await this.#src.query<{ n?: unknown }>(
      `SELECT COUNT(*) AS n FROM ${quoteIdent(this.name)}${clause}`,
      params,
    );
    return Number(rows[0]?.n ?? 0);
  }
}

/** A `DataSource` implemented over the runtime's synchronous `SqliteDb` host seam. The methods
 * are async to hold the app-facing contract; the work underneath is synchronous. */
class SqliteGateway implements DataSource {
  readonly #db: SqliteDb;
  readonly #onInsert?: InsertObserver;
  constructor(db: SqliteDb, onInsert?: InsertObserver) {
    this.#db = db;
    this.#onInsert = onInsert;
  }

  async query<T extends object = Row>(sql: string, params: unknown[] = []): Promise<T[]> {
    return this.#db.all<T>(sql, params);
  }

  async exec(sql: string, params: unknown[] = []): Promise<ExecResult> {
    const r = this.#db.run(sql, params);
    return { changed: Number(r.changes), lastInsertId: r.lastInsertRowid };
  }

  async tx<T>(fn: (t: DataSource) => Promise<T>): Promise<T> {
    this.#db.exec("BEGIN");
    try {
      const out = await fn(this);
      this.#db.exec("COMMIT");
      return out;
    } catch (e) {
      this.#db.exec("ROLLBACK");
      throw e;
    }
  }

  async schema(): Promise<TableMeta[]> {
    // Introspect base tables AND views (`type IN ('table','view')`): the datasource read path
    // (`SELECT * FROM <name>`) works verbatim on a view, so a page datasource / domain read must
    // be able to see one. A view is tagged `kind:'view'` below so write surfaces know not to
    // offer insert/update/delete against it (Urban treats every view as read-only; a plain
    // SQLite view rejects writes absent INSTEAD OF triggers, which Urban never attaches).
    //
    // Exclude SQLite internals (`sqlite_%`) and Nano's own bookkeeping tables (`_urban_%` /
    // `_nano_%`, e.g. the migrations ledger): neither is a user/domain object, so they must
    // never surface in the domain model, DB Manager, or forms. The same exclusions apply to
    // views. The prefix set is derived from RESERVED_OBJECT_PREFIXES (No Drift Surfaces) so this
    // read-side filter cannot diverge from the write-side skip / manifest-validation rejection.
    const reservedClause = RESERVED_OBJECT_PREFIXES.map(
      (p) => `AND name NOT LIKE '${p.replace(/_/g, "\\_")}%' ESCAPE '\\'`,
    ).join(" ");
    const tables = this.#db.all<{ name: string; type: string }>(
      `SELECT name, type FROM sqlite_master WHERE type IN ('table','view') ${reservedClause} ORDER BY name`,
    );
    const out: TableMeta[] = [];
    for (const t of tables) {
      // `PRAGMA table_info(<view>)` returns the view's columns (pk/notnull report 0, which is
      // correct — a view has no primary key); `PRAGMA index_list` / `foreign_key_list` return
      // empty for a view (harmless).
      const cols = this.#db.all<{ name: string; type: string; notnull: number; pk: number }>(
        `PRAGMA table_info(${quoteIdent(t.name)})`,
      );
      const idx = this.#db.all<{ name: string }>(`PRAGMA index_list(${quoteIdent(t.name)})`);
      const fks = this.#db.all<{
        from: string;
        table: string;
        to: string | null;
        on_delete?: string;
      }>(`PRAGMA foreign_key_list(${quoteIdent(t.name)})`);
      out.push({
        name: t.name,
        kind: t.type === "view" ? "view" : "table",
        columns: cols.map((c) => ({
          name: c.name,
          type: c.type,
          notNull: !!c.notnull,
          primaryKey: !!c.pk,
        })),
        indexes: idx.map((i) => String(i.name)),
        foreignKeys: fks.map((f) => ({
          column: f.from,
          refTable: f.table,
          refColumn: f.to ?? "",
          onDelete:
            f.on_delete && f.on_delete.toUpperCase() !== "NO ACTION"
              ? f.on_delete.toUpperCase()
              : "",
        })),
      });
    }
    return out;
  }

  table<T extends object = Row>(name: string, pk = "id"): Table<T> {
    return new Table<T>(this, name, pk, this.#onInsert);
  }
}

/** Wrap a provisioned `SqliteDb` as the record-oriented `DataSource` gateway. An optional
 *  `onInsert` observer is invoked after every successful `Table.insert` (used for
 *  write-provenance capture); it is threaded to each `Table` this gateway creates. */
export function makeGateway(db: SqliteDb, onInsert?: InsertObserver): DataSource {
  return new SqliteGateway(db, onInsert);
}
