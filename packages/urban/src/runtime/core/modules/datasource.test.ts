import { test } from "node:test";
import assert from "node:assert/strict";
import { applyMigrations, isAbsolutePath, MIGRATIONS_TABLE, parentDir, resolveAppPath, resolveSqlitePath, sqlitePathFromUrl } from "./datasource.ts";
import type { HostContext, SqliteDb } from "../host.ts";

// `resolveSqlitePath` is the single source of truth for turning a datasource `url` into its
// on-disk SQLite path (absolute when `root` is absolute, relative when `root` is relative, e.g.
// `root === "."`), shared by `openSqliteSource` (which opens the file) and `provisionSqlite`
// (which logs `path`). These guard that the two can never drift: the logged path must be exactly
// the path that was opened.
test("resolveSqlitePath joins a relative url verbatim against root", () => {
  assert.equal(resolveSqlitePath("/srv/app", "file:./db/app.db"), "/srv/app/./db/app.db");
  assert.equal(resolveSqlitePath("/srv/app", "sqlite:db/app.db"), "/srv/app/db/app.db");
  assert.equal(resolveSqlitePath(".", "sqlite:db/app.db"), "./db/app.db");
});

test("resolveSqlitePath passes an absolute path through unchanged", () => {
  assert.equal(resolveSqlitePath("/srv/app", "file:/var/data/app.db"), "/var/data/app.db");
});

test("resolveSqlitePath honours Windows absolute paths (drive-letter + UNC) as-is", () => {
  // A Node host on Windows can hand us a drive-letter or UNC absolute path; it must NOT be
  // treated as relative and prefixed with `root`.
  assert.equal(resolveSqlitePath("/srv/app", "file:C:\\data\\app.db"), "C:\\data\\app.db");
  assert.equal(resolveSqlitePath("/srv/app", "sqlite:C:/data/app.db"), "C:/data/app.db");
  assert.equal(
    resolveSqlitePath("/srv/app", "file:\\\\server\\share\\app.db"),
    "\\\\server\\share\\app.db",
  );
});

test("isAbsolutePath recognises POSIX, drive-letter and UNC roots (and rejects relative)", () => {
  assert.equal(isAbsolutePath("/var/data/app.db"), true);
  assert.equal(isAbsolutePath("C:\\data\\app.db"), true);
  assert.equal(isAbsolutePath("c:/data/app.db"), true);
  assert.equal(isAbsolutePath("\\\\server\\share\\app.db"), true);
  assert.equal(isAbsolutePath("\\data\\app.db"), true); // Windows drive-root, single leading backslash
  assert.equal(isAbsolutePath("db/app.db"), false);
  assert.equal(isAbsolutePath("./db/app.db"), false);
  assert.equal(isAbsolutePath("C:relative.db"), false); // drive-relative, no root separator
});

test("resolveAppPath trims a trailing separator of either kind off root before joining", () => {
  assert.equal(resolveAppPath("/srv/app/", "app.db"), "/srv/app/app.db");
  // A Windows-style root (uses backslashes) joins with "\\" and normalizes the relative segment's
  // separators to match, so the result is never mixed-separator ("C:\\srv\\app/app.db").
  assert.equal(resolveAppPath("C:\\srv\\app\\", "app.db"), "C:\\srv\\app\\app.db");
  assert.equal(resolveAppPath("C:\\srv\\app", "db/app.db"), "C:\\srv\\app\\db\\app.db");
  assert.equal(resolveAppPath("\\\\server\\share", "db/migrations"), "\\\\server\\share\\db\\migrations");
  // A drive-letter root that already uses forward slashes stays forward-slash (also non-mixed).
  assert.equal(resolveAppPath("C:/srv/app/", "app.db"), "C:/srv/app/app.db");
  // A forward-slash root joined with a backslash-containing relative segment normalizes the
  // segment to "/", so the result is never mixed-separator ("C:/srv/app/db\\migrations").
  assert.equal(resolveAppPath("C:/srv/app", "db\\migrations"), "C:/srv/app/db/migrations");
  assert.equal(resolveAppPath(".", "db\\migrations"), "./db/migrations");
  // A mixed-separator root is normalized to the chosen style too (it contains a backslash, so the
  // whole path becomes backslash-style), so the result is never mixed even when `root` itself is.
  assert.equal(resolveAppPath("C:/srv\\app", "db/app.db"), "C:\\srv\\app\\db\\app.db");
  assert.equal(resolveAppPath("C:/srv\\app\\", "db/app.db"), "C:\\srv\\app\\db\\app.db");
});

test("parentDir keeps the trailing separator on a Windows drive root", () => {
  // A file directly under a drive root must yield the drive root itself, not the bare volume:
  // "C:" is a drive-relative reference, "C:\\" / "C:/" is the actual directory.
  assert.equal(parentDir("C:\\app.db"), "C:\\");
  assert.equal(parentDir("C:/app.db"), "C:/");
  // Nested paths and the no-parent cases keep working.
  assert.equal(parentDir("C:\\data\\app.db"), "C:\\data");
  assert.equal(parentDir("/var/data/app.db"), "/var/data");
  assert.equal(parentDir("app.db"), "");
});

test("resolveSqlitePath strips a trailing slash on root before joining", () => {
  assert.equal(resolveSqlitePath("/srv/app/", "sqlite:app.db"), "/srv/app/app.db");
});

test("resolveSqlitePath resolves the same path openSqliteSource would open", () => {
  const root = "/srv/app";
  const url = "file:./db/app.db";
  const bare = sqlitePathFromUrl(url);
  assert.equal(resolveSqlitePath(root, url), `${root}/${bare}`);
});

test("MIGRATIONS_TABLE is the single canonical ledger name shared by application and listing", () => {
  // `applyMigrations` (datasource) writes this ledger and dataops' `migrations` op reads it; both
  // import this constant so the name can never drift between the two sites.
  assert.equal(MIGRATIONS_TABLE, "_urban_migrations");
});

test("applyMigrations joins each migration file onto its dir without reintroducing mixed separators", async () => {
  // When the resolved migrations dir is Windows/UNC-style (backslashes), the per-file read path
  // must adopt that separator too — a literal "/" join would emit e.g.
  // "C:\\app\\db\\migrations/001.sql", which breaks reads on Windows. `applyMigrations` routes the
  // join through `resolveAppPath`, so we assert the exact path handed to `readTextFile`.
  const readPaths: string[] = [];
  const host: HostContext = {
    runtime: "node",
    env: () => undefined,
    now: () => 0,
    exists: async () => true,
    statFile: async () => ({ isFile: true }),
    listDir: async () => ["002_b.sql", "001_a.sql"],
    readTextFile: async (path: string) => {
      readPaths.push(path);
      return "";
    },
    openSqlite: () => {
      throw new Error("sqlite not used in this test");
    },
    importModule: async () => ({}),
    serveHttp: async () => ({ port: 0, stop: async () => {} }),
    log: () => {},
  };
  const db: SqliteDb = {
    exec: () => {},
    run: () => ({ changes: 0, lastInsertRowid: 0 }),
    all: <T>() => {
      const rows: T[] = [];
      return rows;
    },
    close: () => {},
  };
  // A backslash root makes `resolveAppPath` pick "\\", so the migrations dir is backslash-style.
  const applied = await applyMigrations(host, db, "C:\\srv\\app", "db\\migrations");
  assert.deepEqual(applied, ["001_a.sql", "002_b.sql"]);
  assert.deepEqual(readPaths, [
    "C:\\srv\\app\\db\\migrations\\001_a.sql",
    "C:\\srv\\app\\db\\migrations\\002_b.sql",
  ]);
});
