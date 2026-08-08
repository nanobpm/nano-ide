// Node adapter — implements HostContext against `node:*`. This is one of only two files
// (with deno.ts) allowed to touch a concrete runtime.

import { readFile, readdir, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { watch as fsWatch, type FSWatcher } from "node:fs";
import { createServer } from "node:http";
import { register } from "node:module";
import { isAbsolute, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { AsyncLocalStorage } from "node:async_hooks";
import type {
  AsyncStore,
  HostContext,
  HttpHandler,
  HttpRequest,
  HttpServer,
  SqliteDb,
  WatchHandle,
} from "../core/host.ts";

type SqliteParam = string | number | bigint | Uint8Array | null;

function sqliteParams(params: unknown[]): SqliteParam[] {
  return params.map((param) => {
    if (
      param === null ||
      typeof param === "string" ||
      typeof param === "number" ||
      typeof param === "bigint" ||
      param instanceof Uint8Array
    ) {
      return param;
    }
    if (typeof param === "boolean") return param ? 1 : 0;
    throw new TypeError(`unsupported SQLite parameter type: ${typeof param}`);
  });
}

export interface NodeHostOptions {
  /** Base directory relative paths resolve against. Default process.cwd(). */
  cwd?: string;
  log?: HostContext["log"];
  /**
   * When set, appended as a `?v=<nonce>` query to dynamic import URLs so a changed
   * handler/worker module is re-evaluated instead of served from the ESM cache. The
   * dev server bumps this on every reload; production leaves it unset.
   */
  importNonce?: string;
}

/** Resolve the in-process `@nanobpm/worker` shim URL relative to this adapter,
 *  tolerating both the compiled package (`.js`, the published/`urban run` path)
 *  and a from-source run (`.ts`). */
function connectorShimUrl(): string {
  const js = new URL("../connector-worker-sdk.js", import.meta.url);
  if (existsSync(fileURLToPath(js))) return js.href;
  return new URL("../connector-worker-sdk.ts", import.meta.url).href;
}

let connectorHooksRegistered = false;

/**
 * Register (once per process) the ESM customization hooks that let a connector
 * pack's worker `entry` be imported in-process (ADR 0050, in-process port):
 *   - a **resolve** hook aliasing the bare `@nanobpm/worker` specifier the pack
 *     imports to the runtime's shim, so its `defineWorker(...)` registers into the
 *     registry the runtime drains;
 *   - a **load** hook that strips TypeScript from ANY `.ts` module resolved under
 *     `node_modules` (Node refuses to type-strip there by default). In practice
 *     only a connector pack's `.ts` entry and its `.ts` imports travel this path,
 *     but the hook is process-global once registered, so it applies to every
 *     subsequent `node_modules` `.ts` import — a safe superset (Node would
 *     otherwise throw on such a file). The module's real URL is preserved so its
 *     own bare imports (npm deps) still resolve.
 * The hooks run on a separate thread, so the shim URL is baked into the hook
 * source; the shim itself loads on the main thread (shared registry instance).
 */
function ensureConnectorHooks(): void {
  if (connectorHooksRegistered) return;
  const shim = JSON.stringify(connectorShimUrl());
  const src =
    `import { readFileSync } from "node:fs";\n` +
    `import { fileURLToPath } from "node:url";\n` +
    `import { stripTypeScriptTypes } from "node:module";\n` +
    `const SHIM = ${shim};\n` +
    `export async function resolve(spec, ctx, next) {\n` +
    `  if (spec === "@nanobpm/worker") return { url: SHIM, shortCircuit: true };\n` +
    `  return next(spec, ctx);\n` +
    `}\n` +
    `export async function load(url, ctx, next) {\n` +
    `  const path = url.split("?")[0];\n` +
    `  if (path.endsWith(".ts") && path.includes("/node_modules/")) {\n` +
    `    const source = stripTypeScriptTypes(readFileSync(fileURLToPath(path), "utf8"), { mode: "strip" });\n` +
    `    return { format: "module", source, shortCircuit: true };\n` +
    `  }\n` +
    `  return next(url, ctx);\n` +
    `}\n`;
  register("data:text/javascript," + encodeURIComponent(src));
  connectorHooksRegistered = true;
}

export function createNodeHost(opts: NodeHostOptions = {}): HostContext {
  const cwd = opts.cwd ?? process.cwd();
  const abs = (p: string) => (isAbsolute(p) ? p : resolve(cwd, p));
  const log: HostContext["log"] =
    opts.log ??
    ((level, msg, fields) => {
      const line = fields ? `${msg} ${JSON.stringify(fields)}` : msg;
      (level === "error" ? console.error : level === "warn" ? console.warn : console.log)(
        `[urban] ${line}`,
      );
    });

  return {
    runtime: "node",
    env: (name) => process.env[name],
    readTextFile: (p) => readFile(abs(p), "utf8"),
    async listDir(dir) {
      try {
        const entries = await readdir(abs(dir), { withFileTypes: true });
        return entries.filter((e) => e.isFile()).map((e) => e.name);
      } catch {
        return [];
      }
    },
    async exists(p) {
      try {
        await stat(abs(p));
        return true;
      } catch {
        return false;
      }
    },
    openSqlite(path) {
      const db = new DatabaseSync(abs(path));
      return wrapNodeSqlite(db);
    },
    importModule: (p) => {
      const href =
        pathToFileURL(abs(p)).href + (opts.importNonce ? `?v=${opts.importNonce}` : "");
      const mod: Promise<Record<string, unknown>> = import(href);
      return mod;
    },
    async importConnectorModule(entry) {
      ensureConnectorHooks();
      // Import for side effects only: the pack's top-level `defineWorker(...)` runs
      // and registers into the shim registry, which the caller drains. Apply the
      // dev `importNonce` cache-buster (as importModule does) so a hot-reloaded
      // pack entry is re-evaluated instead of served stale from the ESM cache.
      const href =
        pathToFileURL(abs(entry)).href + (opts.importNonce ? `?v=${opts.importNonce}` : "");
      await import(href);
    },
    async serveHttp(port, handler) {
      return await startNodeServer(port, handler);
    },
    watch(onChange) {
      const onFsEvent = (_event: unknown, filename: string | Buffer | null) => {
        if (filename) onChange(String(filename));
      };
      // Recursive watch is supported on macOS, Windows, and — since Node 19.1.0 — Linux.
      // This package requires Node >=22.6, so the recursive path is available on all three;
      // the try/catch only trips on an unusual platform, where we degrade honestly to a
      // non-recursive root watch (and warn) rather than silently miss nested changes.
      let w: FSWatcher;
      try {
        w = fsWatch(cwd, { recursive: true }, onFsEvent);
      } catch (err) {
        log("warn", "recursive file watch unavailable — nested changes may be missed", {
          error: String(err),
        });
        w = fsWatch(cwd, onFsEvent);
      }
      // A watcher error (e.g. the dir is removed) must not crash the dev server.
      w.on("error", (err) => log("warn", "file watch error", { error: String(err) }));
      return { close: () => w.close() } satisfies WatchHandle;
    },
    now: () => Date.now(),
    createAsyncStore<T>(): AsyncStore<T> {
      const als = new AsyncLocalStorage<T>();
      return { run: <R>(value: T, fn: () => R): R => als.run(value, fn), current: () => als.getStore() };
    },
    log,
  };
}

function wrapNodeSqlite(db: DatabaseSync): SqliteDb {
  return {
    exec: (sql) => db.exec(sql),
    run: (sql, params = []) => {
      const stmt = db.prepare(sql);
      const r = stmt.run(...sqliteParams(params));
      return { changes: Number(r.changes), lastInsertRowid: r.lastInsertRowid };
    },
    all: <T>(sql: string, params: unknown[] = []) => {
      const stmt = db.prepare(sql);
      // biome-ignore lint/plugin: Node sqlite returns untyped row objects; SqliteDb.all<T> is the host adapter boundary.
      return stmt.all(...sqliteParams(params)) as T[];
    },
    close: () => db.close(),
  };
}

async function startNodeServer(port: number, handler: HttpHandler): Promise<HttpServer> {
  const server = createServer(async (nreq, nres) => {
    const chunks: Buffer[] = [];
    for await (const c of nreq) {
      if (Buffer.isBuffer(c)) chunks.push(c);
      else chunks.push(Buffer.from(c));
    }
    const bodyText = Buffer.concat(chunks).toString("utf8");
    const url = new URL(nreq.url ?? "/", "http://localhost");
    const headers = new Headers();
    for (const [k, v] of Object.entries(nreq.headers)) {
      if (typeof v === "string") headers.set(k, v);
      else if (Array.isArray(v)) headers.set(k, v.join(", "));
    }
    const req: HttpRequest = {
      method: nreq.method ?? "GET",
      path: url.pathname,
      query: url.searchParams,
      headers,
      text: () => Promise.resolve(bodyText),
    };
    try {
      const res = await handler(req);
      nres.statusCode = res.status ?? 200;
      for (const [k, v] of Object.entries(res.headers ?? {})) nres.setHeader(k, v);
      nres.end(res.body ?? "");
    } catch (err) {
      nres.statusCode = 500;
      nres.end(String(err));
    }
  });
  await new Promise<void>((res) => server.listen(port, res));
  const addr = server.address();
  const actualPort = typeof addr === "object" && addr ? addr.port : port;
  return {
    port: actualPort,
    stop: () => new Promise<void>((res) => server.close(() => res())),
  };
}
