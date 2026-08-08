// datasource — provision the manifest `data` sources and expose typed accessors for the
// `types` domain model. Only the `sqlite` driver is implemented; other drivers hit an
// explicit seam (they are declared in the manifest but not yet provisioned). This is the
// runtime side of ADR 0024 (datasource) + ADR 0040 (domain model), scoped to what an app needs.

import type { RuntimeContext } from "../context.ts";
import type { HostContext, SqliteDb } from "../host.ts";
import type { AppManifest, DataSource, DomainType } from "../manifest.ts";
import {
  makeGateway,
  Table,
  type DataSource as GatewayDataSource,
  type InsertObserver,
} from "./gateway.ts";
import { currentJobContext } from "../execContext.ts";

export function sqlitePathFromUrl(url: string): string {
  // Accept "file:./x.db", "file:x.db", "sqlite:./x.db" or a bare path.
  return url.replace(/^(file|sqlite):(\/\/)?/, "");
}

/** True when `p` is already an absolute path on any host `urban data` targets. `urban data` runs
 * on a Node host that may be Windows, so absolute-path detection can't assume POSIX: this matches
 * a POSIX root ("/…"), a Windows drive-letter root ("C:\…" or "C:/…"), a Windows drive-root path
 * that starts with a single backslash ("\data\app.db") and a Windows UNC path
 * ("\\\\server\\share"). A single leading backslash covers both the drive-root and UNC cases,
 * matching Node's `path.win32.isAbsolute`. Used by `resolveAppPath` so a caller-supplied absolute
 * path is never incorrectly prefixed with the app root. */
export function isAbsolutePath(p: string): boolean {
  return /^(\/|\\|[A-Za-z]:[/\\])/.test(p);
}

/** Resolve `p` against the app `root`: an absolute `p` (see `isAbsolutePath`) is returned as-is;
 * a relative `p` is joined onto `root`. Trims a trailing separator of either kind off `root` so
 * we never emit a doubled separator. The join separator matches the root's own style so we never
 * emit a mixed-separator path (e.g. "C:\\srv\\app/app.db" or "\\\\server\\share/db\\migrations"),
 * which Windows/UNC resolution and some tooling mishandle: a root that already uses backslashes is
 * Windows-style and joins with "\\" — normalizing the relative segment's forward slashes to match —
 * while everything else (POSIX, a "C:/…" forward-slash root, or a relative ".") joins with "/" —
 * normalizing the relative segment's backslashes to match. Both `root` AND the relative segment are
 * rewritten to the chosen separator, so the result is never mixed even when `root` itself is mixed
 * (e.g. "C:/srv\\app") or `p` is. The single canonical implementation shared by `resolveSqlitePath`
 * (datasource urls) and `resolveManifestPath` (`--manifest`) — and by `applyMigrations` to join each
 * migration file onto its dir — so those path resolutions can never drift and all behave the same
 * cross-platform. */
export function resolveAppPath(root: string, p: string): string {
  if (isAbsolutePath(p)) return p;
  const sep = root.includes("\\") ? "\\" : "/";
  const norm = (s: string): string => (sep === "\\" ? s.replace(/\//g, "\\") : s.replace(/\\/g, "/"));
  const base = norm(root).replace(/[/\\]+$/, "");
  const rel = norm(p);
  return `${base}${sep}${rel}`;
}

/** Name of the SQLite ledger table that records applied migrations. The single source of truth
 * for this identifier: `applyMigrations` writes it and `dataops`' `migrations` op reads it, so
 * both import this constant and the ledger name can never drift between application and listing. */
export const MIGRATIONS_TABLE = "_urban_migrations";

/** Name of the urban-owned write-provenance sidecar table (ProcessOS domain-signal plane, D0).
 *  One append per app `Table.insert` performed inside a job, linking the written row —
 *  `(source, table_name, pk_value)` — to the process instance/element that wrote it. Follows the
 *  `_urban_` convention so it is automatically excluded from domain-model introspection,
 *  DB Manager, and forms (see `gateway.ts` `schema()`), and never collides with an app table. */
export const WRITE_PROVENANCE_TABLE = "_urban_write_provenance";

/** Provision the write-provenance sidecar on a source (idempotent). Domain-free: it records only
 *  the join key + timestamps, never any row content. */
export function ensureProvenanceTable(db: SqliteDb): void {
  db.exec(
    `CREATE TABLE IF NOT EXISTS ${WRITE_PROVENANCE_TABLE} (` +
      "seq INTEGER PRIMARY KEY AUTOINCREMENT, " +
      "source TEXT NOT NULL, " +
      "table_name TEXT NOT NULL, " +
      "pk_value TEXT NOT NULL, " +
      "instance_key TEXT, " +
      "element_id TEXT, " +
      "job_type TEXT, " +
      "op TEXT NOT NULL DEFAULT 'insert', " +
      "at TEXT NOT NULL)",
  );
}

/** Build the {@link InsertObserver} that captures write-provenance for one source. Best-effort:
 *  it records a row only when a job execution context with an instance key is active (a worker
 *  handler is running) — writes outside a job (e.g. HTTP actions) record nothing, degrading
 *  gracefully. It skips urban/engine-internal tables so the provenance table never records
 *  itself. It runs on the same connection as the insert, so inside a `tx` the provenance row is
 *  committed/rolled back atomically with the app write. `Table.insert` wraps this defensively, so
 *  a throw here can never break the app insert. */
export function makeProvenanceRecorder(
  host: HostContext,
  db: SqliteDb,
  source: string,
): InsertObserver {
  return (table, pk) => {
    if (table.startsWith("_urban_") || table.startsWith("_nano_") || table.startsWith("sqlite_")) {
      return;
    }
    const ctx = currentJobContext();
    if (!ctx || ctx.instanceKey == null) return;
    db.run(
      `INSERT INTO ${WRITE_PROVENANCE_TABLE} ` +
        "(source, table_name, pk_value, instance_key, element_id, job_type, op, at) " +
        "VALUES (?, ?, ?, ?, ?, ?, 'insert', ?)",
      [
        source,
        table,
        String(pk),
        ctx.instanceKey,
        ctx.elementId ?? null,
        ctx.jobType ?? null,
        new Date(host.now()).toISOString(),
      ],
    );
  };
}

/** Resolve a datasource `url` to its on-disk SQLite path against `root`. The result is absolute
 * when the resolved path is absolute (either because `url` names an absolute path or `root` is
 * absolute); if `root` is relative (e.g. "." as used by the CLI/tests) a relative `url` stays
 * correspondingly relative. The single source of truth for this resolution, shared by
 * `openSqliteSource` (to open the file) and `provisionSqlite` (to report where it provisioned),
 * so the opened path and the logged path can never drift. */
export function resolveSqlitePath(root: string, url: string): string {
  return resolveAppPath(root, sqlitePathFromUrl(url));
}

/**
 * Open (creating if needed) the SQLite file a `file:`/`sqlite:` URL points at, resolved against
 * `root`, with WAL journalling — but WITHOUT applying migrations. Provisioning (`provisionSqlite`)
 * layers migrations on top; the `urban data` DB-manager gateway (dataops.ts) wants the raw handle
 * so read/`migrations`-list ops don't silently mutate the schema on open.
 */
export async function openSqliteSource(
  host: HostContext,
  root: string,
  url: string,
): Promise<SqliteDb> {
  const abs = resolveSqlitePath(root, url);
  const dir = parentDir(abs);
  if (dir && !(await host.exists(dir))) {
    // The host API doesn't expose mkdir and openSqlite won't create parent dirs,
    // so fail fast with a clear, actionable message instead of a low-level
    // "cannot open" error.
    throw new Error(
      `directory "${dir}" does not exist — create it before running (the SQLite file cannot be opened otherwise)`,
    );
  }
  const db = host.openSqlite(abs);
  db.exec("PRAGMA journal_mode=WAL");
  return db;
}

/** A safe unquoted SQL identifier. Table/column names are interpolated directly into SQL,
 * so reject anything that isn't a plain identifier to prevent invalid SQL / injection. */
const SQL_IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;
function assertSqlIdent(kind: string, name: string): string {
  if (!SQL_IDENT.test(name)) {
    throw new Error(`invalid ${kind} "${name}": must match ${SQL_IDENT.source}`);
  }
  return name;
}

/** The parent directory of `path`, or `""` when it has none (a bare filename or a filesystem
 * root, for which the existence check in `openSqliteSource` is intentionally skipped). Splits on
 * either separator so a Windows-style absolute path (e.g. "C:\data\app.db") yields a real parent
 * dir rather than being treated as having none. Preserves the trailing separator on a Windows
 * drive root so "C:\app.db" -> "C:\" (and "C:/app.db" -> "C:/"), not the bare volume "C:" — the
 * latter is a drive-relative reference, not the drive root, and would make `openSqliteSource`
 * fail fast against the wrong location. */
export function parentDir(path: string): string {
  const i = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  if (i <= 0) return "";
  // A Windows drive root ("C:\…" / "C:/…"): the separator sits right after the "C:" volume, so
  // keep it — dropping it would yield the drive-relative "C:" rather than the drive root.
  if (i === 2 && /^[A-Za-z]:$/.test(path.slice(0, 2))) return path.slice(0, i + 1);
  return path.slice(0, i);
}

/** A typed accessor over a table declared in manifest `types`. */
export class TypeRepo {
  private readonly db: SqliteDb;
  readonly typeName: string;
  private readonly def: DomainType;

  constructor(db: SqliteDb, typeName: string, def: DomainType) {
    this.db = db;
    this.typeName = typeName;
    this.def = def;
  }

  private table(): string {
    if (!this.def.table) throw new Error(`type "${this.typeName}" has no table`);
    return assertSqlIdent("table name", this.def.table);
  }

  private assertFields(row: Record<string, unknown>): void {
    const declared = this.def.fields;
    if (!declared) return;
    for (const key of Object.keys(row)) {
      if (!(key in declared)) {
        throw new Error(
          `field "${key}" is not declared on type "${this.typeName}" (guards schema drift)`,
        );
      }
      assertSqlIdent("field name", key);
    }
  }

  insert(row: Record<string, unknown>): { changes: number; lastInsertRowid: number | bigint } {
    this.assertFields(row);
    // Omit keys whose value is `undefined` so the column's own `DEFAULT`/`NULL` governs;
    // `undefined` means "not provided", never a bound value. An explicit `null` is preserved.
    const provided = Object.keys(row);
    const keys = provided.filter((k) => row[k] !== undefined);
    if (keys.length === 0) {
      // A present-but-all-undefined payload throws (parity with Table.insert): the caller
      // meant to write those values, so silently inserting a full DEFAULT row would create
      // an unintended record. A genuinely empty `insert({})` is the explicit "default row".
      if (provided.length > 0) {
        throw new Error(
          `insert into type "${this.typeName}": no columns to insert (all values were undefined)`,
        );
      }
      return this.db.run(`INSERT INTO ${this.table()} DEFAULT VALUES`, []);
    }
    const cols = keys.join(", ");
    const placeholders = keys.map(() => "?").join(", ");
    const sql = `INSERT INTO ${this.table()} (${cols}) VALUES (${placeholders})`;
    return this.db.run(sql, keys.map((k) => row[k]));
  }

  all<T = Record<string, unknown>>(): T[] {
    return this.db.all<T>(`SELECT * FROM ${this.table()}`);
  }

  query<T = Record<string, unknown>>(where: Record<string, unknown>): T[] {
    this.assertFields(where);
    const keys = Object.keys(where);
    if (keys.length === 0) return this.all<T>();
    const clause = keys.map((k) => `${k} = ?`).join(" AND ");
    return this.db.all<T>(
      `SELECT * FROM ${this.table()} WHERE ${clause}`,
      keys.map((k) => where[k]),
    );
  }
}

export interface ProvisionedSource {
  readonly name: string;
  readonly driver: string;
  readonly db: SqliteDb;
  /** The record-oriented gateway over this source — the RAD `Table<T>` surface (ADR 0055). */
  readonly source: GatewayDataSource;
  readonly migrationsApplied: string[];
  close(): void;
}

export class DataLayer {
  private readonly sources: Map<string, ProvisionedSource>;
  private readonly defaultSource: string | undefined;
  private readonly types: Record<string, DomainType>;

  constructor(
    sources: Map<string, ProvisionedSource>,
    defaultSource: string | undefined,
    types: Record<string, DomainType>,
  ) {
    this.sources = sources;
    this.defaultSource = defaultSource;
    this.types = types;
  }

  source(name?: string): ProvisionedSource {
    const key = name ?? this.defaultSource;
    if (!key) throw new Error("no data source specified and no default configured");
    const s = this.sources.get(key);
    if (!s) throw new Error(`no such data source "${key}"`);
    return s;
  }

  /** A typed accessor for a declared domain type (uses the default source). */
  repo(typeName: string, sourceName?: string): TypeRepo {
    const def = this.types[typeName];
    if (!def) throw new Error(`no such type "${typeName}"`);
    return new TypeRepo(this.source(sourceName).db, typeName, def);
  }

  /** The record-oriented `DataSource` gateway for a source (the default when omitted) — the
   * raw-SQL + `Table<T>` surface app handlers bind to (ADR 0055). */
  open(sourceName?: string): GatewayDataSource {
    return this.source(sourceName).source;
  }

  /** A typed `Table<T>` gateway over one table on a source (the default when omitted). `pk` is
   * the primary-key column (default "id"). */
  table<T extends object = Record<string, unknown>>(
    name: string,
    pk?: string,
    sourceName?: string,
  ): Table<T> {
    return this.open(sourceName).table<T>(name, pk);
  }

  describe(): Record<string, unknown> {
    return {
      default: this.defaultSource,
      sources: [...this.sources.values()].map((s) => ({
        name: s.name,
        driver: s.driver,
        migrations: s.migrationsApplied.length,
      })),
    };
  }

  closeAll(): void {
    for (const s of this.sources.values()) s.close();
  }
}

export async function applyMigrations(
  host: HostContext,
  db: SqliteDb,
  root: string,
  migrationsDir: string,
): Promise<string[]> {
  const dir = resolveAppPath(root, migrationsDir);
  if (!(await host.exists(dir))) return [];
  const files = (await host.listDir(dir)).filter((f) => f.endsWith(".sql")).sort();
  db.exec(
    `CREATE TABLE IF NOT EXISTS ${MIGRATIONS_TABLE} (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)`,
  );
  const applied = new Set(
    db.all<{ name: string }>(`SELECT name FROM ${MIGRATIONS_TABLE}`).map((r) => r.name),
  );
  const newlyApplied: string[] = [];
  for (const file of files) {
    if (applied.has(file)) continue;
    // Join via `resolveAppPath` (not a literal "/") so the migration file path adopts `dir`'s own
    // separator style; a Windows/UNC-style `dir` (backslashes) would otherwise reintroduce a
    // mixed-separator path (e.g. "C:\\app\\db\\migrations/001.sql") that breaks reads on Windows.
    const sql = await host.readTextFile(resolveAppPath(dir, file));
    // Apply the migration and record it in the ledger atomically. SQLite DDL is
    // transactional, so wrapping both in one BEGIN/COMMIT makes a migration all-or-nothing:
    // either the schema change AND its `_urban_migrations` row commit together, or neither
    // does. Without this, an interruption (or an error later in the file's SQL) can leave the
    // schema changed but the migration unrecorded — which poisons every future boot, because
    // the runner then re-applies the "unapplied" migration and hits e.g. "duplicate column".
    // Migration files must therefore not contain their own transaction-control statements.
    db.exec("BEGIN");
    try {
      db.exec(sql);
      db.run(`INSERT INTO ${MIGRATIONS_TABLE} (name, applied_at) VALUES (?, ?)`, [
        file,
        new Date(host.now()).toISOString(),
      ]);
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw new Error(
        `migration "${file}" failed and was rolled back (no partial schema change, not recorded as applied): ${
          err instanceof Error ? err.message : String(err)
        }`,
        { cause: err },
      );
    }
    newlyApplied.push(file);
  }
  return newlyApplied;
}

async function provisionSqlite(
  ctx: RuntimeContext,
  name: string,
  src: DataSource,
): Promise<ProvisionedSource> {
  let db: SqliteDb;
  try {
    db = await openSqliteSource(ctx.host, ctx.root, src.url);
  } catch (err) {
    // Prefix the source name onto openSqliteSource's runtime-agnostic message.
    throw new Error(`datasource "${name}": ${err instanceof Error ? err.message : String(err)}`);
  }
  const migrationsApplied = src.migrations
    ? await applyMigrations(ctx.host, db, ctx.root, src.migrations)
    : [];
  // Provision the write-provenance sidecar and wire the gateway's insert observer to it, so
  // every app `Table.insert` performed inside a job is linked to its process instance/element
  // (ProcessOS domain-signal capture, D0). Domain-free and non-invasive — the sidecar lives
  // outside the domain model.
  ensureProvenanceTable(db);
  ctx.host.log("info", `datasource: provisioned "${name}"`, {
    driver: "sqlite",
    path: resolveSqlitePath(ctx.root, src.url),
    migrationsApplied,
  });
  return {
    name,
    driver: "sqlite",
    db,
    source: makeGateway(db, makeProvenanceRecorder(ctx.host, db, name)),
    migrationsApplied,
    close: () => db.close(),
  };
}

/** Provision every declared source and return the typed data layer. */
export async function provisionData(ctx: RuntimeContext): Promise<DataLayer> {
  const data = ctx.manifest.data;
  const sources = new Map<string, ProvisionedSource>();
  for (const [name, src] of Object.entries(data?.sources ?? {})) {
    if (src.driver !== "sqlite") {
      throw new Error(
        `data source "${name}" uses driver "${src.driver}"; only "sqlite" is implemented ` +
          `(the driver seam is intentionally open for future drivers)`,
      );
    }
    sources.set(name, await provisionSqlite(ctx, name, src));
  }
  return new DataLayer(sources, data?.default, ctx.manifest.types ?? {});
}
