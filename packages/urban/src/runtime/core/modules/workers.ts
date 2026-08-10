// workers — load each declared worker's handler module and register it as a push worker
// on the engine. Handlers are resolved by a small, documented contract and are injected
// with the app's runtime API (datasource + engine + host utils).

import type { AppApi, Mounted, RuntimeContext } from "../context.ts";
import { isRecord } from "../guards.ts";
import type { EngineJob, JobHandler, WorkerSubscription } from "../host.ts";
import { workerJobType, type Worker } from "../manifest.ts";
import { type DecisionEvaluator, type LlmRuntime, runLlmJob } from "./llm.ts";
import { runInJobContext } from "../execContext.ts";

/** The subset of the engine SDK the LLM decision-rails need: evaluate a DMN decision,
 *  whose `output` comes back as a JSON string (the orchestration-cluster contract). */
interface DecisionCapableSdk {
  evaluateDecision(input: {
    decisionDefinitionId: string;
    variables: Record<string, unknown>;
  }): Promise<{ output?: unknown }>;
}

/** Adapt an engine SDK client into the LLM module's `DecisionEvaluator`, parsing the
 *  decision's JSON-string `output` into the value fed back to the LLM job. Validates the
 *  SDK shape and adds decision context to a parse failure rather than surfacing a raw
 *  "is not a function" / `JSON.parse` error. */
export function sdkDecisionEvaluator(sdk: unknown): DecisionEvaluator {
  return async (decisionId, variables) => {
    if (!hasDecisionCapableSdk(sdk)) {
      throw new Error(
        `llm worker: the engine SDK does not support evaluateDecision ` +
          `(needed for decision rails "${decisionId}")`,
      );
    }
    const res = await sdk.evaluateDecision({ decisionDefinitionId: decisionId, variables });
    const out = res?.output;
    if (typeof out !== "string") return out;
    try {
      return JSON.parse(out);
    } catch {
      throw new Error(
        `llm worker: decision "${decisionId}" returned unparseable JSON output: ${out.slice(0, 300)}`,
      );
    }
  };
}

function hasDecisionCapableSdk(sdk: unknown): sdk is DecisionCapableSdk {
  return isRecord(sdk) && typeof sdk.evaluateDecision === "function";
}

/**
 * A handler as authored by an app: the job plus the injected app API.
 *
 * Both type parameters are optional:
 *   - `In`  types `job.variables` (the process variables the job carries).
 *   - `Out` types the completion **variables map** the handler returns to the engine.
 * Each defaults to an open `Record<string, unknown>`, so `AppJobHandler`,
 * `AppJobHandler<In>`, and `AppJobHandler<In, Out>` are all valid.
 *
 * The bound is `extends object` (not `Record<string, unknown>`) so a plain `interface In {…}`
 * / `interface Out {…}` can be supplied — interfaces have no implicit index signature and so
 * don't satisfy a `Record` bound. The looser bound means `Out` is not *forced* to be a plain
 * variables map at the type level; authors are expected to return a JSON-object of completion
 * variables (not a `Date`, `Map`, array, etc.), which is what the engine sends on job
 * completion. Both parameters are erased at runtime — they only shape authoring-time types.
 */
export type AppJobHandler<In extends object = Record<string, unknown>, Out extends object = Record<string, unknown>> = (
  job: EngineJob<In>,
  app: AppApi,
) => Promise<Out | void> | Out | void;

function isAppJobHandler(value: unknown): value is AppJobHandler {
  return typeof value === "function";
}

/**
 * Hand a handler an {@link AppApi} whose `log` is bound to the job's correlation context, so every
 * line the handler emits self-tags with `{ jobKey, jobType, processInstanceKey, elementId }` without
 * the author threading it. Undefined fields (e.g. a job dispatched without an instance) are omitted
 * so the bound context stays clean. The rest of the API is shared by reference — only `log` is
 * per-job.
 */
function withJobLog(app: AppApi, job: EngineJob): AppApi {
  const bindings: Record<string, unknown> = { jobKey: job.jobKey, jobType: job.jobType };
  if (job.processInstanceKey !== undefined) bindings.processInstanceKey = job.processInstanceKey;
  if (job.elementId !== undefined) bindings.elementId = job.elementId;
  return { ...app, log: app.log.child(bindings) };
}

/**
 * Resolve a handler for `jobType` from a loaded module, in priority order:
 *   1. `handlers[jobType]`            (a map keyed by job type — the multi-type module case)
 *   2. a named export matching jobType (or its last dotted segment)
 *   3. `default` (when it is a function)
 */
export function resolveHandler(
  mod: Record<string, unknown>,
  jobType: string,
): AppJobHandler | undefined {
  const map = isRecord(mod.handlers) ? mod.handlers : undefined;
  if (map && isAppJobHandler(map[jobType])) return map[jobType];
  const seg = jobType.includes(".") ? jobType.slice(jobType.lastIndexOf(".") + 1) : jobType;
  if (isAppJobHandler(mod[jobType])) return mod[jobType];
  if (map && isAppJobHandler(map[seg])) return map[seg];
  if (isAppJobHandler(mod[seg])) return mod[seg];
  if (isAppJobHandler(mod.default)) return mod.default;
  return undefined;
}

export interface WorkersHandle extends Mounted {
  readonly jobTypes: string[];
}

/** Load handler modules and register a push worker per declared worker. */
export async function mountWorkers(ctx: RuntimeContext, app: AppApi): Promise<WorkersHandle> {
  const decls = ctx.manifest.workers ?? [];
  const subs: WorkerSubscription[] = [];
  const jobTypes: string[] = [];

  // Cache module loads so a multi-type handler module is imported once.
  const moduleCache = new Map<string, Record<string, unknown>>();
  const joinRoot = (p: string): string =>
    p.startsWith("/") ? p : `${ctx.root.replace(/\/+$/, "")}/${p.replace(/^\/+/, "")}`;
  const loadModule = async (path: string): Promise<Record<string, unknown>> => {
    const key = joinRoot(path);
    const cached = moduleCache.get(key);
    if (cached) return cached;
    const mod = await ctx.host.importModule(key);
    moduleCache.set(key, mod);
    return mod;
  };

  for (const decl of decls) {
    const jobType = workerJobType(decl);
    if (!jobType) continue;
    // Connector-backed workers (a `connector` field, no handler/llm) are mounted
    // separately by mountConnectors — skip them here silently so they don't trip
    // the "neither handler nor llm" warning below on every startup.
    if (decl.connector) continue;
    if (!decl.handler) {
      // LLM-backed worker (schema `oneOf` handler|llm): synthesise a handler that runs
      // the job through the bound LLM (and optional decision rails) instead of loading a
      // handler module. A declared-but-unknown binding is a manifest error → fail loudly.
      if (!decl.llm) {
        ctx.host.log("warn", "skipping worker: neither a handler nor an llm binding declared", {
          jobType,
        });
        continue;
      }
      const binding = (ctx.manifest.llm ?? {})[decl.llm];
      if (!binding) {
        throw new Error(
          `worker "${jobType}" references unknown llm binding "${decl.llm}" ` +
            `(no llm["${decl.llm}"] in the manifest)`,
        );
      }
      const rt: LlmRuntime = {
        env: (n) => app.env(n),
        evaluateDecision: app.sdk ? sdkDecisionEvaluator(app.sdk) : undefined,
      };
      const wrapped: JobHandler = (job) =>
        runInJobContext(
          { instanceKey: job.processInstanceKey, elementId: job.elementId, jobType },
          () => runLlmJob(job.variables, binding, rt),
        );
      const sub = await ctx.engine.registerWorker(jobType, wrapped, {
        workerName: `${ctx.manifest.id}:${jobType}`,
      });
      subs.push(sub);
      jobTypes.push(jobType);
      ctx.host.log("info", "llm worker registered", { jobType, llm: decl.llm });
      continue;
    }
    const mod = await loadModule(decl.handler);
    const handler = resolveHandler(mod, jobType);
    if (!handler) {
      throw new Error(
        `worker "${jobType}": ${decl.handler} exports no handler for it ` +
          `(expected handlers["${jobType}"], a named export, or a default function)`,
      );
    }
    const wrapped: JobHandler = (job) =>
      runInJobContext(
        { instanceKey: job.processInstanceKey, elementId: job.elementId, jobType },
        () => handler(job, withJobLog(app, job)),
      );
    const sub = await ctx.engine.registerWorker(jobType, wrapped, {
      workerName: `${ctx.manifest.id}:${jobType}`,
    });
    subs.push(sub);
    jobTypes.push(jobType);
    ctx.host.log("info", "worker registered", { jobType, handler: decl.handler });
  }

  return {
    name: "workers",
    jobTypes,
    async stop() {
      // Graceful unsubscribe on exit (defensive against the Falcon dead-subscriber stall).
      await Promise.allSettled(subs.map((s) => s.unsubscribe()));
    },
    describe: () => ({ jobTypes }),
  };
}
