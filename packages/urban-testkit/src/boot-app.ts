// `bootTestApp` — boot a whole Urban app in-process for e2e tests (issue #157, S2).
//
// It wires three test doubles into the runtime's dependency-injection seam and returns a
// harness with four surfaces (processes, SQLite, workers, HTTP/UI) plus a deterministic
// `settle`/`advanceTime` control over time:
//
//   • engine    → the WASM `EngineClient` (S1). In-memory, synchronous, no broker.
//   • host      → the real runtime host with only `serveHttp`/`now` overridden
//                 (`createTestHost`): routes mount in-process (no socket), and the app's
//                 clock reads a virtual clock.
//   • scheduler → a `ManualScheduler`: the cron-trigger and instance-tracking reconciler
//                 loops advance only when the test author calls `advanceTime`, never on
//                 wall-clock time.
//
// The whole point is determinism: no ports, no wall clock, no polling races — the exact
// class of flakiness that made "converging all day" reconcile bugs so hard to pin down.

import { createUrbanApp, type UrbanApp } from "@nanobpm/urban/runtime";
import type { DataLayer, HttpResponse } from "@nanobpm/urban/runtime";
import { createManualScheduler, type ManualScheduler } from "./manual-scheduler.ts";
import {
  type ApiDriver,
  type ApiOperation,
  type ApiResponse,
  collectOperations,
  createApiDriver,
  type DriverRouteRequest,
  parseOpenApi,
} from "./openapi-driver.ts";
import { createTestHost, type TestHost } from "./test-host.ts";
import { createWasmEngineClient, type WasmEngineClient } from "./wasm-engine.ts";
import { SurfaceCoverage } from "./coverage.ts";

/** A route invocation against the in-process router (no socket is opened). */
export interface RouteRequest {
  method: string;
  /** Path portion of the URL, e.g. "/tasks" or "/hooks/order". */
  path: string;
  /** Query parameters, as a record or a prebuilt `URLSearchParams`. */
  query?: Record<string, string> | URLSearchParams;
  /** Request headers, as a record or a prebuilt `Headers`. */
  headers?: Record<string, string> | Headers;
  /** Raw request body text. */
  body?: string;
}

/** Drives the app's mounted routes in-process. */
export interface UiDriver {
  /** Invoke a mounted route directly and return its response. Throws if the app has not
   *  been started (no router mounted yet). */
  call(req: RouteRequest): Promise<HttpResponse>;
}

/** Options for {@link bootTestApp}. */
export interface BootTestAppOptions {
  /** Manifest filename relative to `root` (default "nano.app.json"). */
  manifestPath?: string;
  /** Environment overlaid on the real environment for the app under test. */
  env?: Record<string, string>;
  /** Capture the app's log output into {@link TestApp.logs} instead of the console. */
  captureLogs?: boolean;
  /** Seed the app's data layer after `start()` (before the first `settle`). Receives the
   *  provisioned {@link DataLayer}; may be async. */
  seed?: (db: DataLayer) => void | Promise<void>;
  /**
   * Enable the coverage-exhaustive gate (S4). When set, {@link TestApp.coverage} is a
   * {@link SurfaceCoverage} pre-declared with the app's surfaces derived from its manifest
   * + OpenAPI spec ("operations", "workers"), recording hits automatically as the test
   * drives the `api` operations and the engine runs jobs. Call
   * `app.coverage.assertFullCoverage()` at the end of a test to fail on any un-exercised
   * declared element. Off by default (zero overhead when unused).
   */
  coverage?: boolean;
}

/** The booted app harness returned by {@link bootTestApp}. */
export interface TestApp {
  /** The underlying runtime app (manifest, inspect, lifecycle). */
  readonly app: UrbanApp;
  /** The WASM engine backing the app — exposes `snapshot`, `now`, `advanceTime`. */
  readonly engine: WasmEngineClient;
  /** The provisioned data layer (seed/query the app's SQLite through this). */
  readonly db: DataLayer;
  /** Drive mounted HTTP routes in-process. */
  readonly ui: UiDriver;
  /**
   * Drive the app's OpenAPI operations by `operationId`, derived from the app's own spec (ADR 0059).
   * Undefined when the app declares no `api` binding — guard with `if (app.api)` for a generic
   * harness, or assert its presence in an app-specific e2e.
   */
  readonly api: ApiDriver | undefined;
  /**
   * Call a raw route (page action, hook, or any exact path) and get a response-parsed result — a
   * thin wrapper over {@link UiDriver.call}. Available whether or not the app has an `api` binding.
   */
  callRoute<T = unknown>(req: RouteRequest): Promise<ApiResponse<T>>;
  /** The virtual-clock scheduler driving the app's background loops. */
  readonly scheduler: ManualScheduler;
  /**
   * The coverage-exhaustive gate (S4), present only when `bootTestApp` was called with
   * `{ coverage: true }`. Pre-declared with the app's "operations" (from its OpenAPI spec)
   * and "workers" (from its manifest) surfaces; hits are recorded automatically as the
   * test drives `api` operations and the engine runs jobs. Call
   * `coverage.assertFullCoverage()` to fail on any un-exercised declared element.
   */
  readonly coverage?: SurfaceCoverage;
  /** Captured log lines (empty unless `captureLogs` was set). */
  readonly logs: TestHost["logs"];
  /** Current virtual time (ms since epoch). */
  now(): number;
  /** The engine's parsed process snapshot. */
  snapshot(): Record<string, unknown>;
  /**
   * Drive the app to a quiescent fixpoint *at the current virtual time*: drain the engine's
   * workers and fire every scheduler timer already due, repeating until neither dispatches
   * more work. Does NOT advance the clock — time only moves via {@link advanceTime}, so a
   * self-rescheduling poll can never spin `settle` forever.
   */
  settle(): Promise<void>;
  /**
   * Advance the virtual clock by `ms`, moving the engine's timers and the scheduler's timers
   * in lockstep (engine BPMN timers first, then the due background-loop timers), then settle
   * to a fixpoint. This is the only way time moves — the explicit, deterministic replacement
   * for waiting on a 15s reconciler poll.
   */
  advanceTime(ms: number): Promise<void>;
  /** Tear down: stop the app (unsubscribe workers, close DB, close engine). */
  stop(): Promise<void>;
}

function toSearchParams(query: RouteRequest["query"]): URLSearchParams {
  if (query instanceof URLSearchParams) return query;
  return new URLSearchParams(query ?? {});
}

function toHeaders(headers: RouteRequest["headers"]): Headers {
  if (headers instanceof Headers) return headers;
  return new Headers(headers ?? {});
}

/** Read the `api.spec` path from a manifest, guarded (mirrors urban's `readApiBinding`: an `api`
 *  block with a non-empty string `spec`). Returns undefined when the app declares no api surface. */
function readApiSpecPath(manifest: unknown): string | undefined {
  if (!manifest || typeof manifest !== "object") return undefined;
  const api = Reflect.get(manifest, "api");
  if (!api || typeof api !== "object") return undefined;
  const spec = Reflect.get(api, "spec");
  return typeof spec === "string" && spec.trim().length > 0 ? spec.trim() : undefined;
}

/** Derive the declared worker job types from a manifest — the `taskType` of each `workers[]`
 *  entry (schema key `taskType`, mirroring urban's `workerJobType`). Read guardedly rather than
 *  via the typed `AppManifest` so the testkit stays decoupled from a specific schema version
 *  (same self-containment rationale as `readApiSpecPath`). Empty/duplicate/blank types are
 *  dropped; order of first appearance is preserved. */
function deriveWorkerJobTypes(manifest: unknown): string[] {
  if (!manifest || typeof manifest !== "object") return [];
  const workers = Reflect.get(manifest, "workers");
  if (!Array.isArray(workers)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const w of workers) {
    if (!w || typeof w !== "object") continue;
    const taskType = Reflect.get(w, "taskType");
    if (typeof taskType !== "string") continue;
    const jobType = taskType.trim();
    if (jobType.length === 0 || seen.has(jobType)) continue;
    seen.add(jobType);
    out.push(jobType);
  }
  return out;
}

/** Wrap an {@link ApiDriver} so every `call(operationId, …)` records that operation as exercised
 *  on the "operations" surface before delegating (so an operation that returns an error status —
 *  or throws — still counts as driven). `callRoute` and the read-only introspection methods pass
 *  straight through: a raw route is not an enumerated operation, so it is deliberately not recorded
 *  here. Kept as a thin wrapper so the S3 driver has zero coverage coupling. */
function instrumentApiCoverage(driver: ApiDriver, coverage: SurfaceCoverage): ApiDriver {
  return {
    call: (operationId, callOpts) => {
      coverage.record("operations", operationId);
      return driver.call(operationId, callOpts);
    },
    callRoute: (req) => driver.callRoute(req),
    operationIds: () => driver.operationIds(),
    operation: (operationId) => driver.operation(operationId),
  };
}

/** Join an app root and a spec path the way the runtime's `resolveAppPath` (+ `isAbsolutePath`) does:
 *  an absolute `spec` — POSIX root (`/`), a drive-letter root (`C:\` / `C:/`), or a Windows UNC/
 *  drive-root backslash (`\`) — is returned as-is; otherwise it joins onto `root` using `root`'s own
 *  separator (backslash if `root` contains one, else `/`), rewriting both segments to that separator
 *  so the result is never mixed (e.g. no `C:\app/openapi.yaml`). Kept in lockstep with the runtime's
 *  canonical resolver so spec loading behaves identically cross-platform (no gen/runtime drift). */
export function resolveSpecPath(root: string, spec: string): string {
  if (/^(\/|\\|[A-Za-z]:[/\\])/.test(spec)) return spec;
  const sep = root.includes("\\") ? "\\" : "/";
  const norm = (s: string): string => (sep === "\\" ? s.replace(/\//g, "\\") : s.replace(/\\/g, "/"));
  const base = norm(root).replace(/[/\\]+$/, "");
  return `${base}${sep}${norm(spec)}`;
}

/**
 * Boot the Urban app rooted at `root` in-process, against the WASM engine and a virtual
 * clock. `root` must contain the app's manifest and its referenced files (processes,
 * workers, migrations) on disk — typically a temporary fixture directory.
 */
export async function bootTestApp(root: string, opts: BootTestAppOptions = {}): Promise<TestApp> {
  const engine = await createWasmEngineClient();
  // Coverage (S4): when enabled, start capturing exercised job types the moment the engine
  // exists — before the app registers workers — so no dispatch is missed; these hits are
  // replayed into the SurfaceCoverage once the manifest is known (below). When coverage is off
  // no observer is attached and no recorder is built — the empty `jobHits` set stays unused.
  const coverageEnabled = opts.coverage === true;
  const jobHits = new Set<string>();
  // The live coverage job observer's unsubscribe, cleared on `stop()` so we neither retain the
  // recording closure past teardown nor record a stray dispatch during shutdown. Single-slot:
  // the boot-time capture below is superseded by the coverage observer once the manifest is known,
  // and this tracks whichever is currently attached.
  let unobserveJobs: (() => void) | undefined;
  if (coverageEnabled) unobserveJobs = engine.observeJobs((jobType) => jobHits.add(jobType));
  // Anchor the virtual clock at the engine's clock so DataLayer timestamps and the
  // engine's own timeline share an origin; `advanceTime` keeps them in lockstep thereafter.
  const scheduler = createManualScheduler(engine.now);
  const testHost = createTestHost({
    cwd: root,
    now: () => scheduler.now(),
    env: opts.env,
    captureLogs: opts.captureLogs,
  });

  const app = await createUrbanApp({
    host: testHost.host,
    engine,
    // The host is anchored at `root`, so the app's own root is the host's cwd.
    root: ".",
    manifestPath: opts.manifestPath,
    port: 0,
    scheduler,
  }).catch(async (err: unknown) => {
    // The engine is live before the app is built; if construction throws (e.g. a bad
    // manifest) close it so a failed boot doesn't leak the WASM instance across tests.
    await engine.close();
    throw err;
  });
  await app.start();

  // Past this point the app is running (workers subscribed, engine live, router captured),
  // so any failure must stop it before rethrowing or it leaks across tests. `app.stop()`
  // closes the engine too, so no separate engine.close() is needed here.
  try {
    const db = app.data;
    if (!db) throw new Error("bootTestApp: data layer not mounted (is a data source configured?)");

    if (opts.seed) await opts.seed(db);

    const ui: UiDriver = {
      call: async (req) => {
        const handler = testHost.handler();
        if (!handler) throw new Error("bootTestApp: no router mounted (did start() run?)");
        const body = req.body ?? "";
        return handler({
          method: req.method,
          path: req.path,
          query: toSearchParams(req.query),
          headers: toHeaders(req.headers),
          text: () => Promise.resolve(body),
        });
      },
    };

    // A route caller in the shape the OpenAPI driver expects (its `DriverRouteRequest` matches
    // `RouteRequest`), so `api` and `callRoute` reuse the single in-process `ui.call` primitive.
    const uiCall = (req: DriverRouteRequest): Promise<HttpResponse> => ui.call(req);

    // Build the OpenAPI driver from the app's OWN spec (ADR 0059's single HTTP surface). Reading the
    // spec through the same host the runtime used guarantees the driver enumerates exactly the
    // operations the app mounted — no second source of truth (AGENTS.md "Derivation Over Duplication").
    // With no `api` binding the driver still backs `callRoute` (which needs no operations), but
    // `api` itself is left undefined so a generic harness can detect the absence of an API surface.
    let operations: ApiOperation[] = [];
    const specPath = readApiSpecPath(app.manifest);
    if (specPath) {
      const text = await testHost.host.readTextFile(resolveSpecPath(app.root, specPath));
      operations = collectOperations(parseOpenApi(text));
    }
    const driver = createApiDriver(operations, uiCall);

    // Coverage (S4): declare the app's surfaces from its own manifest + spec (single source),
    // replay job hits captured during boot, and record every future job dispatch. The exposed
    // `api` driver is wrapped so each `api.call(operationId)` marks that operation exercised.
    let coverage: SurfaceCoverage | undefined;
    let apiDriver: ApiDriver = driver;
    if (coverageEnabled) {
      const cov = new SurfaceCoverage({
        operations: operations.map((op) => op.operationId),
        workers: deriveWorkerJobTypes(app.manifest),
      });
      for (const jobType of jobHits) cov.record("workers", jobType);
      unobserveJobs = engine.observeJobs((jobType) => cov.record("workers", jobType));
      apiDriver = instrumentApiCoverage(driver, cov);
      coverage = cov;
    }
    const api: ApiDriver | undefined = specPath ? apiDriver : undefined;
    const callRoute = <T,>(req: RouteRequest): Promise<ApiResponse<T>> => driver.callRoute<T>(req);

    const settle = async (): Promise<void> => {
      // Fixpoint at the current instant: drain engine work, then fire any due background timer;
      // a fired timer can enqueue fresh engine work, so loop until nothing fires.
      for (;;) {
        await engine.drain();
        const fired = await scheduler.fireDue();
        if (fired === 0) break;
      }
    };

    const advanceTime = async (ms: number): Promise<void> => {
      // Engine timers first (a BPMN boundary timer may terminate an instance), then the
      // background-loop timers (so the reconciler poll observes that terminal state), then a
      // final settle to absorb any follow-on work.
      await engine.advanceTime(ms);
      await scheduler.advance(ms);
      await settle();
    };

    return {
      app,
      engine,
      db,
      ui,
      api,
      callRoute,
      scheduler,
      logs: testHost.logs,
      now: () => scheduler.now(),
      snapshot: () => engine.snapshot(),
      settle,
      advanceTime,
      coverage,
      stop: () => {
        // Detach the coverage job observer before closing so no dispatch during shutdown is
        // recorded and the recording closure isn't retained past teardown. `app.stop()` closes
        // the engine too, so this is belt-and-braces, but keeps the observer's lifetime bounded.
        unobserveJobs?.();
        unobserveJobs = undefined;
        return app.stop();
      },
    };
  } catch (err) {
    // Roll back a partially-booted app so a failed seed (or a missing data layer) can't leave
    // the engine/workers/router alive across tests. `app.stop()` closes the engine too.
    unobserveJobs?.();
    await app.stop();
    throw err;
  }
}
