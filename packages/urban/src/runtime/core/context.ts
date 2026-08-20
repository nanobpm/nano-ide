import type { AppManifest } from "./manifest.ts";
import type { EngineClient, HostContext } from "./host.ts";
import type { EngineSdkClient } from "../engine/sdk.ts";

/** Everything a runtime module needs. Passed to each module's mount function. */
export interface RuntimeContext {
  manifest: AppManifest;
  host: HostContext;
  engine: EngineClient;
  /** App root directory (paths in the manifest are relative to this). */
  root: string;
}

/** A mounted module returns a disposer so the runtime can tear it down cleanly. */
export interface Mounted {
  readonly name: string;
  stop(): Promise<void>;
  /** Optional human-readable summary for `inspect()`. */
  describe?(): Record<string, unknown>;
}

// AppApi is imported lazily to avoid a cycle; declared here as the injected handler surface.
import type { DataLayer } from "./modules/datasource.ts";
import type { Logger } from "./logger.ts";

/**
 * The surface injected into worker/trigger/surface handlers — the app's runtime API.
 * This is how a handler reaches the datasource (typed accessors), the engine, and host
 * utilities without hard-coding any of them.
 */
export interface AppApi {
  manifest: AppManifest;
  data: DataLayer;
  engine: EngineClient;
  /**
   * The underlying `@nanobpm/nano-sdk` engine client, present when the app runs on
   * the nano-sdk transport (the default). It exposes the full Camunda
   * orchestration-cluster surface — decisions, cluster variables, incidents, user
   * tasks, agents, batch operations — beyond the transport-agnostic `engine` seam,
   * over the same connection. Undefined when a non-SDK engine is injected (e.g. an
   * in-memory test double).
   */
  sdk?: EngineSdkClient;
  env(name: string): string | undefined;
  /**
   * App clock seam — current time in ms since epoch, sourced from the runtime's injectable
   * scheduler (`RuntimeOptions.scheduler`). The real wall clock in production; the virtual
   * clock under the test kit. A handler doing time-bounded work (poll loops, backoff,
   * budgets) should read `app.now()` instead of `Date.now()` so a whole-app `advanceTime()`
   * bounds it deterministically rather than the loop burning real wall-time. See
   * {@link AppApi.wait}.
   */
  now(): number;
  /**
   * Sleep `ms` on the app clock, resolving once that much time has elapsed on the runtime
   * scheduler. Real timers in production (no behavior change on the live transport); under
   * the test kit it advances with `advanceTime()`. Prefer over a hand-rolled `setTimeout`
   * sleep in time-bounded work so the delay shares the engine's (virtual) clock.
   */
  wait(ms: number): Promise<void>;
  /**
   * Structured logger (see {@link Logger}). Callable for back-compat
   * (`log("info", msg, fields)`), but prefer the level methods and bound context:
   * `app.log.info(msg, fields)`, `app.log.child({ … })`. The runtime hands worker
   * handlers a logger already bound to the job's `{ jobKey, jobType,
   * processInstanceKey, elementId }`, and operation delegates one bound to the
   * request's `{ method, path, operationId }`, so lines self-correlate.
   */
  log: Logger;
}
