// The Worker runtime — hosts one or more workflows against a gateway and drives
// them: it registers one nano-sdk job worker per derived job type, dispatches
// each activated job to its handler, and completes it. It generalises the two
// surfaces:
//
//   - a declarative flow contributes one job type per `run` step, dispatched to
//     the user handler (external `task` steps are intentionally NOT hosted here —
//     a worker outside this program serves them);
//   - an imperative workflow contributes its single orchestrator job type,
//     dispatched to the replay engine (which advances the journal one step).
//
// Transport (activation, completion, failure, long-poll, backoff/reconnect) is
// the nano-sdk job worker (ADR 0055), reached through `WorkflowClient.sdk`. The
// nano-sdk worker reschedules its poll on an activation error, so the runtime
// survives an engine crash/restart — the property the ADR 0044 spike proved.

import { WorkflowClient } from "./client.js";
import type { ActivatedJob, NanoJobWorker } from "./client.js";
import { replayOnce } from "./imperative.js";
import { walkNodes } from "./declarative.js";
import type { Job, JsonObject, Workflow } from "./types.js";
import { jobType } from "./xml.js";

/** Fired after a job completes; purely observational. */
export interface ActivityEvent {
  workflowId: string;
  type: string;
  jobKey: string;
  elementId: string;
  /** For an imperative orchestrator turn: the journalled step key, or "__done". */
  step?: string;
}

/** Options common to both ways of building a `Worker`. */
interface WorkerCommon {
  workflows: Workflow[];
  /** Worker name reported to the gateway. Default "nanobpm-workflow". */
  name?: string;
  /** Transport for the worker's own client (used only when `client` is not
   *  supplied): "auto" | "falcon" | "rest". Defaults to "rest" — job serving is
   *  resilience-critical, and REST long-poll reconnects with backoff after an
   *  engine restart (the ADR 0044 property), whereas the Falcon push transport
   *  does not recover a mid-stream disconnect. Instance creation, by contrast,
   *  defaults to Falcon on its own `WorkflowClient` for throughput. */
  transport?: "auto" | "falcon" | "rest";
  /** Long-poll timeout per activation, ms. Also bounds stop() latency. Default 10000. */
  pollTimeoutMs?: number;
  /** Job lock timeout, ms. Default 30000. */
  jobTimeoutMs?: number;
  /** Max jobs handled in parallel per derived job type. Default 1. */
  maxParallelJobs?: number;
  onActivity?: (e: ActivityEvent) => void | Promise<void>;
  onError?: (err: Error, context: { type: string }) => void;
}

/** Build a `Worker` from **either** a `baseUrl` (a `WorkflowClient` is created)
 *  **or** an existing `client`. The union makes TypeScript enforce that exactly
 *  one is supplied, matching the constructor's runtime requirement. */
export type WorkerOptions =
  | (WorkerCommon & {
      /** Base URL of the nanobpmn gateway; a `WorkflowClient` is created for you. */
      baseUrl: string;
      client?: never;
    })
  | (WorkerCommon & {
      /** An existing `WorkflowClient` to serve jobs through. */
      client: WorkflowClient;
      baseUrl?: never;
    });

type Handler = (job: Job) => Promise<{ variables: JsonObject; step?: string }>;

function isJsonObject(v: unknown): v is JsonObject {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export class Worker {
  private readonly client: WorkflowClient;
  private readonly name: string;
  private readonly pollTimeoutMs: number;
  private readonly jobTimeoutMs: number;
  private readonly maxParallelJobs: number;
  private readonly onActivity?: WorkerOptions["onActivity"];
  private readonly onError?: WorkerOptions["onError"];
  /** job type → { workflowId, handle } */
  private readonly routes = new Map<string, { workflowId: string; handle: Handler }>();
  /** Job lock timeout (ms) per derived job type, from a `run` step's `{ timeoutMs }`
   *  (issue #596). Overrides the worker-wide `jobTimeoutMs` for that type. */
  private readonly typeTimeoutMs = new Map<string, number>();
  private running = false;
  private workers: NanoJobWorker[] = [];

  constructor(opts: WorkerOptions) {
    this.client =
      opts.client ??
      new WorkflowClient({ baseUrl: requireBaseUrl(opts), transport: opts.transport ?? "rest" });
    this.name = opts.name ?? "nanobpm-workflow";
    this.pollTimeoutMs = opts.pollTimeoutMs ?? 10000;
    this.jobTimeoutMs = opts.jobTimeoutMs ?? 30000;
    this.maxParallelJobs = opts.maxParallelJobs ?? 1;
    this.onActivity = opts.onActivity;
    this.onError = opts.onError;
    for (const wf of opts.workflows) this.register(wf);
  }

  private register(wf: Workflow): void {
    if (wf.kind === "imperative") {
      this.addRoute(wf.orchestrateType, {
        workflowId: wf.id,
        handle: async (job) => {
          const input = isJsonObject(job.variables.input) ? job.variables.input : {};
          const journal = isJsonObject(job.variables.journal) ? job.variables.journal : {};
          const step = await replayOnce(wf, input, journal);
          if (step.done) {
            const variables: JsonObject = { wfDone: true };
            return { variables, step: "__done" };
          }
          const next = { ...journal, [step.frontier.key]: step.frontier.result };
          const variables: JsonObject = { journal: next, wfDone: false };
          return { variables, step: step.frontier.key };
        },
      });
    } else {
      // Walk the flow tree; only `run` steps are hosted locally. `signal`
      // (message catch) and `task` (external worker) contribute no in-process
      // route, and structural combinators (`switch`/`branch`/`loop`/`parallel`/
      // `forEach`) are pure routing with no job of their own — but the `run`
      // steps NESTED inside them are hosted, since `walkNodes` recurses.
      walkNodes(wf.steps, (s) => {
        if (s.kind !== "run") return;
        const handler = wf.handlers[s.name];
        if (typeof handler !== "function") {
          // `DeclarativeFlow` is a public type; a consumer-constructed flow could
          // carry a `run` step with no handler. Fail fast at registration with a
          // clear message rather than a `handler is not a function` TypeError on
          // the first job activation.
          throw new Error(
            `workflow "${wf.id}": run step "${s.name}" has no handler function`,
          );
        }
        this.addRoute(jobType(wf.id, s.name), {
          workflowId: wf.id,
          handle: async (job) => {
            const variables: JsonObject = (await handler(job)) ?? {};
            return { variables };
          },
        });
        // A step-declared job lock timeout (issue #596) applies to this step's derived
        // job type, overriding the worker-wide `jobTimeoutMs` at `start()`.
        if (s.timeoutMs !== undefined) this.typeTimeoutMs.set(jobType(wf.id, s.name), s.timeoutMs);
      });
    }
  }

  /** Register a derived job type, failing fast on a collision. Two workflows can
   *  resolve to the same job type (duplicate workflow ids, or a declarative step
   *  name that collides with another workflow's); silently overwriting the route
   *  would drop a handler, so we reject it at construction time. */
  private addRoute(type: string, route: { workflowId: string; handle: Handler }): void {
    const existing = this.routes.get(type);
    if (existing) {
      throw new Error(
        `duplicate derived job type "${type}": workflows "${existing.workflowId}" and "${route.workflowId}" ` +
          `resolve to the same job type (check for duplicate workflow ids or colliding step names)`,
      );
    }
    this.routes.set(type, route);
  }

  /** Invoke the onError observer hook without letting it affect the poll loop —
   *  a throwing observer must not permanently stop a route. */
  private emitError(err: Error, type: string): void {
    try {
      this.onError?.(err, { type });
    } catch {
      /* observer hooks are purely observational; swallow their failures */
    }
  }

  /** Invoke the onActivity observer hook in isolation. It runs after the job has
   *  already been completed, so a throwing observer must not fall into the
   *  failure path and try to fail an already-completed job. */
  private async emitActivity(e: ActivityEvent): Promise<void> {
    try {
      await this.onActivity?.(e);
    } catch {
      /* observational only; swallow so it never triggers failJob */
    }
  }

  /** The derived job types this worker serves. */
  get servedTypes(): string[] {
    return [...this.routes.keys()];
  }

  /** Begin serving. Creates one nano-sdk job worker per derived job type with
   *  `autoStart: false`, then starts each explicitly, so the poll lifecycle is
   *  deterministic and owned here rather than left to the SDK's auto-start
   *  default (matching the `JobWorkerConfig.autoStart` contract). Nothing polls
   *  before `start()` is called. */
  start(): void {
    if (this.running) return;
    this.running = true;
    this.workers = [...this.routes.entries()].map(([type, route]) => {
      const worker = this.client.sdk.createJobWorker({
        jobType: type,
        workerName: this.name,
        maxParallelJobs: this.maxParallelJobs,
        // A step-declared `{ timeoutMs }` (issue #596) wins over the worker-wide default.
        jobTimeoutMs: this.typeTimeoutMs.get(type) ?? this.jobTimeoutMs,
        pollTimeoutMs: this.pollTimeoutMs,
        autoStart: false,
        jobHandler: (job) => this.handleJob(type, route, job),
      });
      worker.start();
      return worker;
    });
  }

  /** Stop serving and wait for in-flight jobs to drain. Stopping is best-effort
   *  per worker: the Falcon worker's `stop` throws if it never bound a transport
   *  (detection still pending), which must not fail the whole shutdown. */
  async stop(): Promise<void> {
    this.running = false;
    await Promise.all(
      this.workers.map(async (w) => {
        try {
          await (w.stopGracefully
            ? w.stopGracefully({ waitUpToMs: this.pollTimeoutMs })
            : w.stop());
        } catch {
          /* worker never fully started (transport unbound); nothing to drain */
        }
      }),
    );
    this.workers = [];
  }

  /** Dispatch one activated job to its route handler and acknowledge it. Returns
   *  the nano-sdk action receipt (its `complete`/`fail` result). */
  private async handleJob(
    type: string,
    route: { workflowId: string; handle: Handler },
    job: ActivatedJob,
  ): Promise<unknown> {
    try {
      const { variables, step } = await route.handle(job);
      const receipt = await job.complete(variables);
      // Job is now completed; the observer hook is isolated (emitActivity
      // swallows its own errors) so it can never fall into the failure path.
      await this.emitActivity({
        workflowId: route.workflowId,
        type,
        jobKey: job.jobKey,
        elementId: job.elementId,
        step,
      });
      return receipt;
    } catch (e) {
      // A handler or completion failed. Report; the engine will redeliver the
      // job after its lock times out (at-least-once → handlers must be
      // idempotent). Best-effort surface it as an incident-worthy failure.
      // Normalise non-Error throws (strings, objects) so emitError always gets
      // an Error and errorMessage is never undefined in the failure report.
      const err = e instanceof Error ? e : new Error(String(e));
      this.emitError(err, type);
      try {
        return await job.fail({ errorMessage: err.message, retries: 0 });
      } catch {
        // Even reporting the failure failed (e.g. the gateway is unreachable).
        // Awaited + swallowed so a rejected `fail` can't escape as an unhandled
        // rejection out of the SDK worker's handler; the engine redelivers the
        // job once its lock times out regardless.
        return undefined;
      }
    }
  }
}

function requireBaseUrl(opts: WorkerOptions): string {
  if (!opts.baseUrl) throw new Error("Worker needs either options.client or options.baseUrl");
  return opts.baseUrl;
}
