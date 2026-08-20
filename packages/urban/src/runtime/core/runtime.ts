// The runtime orchestrator: createUrbanApp() takes a manifest + a host + an engine and
// materializes the app by mounting each module. Hosts (CLI/IDE/console/bare process) call
// this the same way; a host may mount a subset via `mount` flags (e.g. the console mounts
// its own surfaces but reuses deploy + workers + datasource).

import type { AppApi, Mounted } from "./context.ts";
import type { EngineClient, HostContext, HttpServer } from "./host.ts";
import type { EngineSdkClient } from "../engine/sdk.ts";
import { loadManifest, resolveBindMode, bindModeToHost, type AppManifest } from "./manifest.ts";
import { validateManifest } from "./validate.ts";
import { makeRouter, type Route } from "./router.ts";
import { deployModels } from "./modules/deploy.ts";
import { provisionData, DataLayer } from "./modules/datasource.ts";
import { installExecStore, type JobExecContext } from "./execContext.ts";
import { createLogger, type Logger } from "./logger.ts";
import { mountWorkers } from "./modules/workers.ts";
import { mountConnectors } from "./modules/connectors.ts";
import { mountSurfaces } from "./modules/surfaces.ts";
import { mountTriggers } from "./modules/triggers.ts";
import { mountInstanceTracking } from "./modules/instance-tracking.ts";
import { defaultScheduler, schedulerClock, type SchedulerDeps } from "./modules/scheduler.ts";
import { mountSecurity, type SecurityPolicy } from "./modules/security.ts";
import { EventBus } from "./events.ts";
import { createUrbanEvents, mountExtensions, type UrbanEvents, type UrbanExtension } from "./extensions.ts";

/** Resolve the HTTP port: explicit option, else $PORT, else 8090. Throws a clear
 * error when $PORT is set but not a valid integer in 0..65535. */
export function resolvePort(explicit: number | undefined, envPort: string | undefined): number {
  if (explicit !== undefined) return explicit;
  if (envPort === undefined || envPort === "") return 8090;
  const n = Number(envPort);
  if (!Number.isInteger(n) || n < 0 || n > 65535) {
    throw new Error(`invalid PORT "${envPort}": expected an integer in 0..65535`);
  }
  return n;
}

/** Read the underlying nano-sdk client off an engine when it exposes one (the
 *  `SdkEngineClient` does). Non-SDK engines (e.g. an in-memory test double) have no
 *  `sdk`, so handlers get `undefined` and fall back to the transport-agnostic seam. */
interface EngineWithSdk extends EngineClient {
  sdk?: EngineSdkClient;
}

function hasEngineSdk(engine: EngineClient): engine is EngineWithSdk {
  return "sdk" in engine;
}

function engineSdk(engine: EngineClient): EngineSdkClient | undefined {
  return hasEngineSdk(engine) ? engine.sdk : undefined;
}

export interface MountFlags {
  deploy?: boolean;
  data?: boolean;
  workers?: boolean;
  surfaces?: boolean;
  triggers?: boolean;
  security?: boolean;
  /** The `instanceTracking` reconciler poll loop. Shares no HTTP surface; safe to disable
   *  in hosts that only render surfaces (e.g. the console preview). */
  instanceTracking?: boolean;
}

export interface CreateUrbanAppOptions {
  host: HostContext;
  engine: EngineClient;
  /** App root directory; manifest paths resolve relative to it. Default ".". */
  root?: string;
  /** Provide a manifest object directly, or… */
  manifest?: AppManifest;
  /** …a path to load it from (relative to root). Default "nano.app.json". */
  manifestPath?: string;
  /** HTTP port for surfaces/triggers. Default from PORT env or 8090. */
  port?: number;
  /** Which modules to mount (all true by default). */
  mount?: MountFlags;
  /**
   * Injectable timer + clock seam driving every background loop (the cron trigger loops
   * and the instance-tracking reconciler) and the app clock/`wait` seam handed to worker
   * handlers. Defaults to the live scheduler (real timers, wall clock). The e2e test kit
   * injects a manual scheduler so those loops — and any time-bounded worker sourcing
   * `app.now()`/`app.wait()` — advance deterministically over a virtual clock: the single
   * seam that makes a whole-app `settle()` possible. Threaded verbatim into `mountWorkers`,
   * `mountTriggers` and `mountInstanceTracking` so one injected scheduler drives them all
   * (no per-module wiring, no drift).
   */
  scheduler?: SchedulerDeps;
  /**
   * Pluggable Urban {@link UrbanExtension}s — the agentic families and connector
   * packs that extend the app lifecycle through the typed extension-event taxonomy
   * (issue #262) instead of editing the runtime. The runtime runs each through the
   * `extension/register` serial checkpoint in a deterministic order and disposes
   * everything they register on `stop()` / HMR. Empty by default.
   */
  extensions?: readonly UrbanExtension[];
}

export interface UrbanApp {
  readonly manifest: AppManifest;
  readonly root: string;
  /** Materialize the app (deploy → data → workers → surfaces/triggers). */
  start(): Promise<void>;
  /** Tear everything down cleanly: unsubscribe workers, close the DB, stop the
   * HTTP server, and close the engine client (the app owns the engine's
   * connection lifecycle once started). */
  stop(): Promise<void>;
  /** A structured snapshot of what is mounted. */
  inspect(): Record<string, unknown>;
  /** An app-level structured {@link Logger} for the entrypoint (`main.ts`). It carries no
   * per-request/per-job correlation (worker handlers and route delegates get a child logger bound
   * to their job/request context via `AppApi.log`); use it for boot/shutdown lifecycle lines. */
  readonly log: Logger;
  /** The provisioned data layer (available after start when `data` is mounted). */
  readonly data: DataLayer | undefined;
  readonly security: SecurityPolicy | undefined;
  readonly httpPort: number | undefined;
  /**
   * The runtime's native HTTP server object once `start()` has bound it (the Node adapter's
   * `node:http` `Server`), for attaching a WebSocket upgrade on the app's *own* port. Snapshot it
   * into a local `const` and narrow that with a runtime `instanceof` check before use (no type
   * assertion needed) — reading the property again after the check would not narrow — e.g.
   * `const { Server } = await import("node:http"); const server = app.httpServer; if (server instanceof Server) new WebSocketServer({ server, path: "/agentic" });`.
   * `undefined` before `start()`, after `stop()`, and on hosts that don't surface one (Deno).
   */
  readonly httpServer: object | undefined;
  /**
   * The app's typed extension-event taxonomy (issue #262): lifecycle notifications,
   * the extension-registration checkpoint, request/security waterfall gates, and
   * the reconcile fan-out — each a channel with a declared dispatch mode. Modules
   * and {@link UrbanExtension}s hook onto these seams instead of wiring directly;
   * every registration is an effect on a dispose ladder that `stop()` unwinds.
   */
  readonly events: UrbanEvents;
}

export async function createUrbanApp(opts: CreateUrbanAppOptions): Promise<UrbanApp> {
  const host = opts.host;
  const root = opts.root ?? ".";
  const manifest = validateManifest(
    opts.manifest ?? (await loadManifest(host, `${root.replace(/\/+$/, "")}/${opts.manifestPath ?? "nano.app.json"}`)),
  );
  const engine = opts.engine;
  const flags: Required<MountFlags> = {
    deploy: opts.mount?.deploy ?? true,
    data: opts.mount?.data ?? true,
    workers: opts.mount?.workers ?? true,
    surfaces: opts.mount?.surfaces ?? true,
    triggers: opts.mount?.triggers ?? true,
    security: opts.mount?.security ?? true,
    instanceTracking: opts.mount?.instanceTracking ?? true,
  };
  const ctx = { manifest, host, engine, root };

  // One app-level structured logger over the host sink, shared by the entrypoint (exposed as
  // `app.log`) and the per-invocation `AppApi.log` (workers/route delegates `child()` it with their
  // correlation context).
  const appLog = createLogger((l, m, f) => host.log(l, m, f));

  // The app-wide extension-event microkernel (issue #262): one typed taxonomy over
  // one dispose ladder. Contained listener throws land in the structured log rather
  // than stranding the pipeline. Modules and extensions hook onto `events`; the
  // whole ladder unwinds on teardown.
  const bus = new EventBus({
    onError: (err, info) =>
      appLog.warn("extension listener threw and was contained", {
        event: info.event,
        mode: info.mode,
        error: String(err),
      }),
  });
  const events = createUrbanEvents(bus);

  // Install the ambient job-execution store once per process (idempotent) so worker dispatch can
  // stamp write-provenance onto DataLayer inserts. Absent-safe: a host without `createAsyncStore`
  // leaves provenance capture disabled.
  installExecStore(() => host.createAsyncStore?.<JobExecContext>());

  let data: DataLayer | undefined;
  let security: SecurityPolicy | undefined;
  let server: HttpServer | undefined;
  const mounted: Mounted[] = [];
  const describe: Record<string, unknown> = {};
  let started = false;
  let httpPort: number | undefined;

  const port = resolvePort(opts.port, host.env("PORT"));

  // Which interface the HTTP server binds to (issue #235). Secure by default: loopback unless
  // the manifest's `network.bind` (or the `URBAN_BIND` env override) opts into all interfaces.
  // Derive the host address from the already-resolved mode so the two can never diverge (and we
  // consult the env exactly once) — a second `resolveBindHost` call would re-read the override.
  const bindMode = resolveBindMode(manifest, (n) => host.env(n));
  const bindHost = bindModeToHost(bindMode);

  // Release every mounted resource and reset internal state so a subsequent
  // start() begins clean. Used by stop() and by start()'s failure path.
  const teardown = async () => {
    // Notify lifecycle listeners before we start tearing seams down (issue #262).
    events.lifecycle.emit({ app: manifest.id, phase: "stopping" });
    if (server) {
      try {
        await server.stop();
      } catch (e) {
        host.log("warn", "error stopping http server", { error: String(e) });
      }
    }
    for (const m of mounted) {
      try {
        await m.stop();
      } catch (e) {
        host.log("warn", "error stopping module", { error: String(e) });
      }
    }
    if (data) data.closeAll();
    try {
      await engine.close();
    } catch (e) {
      host.log("warn", "error closing engine", { error: String(e) });
    }
    mounted.length = 0;
    for (const k of Object.keys(describe)) delete describe[k];
    server = undefined;
    httpPort = undefined;
    data = undefined;
    security = undefined;
    started = false;
    // Terminal lifecycle notification, then unwind the whole dispose ladder LIFO:
    // every extension listener/effect (and the lifecycle channel itself) is torn
    // down, so a subsequent start() — or a dev-server HMR reload — leaks nothing.
    events.lifecycle.emit({ app: manifest.id, phase: "stopped" });
    bus.dispose();
  };

  const app: UrbanApp = {
    manifest,
    root,
    log: appLog,
    events,
    get data() {
      return data;
    },
    get security() {
      return security;
    },
    get httpPort() {
      return httpPort;
    },
    get httpServer(): object | undefined {
      const native = server?.native;
      return typeof native === "object" && native !== null ? native : undefined;
    },

    async start() {
      if (started) throw new Error("app already started");
      started = true;
      events.lifecycle.emit({ app: manifest.id, phase: "starting" });
      try {
        if (flags.security) security = mountSecurity(ctx);
        if (flags.deploy) describe.deploy = await deployModels(ctx);

        data = flags.data ? await provisionData(ctx) : new DataLayer(new Map(), undefined, {});
        // Resolve the injectable scheduler once (default: live real-timer seam) so the app
        // clock/`wait` seam handed to handlers and every background loop share one clock —
        // the single source the test kit swaps for a virtual clock to make `settle()` /
        // `advanceTime()` bound the whole app (workers included).
        const scheduler = opts.scheduler ?? defaultScheduler();
        const clock = schedulerClock(scheduler);
        const api: AppApi = {
          manifest,
          data,
          engine,
          sdk: engineSdk(engine),
          env: (n) => host.env(n),
          log: appLog,
          now: clock.now,
          wait: clock.wait,
        };

        if (flags.workers) {
          const w = await mountWorkers(ctx, api, scheduler);
          mounted.push(w);
          describe.workers = w.describe?.();
          // Connector-pack workers share the `workers` flag: same lifecycle, same
          // engine, distinguished only by a `connector` field on the declaration.
          const c = await mountConnectors(ctx, api);
          mounted.push(c);
          if (c.jobTypes.length > 0) describe.connectors = c.describe?.();
        }

        // Run the agentic-family / connector-pack extension surface through the
        // typed taxonomy (issue #262). Everything an extension registers rides the
        // shared dispose ladder, so teardown's single `bus.dispose()` unwinds it —
        // the extension host is deliberately NOT pushed onto `mounted`.
        const extHost = await mountExtensions(api, opts.extensions ?? [], { bus, events });
        describe.extensions = extHost.describe?.();

        const routes: Route[] = [];
        let hasUiSurfaces = false;
        if (flags.surfaces) {
          const s = mountSurfaces(ctx, api);
          routes.push(...s.routes);
          hasUiSurfaces = s.routes.length > 0;
          describe.surfaces = s.describe();
        }
        if (flags.triggers) {
          const t = mountTriggers(ctx, api, scheduler);
          routes.push(...t.routes);
          mounted.push(t);
          describe.triggers = t.describe?.();
        }
        if (flags.instanceTracking && (manifest.instanceTracking?.length ?? 0) > 0) {
          const it = mountInstanceTracking(ctx, api, scheduler);
          mounted.push(it);
          describe.instanceTracking = it.describe?.();
        }
        if (security) describe.security = security.describe();
        if (data) describe.data = data.describe();

        if (routes.length > 0) {
          // A tiny liveness route.
          routes.push({
            method: "GET",
            path: "/healthz",
            handler: () => ({
              status: 200,
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ ok: true, app: manifest.id }),
            }),
          });
          server = await host.serveHttp(port, makeRouter(routes), bindHost);
          httpPort = server.port;
          host.log("info", "urban app serving surfaces/triggers", {
            port: httpPort,
            routes: routes.length,
            bind: bindMode,
            bindHost,
          });
          // Binding to all interfaces exposes the app (and its token-gated capability
          // hooks) on the LAN. That is the explicit opt-in this setting exists for, but a
          // non-loopback bind must not serve any LOCAL-mode "well-known localhost token"
          // credential (issue #235) — consumers that mint one (e.g. the agentic channel's
          // LOCAL mode) must gate it on a loopback bind. Surface the exposure so it is never
          // silent.
          if (bindMode === "all") {
            host.log("warn", "urban app bound to all interfaces — reachable off-box on the LAN", {
              port: httpPort,
              bindHost,
            });
          }
          // ADR 0057 boot handshake: under a supervising host (the nano-bpm
          // Studio sets NANOBPMN_APP_HANDSHAKE), announce the port we actually
          // bound on a machine-readable stdout control line so the host can
          // locate the app's UI even when the app picks its port at runtime.
          // Only emitted when the app actually serves UI surfaces (a trigger- or
          // worker-only app binds a port too, but it has no webview for the host
          // to frame), and gated on the env var so direct terminal runs aren't
          // cluttered. `=== "1"` so an app that sets the var to "0" opts out.
          if (httpPort !== undefined && hasUiSurfaces && host.env("NANOBPMN_APP_HANDSHAKE") === "1") {
            try {
              console.log(`@@NBPM_LISTENING@@${JSON.stringify({ port: httpPort })}`);
            } catch {
              // stdout may be closed / non-writable — the handshake is
              // best-effort telemetry, never fatal to the app.
            }
          }
        }
        host.log("info", `urban app "${manifest.id}" started`, {});
        events.lifecycle.emit({ app: manifest.id, phase: "started" });
      } catch (err) {
        // A failed start must not leave the app half-mounted (leaked workers,
        // a bound port) or wedged in the "already started" state.
        await teardown();
        throw err;
      }
    },

    async stop() {
      await teardown();
    },

    inspect() {
      return { app: manifest.id, name: manifest.name, root, httpPort, ...describe };
    },
  };

  return app;
}
