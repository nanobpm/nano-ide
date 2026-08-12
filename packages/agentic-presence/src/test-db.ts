/**
 * Test-only helper: a {@link SqliteDb} backed by an in-memory `node:sqlite`
 * database, mirroring the Node host adapter's `wrapNodeSqlite`. Kept out of the
 * published build (see `tsconfig.build.json` exclude) — it exists solely so the
 * store/family tests exercise the store against a real SQLite engine, not a mock.
 */
import { DatabaseSync } from "node:sqlite";
import type { SqliteDb } from "./store.ts";

export interface TestDb extends SqliteDb {
  close(): void;
}

function toParams(params: unknown[]): (string | number | bigint | null | Uint8Array)[] {
  return params.map((p) => {
    if (p === null) return null;
    if (typeof p === "string" || typeof p === "number" || typeof p === "bigint" || p instanceof Uint8Array) {
      return p;
    }
    if (typeof p === "boolean") return p ? 1 : 0;
    // Mirror wrapNodeSqlite's `sqliteParams`: unsupported types (including
    // `undefined`) throw rather than coerce, so a test can never pass on a
    // parameter production would reject.
    throw new TypeError(`unsupported SQLite parameter type: ${typeof p}`);
  });
}

export function openTestDb(): TestDb {
  const db = new DatabaseSync(":memory:");
  return {
    exec: (sql) => db.exec(sql),
    run: (sql, params = []) => {
      const stmt = db.prepare(sql);
      const r = stmt.run(...toParams(params));
      return { changes: Number(r.changes), lastInsertRowid: r.lastInsertRowid };
    },
    all: <T>(sql: string, params: unknown[] = []): T[] => {
      const stmt = db.prepare(sql);
      const rows = stmt.all(...toParams(params));
      return JSON.parse(JSON.stringify(rows));
    },
    close: () => db.close(),
  };
}
