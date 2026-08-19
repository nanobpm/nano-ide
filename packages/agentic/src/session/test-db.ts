/**
 * Test-only helper: a {@link SqliteDb} backed by an in-memory `node:sqlite`
 * database, mirroring the Node host adapter's `wrapNodeSqlite` (and the identical
 * helper in @nanobpm/agentic's presence/transcript families). Kept out of the
 * published build — it exists solely so the durable-log tests exercise the store
 * against a real SQLite engine, not a mock.
 */
import { DatabaseSync } from "node:sqlite";
import type { SqliteDb } from "./log.ts";

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
      // biome-ignore lint/plugin: Node sqlite returns untyped row objects; SqliteDb.all<T> is the host adapter boundary.
      return stmt.all(...toParams(params)) as T[];
    },
    close: () => db.close(),
  };
}
