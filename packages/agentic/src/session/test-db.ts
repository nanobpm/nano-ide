/**
 * Test-only helper: a {@link SqliteDb} backed by an in-memory `node:sqlite`
 * database, mirroring the Node host adapter's `wrapNodeSqlite` (and the identical
 * helper in @nanobpm/agentic's presence/transcript families). Kept out of the
 * published build (see `tsconfig.build.json` exclude) — it exists solely so the
 * durable-log tests exercise the store against a real SQLite engine, not a mock.
 */
import type { TestContext } from "node:test";
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

/**
 * Open an in-memory test database. Pass the test's {@link TestContext} to make
 * the DB close automatically when the test finishes (`t.after`) — the single
 * canonical cleanup path, so no test can leak an open SQLite handle by forgetting
 * to call `close()`. `close()` is idempotent, so an explicit call is still safe.
 */
export function openTestDb(t?: TestContext): TestDb {
  const db = new DatabaseSync(":memory:");
  let closed = false;
  const close = (): void => {
    if (closed) return;
    closed = true;
    db.close();
  };
  t?.after(close);
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
    close,
  };
}
