// Deno adapter — implements HostContext against the `Deno` global (plus `node:*` compat
// modules Deno supports). This and node.ts are the only files that touch a concrete runtime.
// A minimal ambient `Deno` declaration lets this compile under Node's tsc; at runtime the
// adapter is only ever selected when the real `Deno` global is present (see detect.ts).

import { isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { AsyncLocalStorage } from "node:async_hooks";
import type {
  AsyncStore,
  HostContext,
  HttpHandler,
  HttpRequest,
  HttpServer,
  SqliteDb,
} from "../core/host.ts";
import { resolveModulePath } from "../core/module-path.ts";
import { formatLogRecord, levelEnabled, parseLogLevel } from "../core/logger.ts";

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

interface DenoHttpServer {
  finished: Promise<void>;
  shutdown(): Promise<void>;
}
interface DenoFsWatcher extends AsyncIterable<{ kind: string; paths: string[] }> {
  close(): void;
}
interface DenoGlobal {
  env: { get(name: string): string | undefined };
  cwd(): string;
  readTextFile(path: string): Promise<string>;
  readDir(path: string): AsyncIterable<{ name: string; isFile: boolean }>;
  stat(path: string): Promise<unknown>;
  watchFs(paths: string | string[], options?: { recursive?: boolean }): DenoFsWatcher;
  serve(
    opts: { port: number; hostname?: string; onListen?: (a: { port: number }) => void },
    handler: (req: Request) => Response | Promise<Response>,
  ): DenoHttpServer;
}
declare const Deno: DenoGlobal;

export interface DenoHostOptions {
  cwd?: string;
  log?: HostContext["log"];
  /** See NodeHostOptions.importNonce — appended as `?v=<nonce>` to dynamic imports. */
  importNonce?: string;
}

/** Read `URBAN_LOG_LEVEL` without requiring `--allow-env`. `Deno.env.get` throws when env access is
 *  not granted, but an app that only logs shouldn't be forced to open env permission just to emit a
 *  line — so treat a permission (or any) error as an unset value and let logging fall back to the
 *  default `info` level. Logging must stay safe by default. */
function readLogLevelEnv(): string | undefined {
  try {
    return Deno.env.get("URBAN_LOG_LEVEL");
  } catch {
    return undefined;
  }
}

export function createDenoHost(opts: DenoHostOptions = {}): HostContext {
  const cwd = opts.cwd ?? Deno.cwd();
  const abs = (p: string) => (isAbsolute(p) ? p : resolve(cwd, p));
  const log: HostContext["log"] =
    opts.log ??
    ((level, msg, fields) => {
      if (!levelEnabled(level, parseLogLevel(readLogLevelEnv()))) return;
      // console.* appends the newline; NDJSON stays one object per line. warn/error → stderr.
      const line = formatLogRecord(level, msg, fields, Date.now());
      (level === "warn" || level === "error" ? console.error : console.log)(line);
    });

  return {
    runtime: "deno",
    env: (name) => Deno.env.get(name),
    readTextFile: (p) => Deno.readTextFile(abs(p)),
    async listDir(dir) {
      try {
        const names: string[] = [];
        for await (const e of Deno.readDir(abs(dir))) {
          if (e.isFile) names.push(e.name);
        }
        return names;
      } catch {
        return [];
      }
    },
    async exists(p) {
      try {
        await Deno.stat(abs(p));
        return true;
      } catch {
        return false;
      }
    },
    openSqlite(path) {
      const db = new DatabaseSync(abs(path));
      return wrapSqlite(db);
    },
    importModule: (p) => {
      const resolved = resolveModulePath(abs(p), existsSync);
      const href =
        pathToFileURL(resolved).href + (opts.importNonce ? `?v=${opts.importNonce}` : "");
      const mod: Promise<Record<string, unknown>> = import(href);
      return mod;
    },
    async serveHttp(port, handler, opts) {
      return startDenoServer(port, handler, opts?.hostname);
    },
    watch(onChange) {
      const w = Deno.watchFs(cwd, { recursive: true });
      let closed = false;
      (async () => {
        try {
          for await (const ev of w) {
            for (const p of ev.paths) onChange(p);
          }
        } catch (err) {
          // Deno.watchFs throws when close() is called mid-await — expected on shutdown.
          // Any other failure (permissions, path removed, …) silently disables hot reload,
          // so surface it instead of swallowing it.
          if (!closed) log("warn", "file watch error — hot reload may be disabled", {
            error: String(err),
          });
        }
      })();
      return {
        close: () => {
          if (closed) return;
          closed = true;
          w.close();
        },
      };
    },
    now: () => Date.now(),
    createAsyncStore<T>(): AsyncStore<T> {
      const als = new AsyncLocalStorage<T>();
      return { run: <R>(value: T, fn: () => R): R => als.run(value, fn), current: () => als.getStore() };
    },
    log,
  };
}

function wrapSqlite(db: DatabaseSync): SqliteDb {
  return {
    exec: (sql) => db.exec(sql),
    run: (sql, params = []) => {
      const stmt = db.prepare(sql);
      const r = stmt.run(...sqliteParams(params));
      return { changes: Number(r.changes), lastInsertRowid: r.lastInsertRowid };
    },
    all: <T>(sql: string, params: unknown[] = []) => {
      const stmt = db.prepare(sql);
      // biome-ignore lint/plugin: Deno sqlite returns untyped row objects; SqliteDb.all<T> is the host adapter boundary.
      return stmt.all(...sqliteParams(params)) as T[];
    },
    close: () => db.close(),
  };
}

function startDenoServer(
  port: number,
  handler: HttpHandler,
  hostname?: string,
): Promise<HttpServer> {
  return new Promise<HttpServer>((resolveServer) => {
    const server = Deno.serve({ port, hostname, onListen: ({ port: p }) => {
      resolveServer({
        port: p,
        stop: () => server.shutdown(),
      });
    } }, async (request: Request): Promise<Response> => {
      const url = new URL(request.url);
      const bodyText = request.body ? await request.text() : "";
      const req: HttpRequest = {
        method: request.method,
        path: url.pathname,
        query: url.searchParams,
        headers: request.headers,
        text: () => Promise.resolve(bodyText),
      };
      const res = await handler(req);
      return new Response(res.body ?? "", { status: res.status ?? 200, headers: res.headers });
    });
  });
}
