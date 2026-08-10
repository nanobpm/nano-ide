// A `HostContext` for whole-app e2e tests.
//
// Rather than reimplement the runtime-agnostic capability surface (filesystem,
// SQLite, module import) — which would fork logic across Node and Deno and drift
// from production — the test host *wraps* the real host that `selectHost` picks for
// the current runtime and overrides only the three seams a deterministic, socket-free,
// virtual-clock harness needs:
//
//   • `now`       → reads the harness's virtual clock, so DataLayer timestamps and the
//                   scheduler's clock move in lockstep and never on wall-clock time.
//   • `serveHttp` → captures the router `handler` instead of binding a TCP socket, so the
//                   `ui` driver can invoke routes in-process (no ports, no races).
//   • `log`       → optionally captured for assertions (defaults to the base host's sink).
//
// Everything else (real filesystem, real SQLite via `node:sqlite`, real module import,
// async store for write-provenance) is delegated verbatim to the wrapped host, so the app
// under test exercises the same code paths it does in production. The app's SQLite lives on
// disk under its (typically temporary) root and is discarded with the fixture.

import { selectHost } from "@nanobpm/urban/runtime";
import type { HostContext, HttpHandler, HttpServer } from "@nanobpm/urban/runtime";

/** The captured in-process HTTP entrypoint plus the wrapped host. */
export interface TestHost {
  host: HostContext;
  /** The router handler the runtime mounted, or undefined until `start()` has run. Invoke it
   *  directly to drive routes in-process — no socket is ever opened. */
  handler(): HttpHandler | undefined;
  /** Log lines the app emitted, in order (when capture is enabled). */
  logs: { level: "debug" | "info" | "warn" | "error"; msg: string; fields?: Record<string, unknown> }[];
}

export interface CreateTestHostOptions {
  /** App root the wrapped host resolves files/SQLite/modules against. */
  cwd: string;
  /** Reads the harness's virtual clock (ms since epoch). */
  now: () => number;
  /** Extra environment overlaid on the real environment (overrides win). */
  env?: Record<string, string>;
  /** Capture logs into {@link TestHost.logs} instead of forwarding to the base sink. */
  captureLogs?: boolean;
}

/** Wrap the runtime's real host, overriding only the seams the e2e harness needs. */
export function createTestHost(opts: CreateTestHostOptions): TestHost {
  const base = selectHost({ cwd: opts.cwd });
  let captured: HttpHandler | undefined;
  const logs: TestHost["logs"] = [];
  const envOverlay = opts.env ?? {};

  const host: HostContext = {
    runtime: base.runtime,
    env: (name) =>
      Object.hasOwn(envOverlay, name) ? envOverlay[name] : base.env(name),
    readTextFile: (path) => base.readTextFile(path),
    listDir: (dir) => base.listDir(dir),
    exists: (path) => base.exists(path),
    openSqlite: (path) => base.openSqlite(path),
    importModule: (path) => base.importModule(path),
    // A socket-free HTTP server: keep the mounted router, hand back a handle whose stop()
    // clears the captured handler — so once the app is stopped the in-process server is
    // inert (a route call throws) and its references are released, matching the real host.
    serveHttp: (_port: number, handler: HttpHandler): Promise<HttpServer> => {
      captured = handler;
      return Promise.resolve({
        port: 0,
        stop: () => {
          captured = undefined;
          return Promise.resolve();
        },
      });
    },
    now: () => opts.now(),
    log: (level, msg, fields) => {
      if (opts.captureLogs) logs.push({ level, msg, fields });
      else base.log(level, msg, fields);
    },
  };

  // Preserve the base host's optional capabilities so production code paths (connector
  // worker import, recursive watch, write-provenance async store) behave identically.
  const { importConnectorModule, watch, createAsyncStore } = base;
  if (importConnectorModule) {
    host.importConnectorModule = (entry) => importConnectorModule(entry);
  }
  if (watch) host.watch = (onChange) => watch(onChange);
  if (createAsyncStore) host.createAsyncStore = <T>() => createAsyncStore<T>();

  return {
    host,
    handler: () => captured,
    logs,
  };
}
