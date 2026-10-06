// dataops — the DB-manager op protocol behind `urban data`. A single JSON request is
// dispatched against a manifest datasource and a single JSON result is returned; the CLI
// (`urban data`, cli.ts) wraps it in the `{ ok, ... }` stdin/stdout envelope. This is the
// runtime-agnostic core the Nano console re-points its **Data** panel (Tables / SQL /
// Migrations) at, replacing the vendored `nano-generated/data-cli.ts` (host dry-out #576).
//
// Every op runs THROUGH the same datasource seam the app runtime uses (`openSqliteSource` +
// `makeGateway`), so the panel browses exactly what the named source resolves to — never a
// parallel path. Read/list ops open the source WITHOUT applying migrations (opening the DB
// manager must not silently mutate the schema); `migrate` applies pending migrations on the
// shared `_urban_migrations` ledger.
//
//   Request:  { op, source?, sql?, params?, statements? }
//   op = "sources" | "schema" | "query" | "exec" | "script" | "migrations" | "migrate"
//      | "domaintypes"
//
// `domaintypes` (live-schema reification + shape resolution) composes the domain reifier from the
// pure toolkit derivers (ported from the console's `domain_types.ts`, host dry-out #576); it never
// writes files (the host is read-only) — it returns every artifact's content and the caller
// persists it.

import type { HostContext, SqliteDb } from "../host.ts";
import { isRecord } from "../guards.ts";
import type { AppManifest, DataSource as ManifestDataSource } from "../manifest.ts";
import { loadManifest } from "../manifest.ts";
import { validateManifest } from "../validate.ts";
import { makeGateway, type DataSource as GatewayDataSource } from "./gateway.ts";
import { applyMigrations, MIGRATIONS_TABLE, openSqliteSource, resolveAppPath } from "./datasource.ts";
// The `domaintypes` op composes the domain reifier from the pure toolkit derivers (single source of
// truth for the IDE's codegen, host dry-out nano-bpm#576). They are imported lazily inside the
// `domaintypes` case — a static import would make EVERY `urban data` op (the latency-sensitive
// gateway path, nano-ide#592) load the whole `src/toolkit/` tree before dispatching, when only
// `domaintypes` ever runs a deriver. The derivers are pure (no host-specific IO); their only core
// dependency is the gateway's `TableMeta`/`ColumnMeta` *types*, which erase. The deriver *types* the
// request carries are type-only imports (erased), so they cost nothing at module load.
import type { DomainTypeDef, DomainTypeRegistry, SourceSchema } from "../../../toolkit/derivers/domain.ts";
import type { FusedMetaDecl, ShapeDecl } from "../../../toolkit/derivers/shapes.ts";
import type { WorkerBindingDecl } from "../../../toolkit/derivers/worker-io.ts";
import type { MessageBindingDecl } from "../../../toolkit/derivers/messages.ts";
import type { MetaDecl } from "../../../toolkit/derivers/meta.ts";

/** The DB-manager op protocol's known op set — every op (including `domaintypes`) is dispatched by
 * `runDataOp`. Typing `op` as this union (instead of `string`) gives SDK/console callers type-safety
 * and catches typos at compile time. */
export type DataOp =
  | "sources"
  | "schema"
  | "query"
  | "exec"
  | "script"
  | "migrations"
  | "migrate"
  | "domaintypes";

export interface DataRequest {
  op: DataOp;
  source?: string;
  sql?: string;
  params?: unknown[];
  statements?: string[];
  /**
   * `domaintypes`: persist the derived artifacts (default true). A `write:false` request is the
   * latency-sensitive composer preview — it introspects WITHOUT migrating the DB first and returns
   * only the artifact *content* (never a DB side-effect per keystroke). `urban data` never writes
   * files itself (the host is read-only); the caller persists the returned content when `write` is
   * not false. This flag only gates the pre-introspection migration side-effect.
   */
  write?: boolean;
  /** `domaintypes`: the model-derived worker-IO map (`taskType → {in,out,headerKeys}`), scanned
   * from the process models by the caller. Overlaid on the manifest `workers[]` (authoritative for
   * the envelope). Absent → the manifest projection alone. */
  derivedWorkers?: WorkerBindingDecl[];
  /** `domaintypes`: the model-derived message-payload map (`messageName → {in,out}`), scanned from
   * the models' `bpmn:message` envelopes. Authoritative (no manifest projection). */
  derivedMessages?: MessageBindingDecl[];
  /** `domaintypes`: the model-derived composed shapes (`nano:shape`). Each is resolved through the
   * fuse into a flat domain type folded into the `types` registry. Absent → no shapes. */
  derivedShapes?: ShapeDecl[];
  /** `domaintypes`: the model-derived model-level metadata (`nano:meta`). Folded into `meta.ts` and
   * the structured `domain.json`. Absent → no metadata. */
  derivedMeta?: MetaDecl[];
}

/** One datasource the manifest declares, resolved against the environment (env templates in
 * `driver`/`url` are already expanded by `loadManifest`). Mirrors the console's `ResolvedSource`
 * so the panel's datasource picker is unchanged. */
export interface ResolvedSource {
  name: string;
  driver: string;
  url: string;
  migrations?: string;
}

const DEFAULT_MIGRATIONS_DIR = "db/migrations";

/** JSON-safe a value: BigInt → number (when lossless) or string, recursing objects/arrays. SQLite
 * reports `lastInsertRowid` (and INTEGER columns) as BigInt, which `JSON.stringify` cannot encode. */
export function jsonSafe(v: unknown): unknown {
  if (typeof v === "bigint") {
    return v >= BigInt(Number.MIN_SAFE_INTEGER) && v <= BigInt(Number.MAX_SAFE_INTEGER)
      ? Number(v)
      : v.toString();
  }
  if (Array.isArray(v)) return v.map(jsonSafe);
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v)) out[k] = jsonSafe(val);
    return out;
  }
  return v;
}

/** Column order across a row set: first-seen order, unioned over every row (rows may be ragged). */
function columnsOf(rows: Record<string, unknown>[]): string[] {
  const seen = new Set<string>();
  const cols: string[] = [];
  for (const r of rows) {
    for (const k of Object.keys(r)) {
      if (!seen.has(k)) {
        seen.add(k);
        cols.push(k);
      }
    }
  }
  return cols;
}

/** Split a script on `;` boundaries, dropping blank and comment-only fragments. Minimal DDL
 * splitter (ADR 0024 "minimal dialect stance"); does not parse semicolons inside string literals. */
function splitStatements(sql: string): string[] {
  return sql
    .split(";")
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && !s.split("\n").every((l) => l.trim().startsWith("--")));
}

/** List every declared datasource plus the default's name (no connection opened). */
export function listSources(manifest: AppManifest): { default?: string; sources: ResolvedSource[] } {
  const data = manifest.data;
  const sources: ResolvedSource[] = Object.entries(data?.sources ?? {}).map(([name, raw]) => ({
    name,
    driver: String(raw.driver),
    url: raw.url,
    migrations: raw.migrations,
  }));
  return { default: data?.default, sources };
}

/** Resolve the source a request names (the default, or the sole source, when unnamed). */
function pickSource(manifest: AppManifest, name?: string): { name: string; src: ManifestDataSource } {
  const data = manifest.data;
  const sources = data?.sources ?? {};
  const chosen = name || data?.default || Object.keys(sources)[0];
  if (!chosen) throw new Error("no data source specified and none declared in the manifest");
  const src = sources[chosen];
  if (!src) throw new Error(`no such data source "${chosen}"`);
  return { name: chosen, src };
}

/** Open the requested source's gateway WITHOUT applying migrations (opening the DB manager must
 * not mutate the schema). The caller closes the returned handle. */
async function openGateway(
  host: HostContext,
  root: string,
  manifest: AppManifest,
  name?: string,
): Promise<{ gw: GatewayDataSource; db: SqliteDb }> {
  const { name: chosen, src } = pickSource(manifest, name);
  if (String(src.driver) !== "sqlite") {
    throw new Error(
      `data source "${chosen}" uses driver "${String(src.driver)}"; only "sqlite" is implemented`,
    );
  }
  let db: SqliteDb;
  try {
    db = await openSqliteSource(host, root, src.url);
  } catch (err) {
    // Prefix the source name onto openSqliteSource's runtime-agnostic message so the CLI/console
    // error names which datasource failed (mirrors provisionSqlite).
    throw new Error(`datasource "${chosen}": ${err instanceof Error ? err.message : String(err)}`);
  }
  return { gw: makeGateway(db), db };
}

/**
 * Resolve a `--manifest` argument against the app `root`. An absolute path (POSIX `/abs/…`, a
 * Windows drive-letter `C:\…` or a UNC `\\host\share\…`) is honoured as-is; a relative path is
 * joined onto `root`. Delegates to `resolveAppPath` so manifest and datasource path resolution
 * share one cross-platform implementation and can't drift.
 */
function resolveManifestPath(root: string, manifestPath: string): string {
  return resolveAppPath(root, manifestPath);
}

/**
 * Dispatch one DB-manager op against the app at `root`. Returns the op's result object (the CLI
 * wraps it as `{ ok: true, ...result }`); throws on a handled error (wrapped as `{ ok: false }`).
 */
export async function runDataOp(
  host: HostContext,
  root: string,
  manifestPath: string,
  req: DataRequest,
): Promise<Record<string, unknown>> {
  const manifest = validateManifest(
    await loadManifest(host, resolveManifestPath(root, manifestPath)),
  );

  switch (req.op) {
    case "sources": {
      const { sources, default: def } = listSources(manifest);
      return { default: def, sources };
    }
    case "schema": {
      const { gw, db } = await openGateway(host, root, manifest, req.source);
      try {
        return { tables: await gw.schema() };
      } finally {
        db.close();
      }
    }
    case "query": {
      const { gw, db } = await openGateway(host, root, manifest, req.source);
      try {
        const rows: Record<string, unknown>[] = await gw.query(req.sql ?? "", req.params ?? []);
        const safeRows: unknown[] = rows.map(jsonSafe);
        return { columns: columnsOf(rows), rows: safeRows };
      } finally {
        db.close();
      }
    }
    case "exec": {
      const { gw, db } = await openGateway(host, root, manifest, req.source);
      try {
        const result = jsonSafe(await gw.exec(req.sql ?? "", req.params ?? []));
        return isRecord(result) ? result : {};
      } finally {
        db.close();
      }
    }
    case "script": {
      // Run several statements atomically in one transaction — the console's structure editor
      // uses this for the SQLite 12-step table rebuild (create → copy → drop → rename), so a
      // mid-rebuild failure rolls back and leaves the table untouched. Statements come pre-split
      // from the caller; `?`-params are not threaded (DDL needs none).
      const { gw, db } = await openGateway(host, root, manifest, req.source);
      try {
        const statements = Array.isArray(req.statements)
          ? req.statements
          : splitStatements(req.sql ?? "");
        let changed = 0;
        await gw.tx(async (t) => {
          for (const stmt of statements) {
            if (stmt.trim()) changed += (await t.exec(stmt)).changed;
          }
        });
        return { changed };
      } finally {
        db.close();
      }
    }
    case "migrations": {
      const { name, src } = pickSource(manifest, req.source);
      const relDir = src.migrations ?? DEFAULT_MIGRATIONS_DIR;
      const absDir = resolveAppPath(root, relDir);
      // `migrations` is a read/list op: treat a missing dir as no migrations (mirrors
      // applyMigrations) instead of throwing on host.listDir.
      const files = (await host.exists(absDir))
        ? (await host.listDir(absDir)).filter((f) => f.endsWith(".sql")).sort()
        : [];
      const { gw, db } = await openGateway(host, root, manifest, name);
      try {
        // Do not create the ledger table here — listing migrations must not mutate the
        // schema. If the ledger doesn't exist yet, nothing has been applied.
        const ledgerExists =
          (
            await gw.query(
              `SELECT name FROM sqlite_master WHERE type='table' AND name='${MIGRATIONS_TABLE}'`,
            )
          ).length > 0;
        const applied = ledgerExists
          ? new Map<string, string>(
              (await gw.query(`SELECT name, applied_at FROM ${MIGRATIONS_TABLE}`)).map((r) => [
                String(r.name),
                String(r.applied_at),
              ]),
            )
          : new Map<string, string>();
        return {
          dir: relDir,
          entries: files.map((name) => ({
            name,
            applied: applied.has(name),
            appliedAt: applied.get(name) ?? null,
          })),
        };
      } finally {
        db.close();
      }
    }
    case "migrate": {
      const { name, src } = pickSource(manifest, req.source);
      const { db } = await openGateway(host, root, manifest, name);
      try {
        const applied = await applyMigrations(
          host,
          db,
          root,
          src.migrations ?? DEFAULT_MIGRATIONS_DIR,
        );
        return { applied, pending: 0 };
      } finally {
        db.close();
      }
    }
    case "domaintypes": {
      // ADR 0029 §4.1/§4.2/§6 + ADR 0040 §9/§10: reify the domain model from the *live* schema.
      // Union every declared datasource (the table spine), fold in the manifest `types` registry and
      // the model's composed `nano:shape`s (resolved through the fuse), and derive the worker/message
      // typed accessors. Unlike the vendored data_cli, this op NEVER writes files (the host is
      // read-only): it returns every artifact's content and the caller persists it. `write:false` is
      // the latency-sensitive composer preview — it skips the pre-introspection migration so a
      // debounced keystroke has no DB side-effect and pays only for `text` + `shapeDiagnostics`.
      const { default: def, sources } = listSources(manifest);
      const persist = req.write !== false;
      // The derivers are the only toolkit modules `urban data` ever needs, and only this op runs
      // them — load them here, not at module scope, so every other op (the hot path of the data
      // gateway, nano-ide#592) never pays for the `src/toolkit/` tree. Imported directly from the
      // deriver files (not the `toolkit/` barrel, which pulls the Node fs IO) so core stays free
      // of host-specific IO.
      const { GENERATED_DIR } = await import("../../../toolkit/artifact.ts");
      const {
        DOMAIN_BINDINGS,
        emitDomainBindings,
        emitDomainModel,
        registryFromManifest,
      } = await import("../../../toolkit/derivers/domain.ts");
      const { DOMAIN_MODEL_JSON, emitDomainModelJson, resolveShapes } = await import(
        "../../../toolkit/derivers/shapes.ts"
      );
      const {
        DOMAIN_DTS,
        emitWorkerBindings,
        emitWorkerBindingsRuntime,
        overlayDerivedWorkerIo,
        WORKER_BINDINGS_DTS,
        WORKER_BINDINGS_TS,
      } = await import("../../../toolkit/derivers/worker-io.ts");
      const {
        emitMessageBindings,
        emitMessageBindingsRuntime,
        MESSAGE_BINDINGS_DTS,
        MESSAGE_BINDINGS_TS,
      } = await import("../../../toolkit/derivers/messages.ts");
      const { emitMeta, META_TS } = await import("../../../toolkit/derivers/meta.ts");
      // Introspect each sqlite source's live schema. When persisting, migrate first (the domain
      // model is derived from `gw.schema()`, so a regen that raced ahead of `migrate` on a fresh DB
      // would emit an empty `Domain`); the migration runs on the shared `_urban_migrations` ledger.
      const migrated: Record<string, string[]> = {};
      const schemas: SourceSchema[] = [];
      for (const s of sources) {
        if (String(s.driver) !== "sqlite") continue; // only sqlite is introspectable (see openGateway)
        const { gw, db } = await openGateway(host, root, manifest, s.name);
        try {
          if (persist) {
            const applied = await applyMigrations(
              host,
              db,
              root,
              s.migrations ?? DEFAULT_MIGRATIONS_DIR,
            );
            if (applied.length) migrated[s.name] = applied;
          }
          schemas.push({ source: s.name, tables: await gw.schema() });
        } finally {
          db.close();
        }
      }

      const types = registryFromManifest(manifest);
      // Snapshot the manifest `types` *before* folding the resolved shapes so `domain.json` can tag
      // each entity with its true provenance (manifest vs model) — once folded they are
      // indistinguishable in `types`.
      const manifestTypesSnapshot: DomainTypeRegistry = { ...types };
      // Composed motion shapes (ADR 0040 §9/§10): resolve each `nano:shape` against the leaf fuse
      // into a flat domain type and fold it into the registry *before* it feeds the domain model and
      // the worker/message bindings, so a composed shape becomes a first-class `DomainTypes` entry.
      // Broken shapes are omitted; their diagnostics are returned so the panel can surface them.
      const shapeResolution = resolveShapes(req.derivedShapes ?? [], types, schemas);
      const shapeDeclById = new Map((req.derivedShapes ?? []).map((s) => [s.id, s]));
      const shapeEntities: { decl: ShapeDecl; def: DomainTypeDef }[] = [];
      for (const [id, shapeDef] of Object.entries(shapeResolution.types)) {
        types[id] = shapeDef;
        shapeEntities.push({ decl: shapeDeclById.get(id) ?? { id, ops: [] }, def: shapeDef });
      }
      const declaredIds = Object.keys(types);

      const text = emitDomainModel(schemas, def, types);
      const bindings = emitDomainBindings(schemas, def);
      const derivedMeta: MetaDecl[] = req.derivedMeta ?? [];
      const metaAccessor = emitMeta(derivedMeta);
      // Worker-IO map (ADR 0033 §3): the model is authoritative for the envelope, so an injected
      // `derivedWorkers` is overlaid on the manifest `workers[]` (which still carries non-IO
      // bindings such as `llm`); absent, the manifest projection stands alone.
      const manifestWorkers: WorkerBindingDecl[] = (manifest.workers ?? []).map((w) => ({
        taskType: w.taskType,
        inputType: w.inputType,
        outputType: w.outputType,
      }));
      const workers = req.derivedWorkers
        ? overlayDerivedWorkerIo(manifestWorkers, req.derivedWorkers)
        : manifestWorkers;
      const workerBindings = emitWorkerBindings(workers, declaredIds);
      const workerRuntime = emitWorkerBindingsRuntime();
      // Message-payload registry (ADR 0040 slice 2): no manifest projection, so the model-derived
      // map is authoritative and emitted directly.
      const messages = req.derivedMessages ?? [];
      const messageBindings = emitMessageBindings(messages, declaredIds);
      const messageRuntime = emitMessageBindingsRuntime();
      // The structured Fused Domain Model (`domain.json`, ADR 0040 §1): the largest artifact, so it
      // is built only when persisting (the preview consumes only `text` + `shapeDiagnostics`).
      const meta: FusedMetaDecl[] = derivedMeta;
      const domainModel = persist
        ? emitDomainModelJson({
            sources: schemas,
            default: def,
            manifestTypes: manifestTypesSnapshot,
            shapes: shapeEntities,
            meta,
            diagnostics: shapeResolution.diagnostics,
          })
        : null;

      const rel = (name: string): string => `${GENERATED_DIR}/${name}`;
      const tables = schemas.reduce((n, s) => n + s.tables.length, 0);
      // The returned `*Path` fields are the app-relative targets the caller writes to when
      // persisting (null on a preview). `urban data` returns content only — persisting is the
      // caller's job (host dry-out nano-bpm#576). The static runtime wrappers (`workers.ts`,
      // `messages.ts`) are returned too so the caller can write them verbatim.
      return {
        path: persist ? rel(DOMAIN_DTS) : null,
        text,
        tables,
        bindingsPath: persist ? rel(DOMAIN_BINDINGS) : null,
        bindings,
        workerBindingsPath: persist ? rel(WORKER_BINDINGS_DTS) : null,
        workerBindings,
        workerRuntimePath: persist ? rel(WORKER_BINDINGS_TS) : null,
        workerRuntime,
        messageBindingsPath: persist ? rel(MESSAGE_BINDINGS_DTS) : null,
        messageBindings,
        messageRuntimePath: persist ? rel(MESSAGE_BINDINGS_TS) : null,
        messageRuntime,
        metaPath: persist ? rel(META_TS) : null,
        meta: metaAccessor,
        domainModelPath: persist ? rel(DOMAIN_MODEL_JSON) : null,
        domainModel,
        migrated,
        shapeDiagnostics: shapeResolution.diagnostics,
      };
    }
    default:
      throw new Error(`unknown op "${req.op}"`);
  }
}
