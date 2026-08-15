// The Urban runtime's single engine client. Every path to a Nano engine — deploy,
// instance creation, message publication, user tasks, and job workers — routes
// through one `@nanobpm/nano-sdk` client (ADR 0055). The SDK's `createCamundaClient`
// transparently upgrades the throughput-critical paths (process-instance creation and
// job serving) to the Falcon protocol on a Nano server and falls back to REST
// everywhere else, so the runtime and the IDE talk to the engine the same way with a
// single transport instead of a hand-rolled REST client plus a Falcon shim.
//
// `@nanobpm/nano-sdk` is a direct dependency, but it is imported lazily (via an
// indirected specifier) so a caller that injects its own client — unit tests, the
// Deno smoke, or an author bringing the embedded transport — never loads it, keeping
// a dependency-free import graph for those paths.

import type {
  EngineClient,
  EngineJob,
  FormSchema,
  JobHandler,
  ProcessInstanceSnapshot,
  ProcessInstanceState,
  UserTaskSummary,
  WorkerSubscription,
} from "../core/host.ts";
import { isBpmnError, presentFormIdentifier } from "../core/host.ts";
import type { EngineSdkClient } from "./sdk.ts";
import { isRecord } from "../core/guards.ts";

/** Coerce an engine response's process-instance key to a non-empty string, or
 * throw — a missing key means a malformed/partial response, not a real instance. */
export function requireProcessInstanceKey(key: string | number | null | undefined): string {
  if (key == null || key === "") {
    throw new Error("engine response missing processInstanceKey/key");
  }
  return String(key);
}

/** Map the engine's process-instance `state` onto the transport-agnostic
 *  {@link ProcessInstanceState} union, or `undefined` for an unrecognized value
 *  (which the caller skips rather than mis-reconciling). Case-insensitive so a
 *  future casing tweak on the engine side doesn't silently drop instances. */
export function normalizeProcessInstanceState(
  raw: unknown,
): ProcessInstanceState | undefined {
  if (typeof raw !== "string") return undefined;
  switch (raw.toUpperCase()) {
    case "ACTIVE":
      return "ACTIVE";
    case "COMPLETED":
      return "COMPLETED";
    case "TERMINATED":
      return "TERMINATED";
    default:
      return undefined;
  }
}

/** A job as delivered to a nano-sdk job handler: the frame fields plus the
 *  acknowledgement actions the handler must call. */
export interface NanoSdkActivatedJob {
  jobKey: string | number;
  type?: string;
  processInstanceKey?: string | number;
  elementId?: string;
  variables?: Record<string, unknown>;
  complete(variables?: Record<string, unknown>): Promise<unknown>;
  fail(body: { errorMessage: string; retries?: number }): Promise<unknown>;
  /** Raise a BPMN error (Zeebe `ThrowError`) routed to an error boundary/event.
   *  Present on the nano-sdk enriched job at runtime; typed here so the adapter
   *  can honour a handler's {@link BpmnError} (ADR 0050). */
  error?(e: { errorCode: string; errorMessage?: string }): Promise<unknown>;
}

/** Config for a nano-sdk job worker (the subset this adapter sets). */
export interface NanoSdkJobWorkerConfig {
  jobType: string;
  jobHandler: (job: NanoSdkActivatedJob) => Promise<unknown> | unknown;
  workerName?: string;
  maxParallelJobs?: number;
  jobTimeoutMs?: number;
  pollTimeoutMs?: number;
  fetchVariables?: string[];
  /** Start polling immediately (the SDK default). The adapter leaves this unset so the
   * SDK owns the start lifecycle after its async Nano/Falcon transport detection. */
  autoStart?: boolean;
}

/** The handle returned by `createJobWorker`. */
export interface NanoSdkJobWorker {
  start(): void | Promise<void>;
  stop(): void | Promise<void>;
  stopGracefully?(opts?: { waitUpToMs?: number }): Promise<void>;
}

/**
 * The subset of the `@nanobpm/nano-sdk` (Camunda orchestration-cluster) client the
 * engine adapter uses. `createCamundaClient` returns a superset of this, so a test —
 * or an author bringing their own transport (e.g. the embedded engine) — can inject
 * any object satisfying it.
 */
export interface NanoSdkClient {
  createDeployment(
    input: { resources: File[]; [k: string]: unknown },
    options?: unknown,
  ): Promise<Record<string, unknown>>;
  createProcessInstance(
    input: {
      processDefinitionId: string;
      variables?: Record<string, unknown>;
      awaitCompletion?: boolean;
    },
    options?: unknown,
  ): Promise<Record<string, unknown>>;
  cancelProcessInstance(
    input: { processInstanceKey: string | number },
    options?: unknown,
  ): Promise<unknown>;
  publishMessage(
    input: { name: string; correlationKey?: string; variables?: Record<string, unknown> },
    options?: unknown,
  ): Promise<Record<string, unknown>>;
  searchUserTasks(
    input: { filter?: Record<string, unknown> },
    consistency?: unknown,
    options?: unknown,
  ): Promise<Record<string, unknown>>;
  completeUserTask(
    input: { userTaskKey: string; variables?: Record<string, unknown> },
    options?: unknown,
  ): Promise<unknown>;
  getFormByKey(
    input: { formKey: string },
    consistency?: unknown,
    options?: unknown,
  ): Promise<Record<string, unknown>>;
  searchProcessInstances(
    input: { filter?: Record<string, unknown>; page?: Record<string, unknown> },
    consistency?: unknown,
    options?: unknown,
  ): Promise<Record<string, unknown>>;
  createJobWorker(cfg: NanoSdkJobWorkerConfig): NanoSdkJobWorker;
  /** Stop every worker created on this client. Used on teardown to also drain a
   * REST-fallback worker, whose handle the `createJobWorker` proxy starts internally
   * and does not hand back. Optional: not every injected client implements it. */
  stopAllWorkers?(): void | Promise<void>;
  close?(): void | Promise<void>;
}

type Log = (level: "debug" | "info" | "warn" | "error", msg: string, fields?: Record<string, unknown>) => void;

/**
 * An `EngineClient` backed entirely by a `@nanobpm/nano-sdk` client. Deploy, create,
 * message, and user-task calls map one-to-one onto the SDK's client methods; workers
 * are the SDK's own job worker, which handles activation, completion, failure, and
 * long-poll/backoff reconnect behind the same transport.
 */
export class SdkEngineClient implements EngineClient {
  private readonly workers = new Set<NanoSdkJobWorker>();
  private readonly client: NanoSdkClient;
  private readonly log: Log;

  constructor(client: NanoSdkClient, log: Log = () => {}) {
    this.client = client;
    this.log = log;
  }

  /**
   * The underlying `@nanobpm/nano-sdk` client — the full Camunda orchestration-cluster
   * surface (decisions, cluster variables, incidents, agents, batch operations, …) over
   * the same connection. Surfaced to handlers as `AppApi.sdk`.
   */
  get sdk(): EngineSdkClient {
    // biome-ignore lint/plugin: `this.client` is the same `@nanobpm/nano-sdk` client at runtime; exposing its full EngineSdkClient surface is the adapter boundary (see EngineSdkClient in ./sdk.ts).
    return this.client as NanoSdkClient & EngineSdkClient;
  }

  async deployResources(
    resources: { name: string; content: string; contentType: string }[],
  ): Promise<{ deployed: number }> {
    const files = resources.map((r) => new File([r.content], r.name, { type: r.contentType }));
    await this.client.createDeployment({ resources: files });
    return { deployed: resources.length };
  }

  async createInstance(input: {
    processDefinitionId: string;
    variables?: Record<string, unknown>;
    awaitCompletion?: boolean;
  }): Promise<{ processInstanceKey: string; variables?: Record<string, unknown> }> {
    const body = await this.client.createProcessInstance({
      processDefinitionId: input.processDefinitionId,
      variables: input.variables ?? {},
      awaitCompletion: input.awaitCompletion ?? false,
    });
    const rawKey = body.processInstanceKey ?? body.key;
    const key =
      typeof rawKey === "string" || typeof rawKey === "number" ? rawKey : undefined;
    const variables = isRecord(body.variables) ? body.variables : undefined;
    return {
      processInstanceKey: requireProcessInstanceKey(key),
      variables,
    };
  }

  async cancelInstance(input: { processInstanceKey: string }): Promise<void> {
    await this.client.cancelProcessInstance({ processInstanceKey: input.processInstanceKey });
  }

  async publishMessage(input: {
    name: string;
    correlationKey?: string;
    variables?: Record<string, unknown>;
  }): Promise<void> {
    await this.client.publishMessage({
      name: input.name,
      correlationKey: input.correlationKey ?? "",
      variables: input.variables ?? {},
    });
  }

  async searchUserTasks(filter?: {
    processInstanceKey?: string;
    assignee?: string;
    candidateGroup?: string;
  }): Promise<UserTaskSummary[]> {
    // User tasks are an eventually consistent read; ask for zero-wait consistency so
    // the search reflects what is currently visible without blocking.
    const body = await this.client.searchUserTasks(
      { filter: { ...(filter ?? {}) } },
      { consistency: { waitUpToMs: 0 } },
    );
    const items = Array.isArray(body.items) ? body.items.filter(isRecord) : [];
    return items.flatMap((it) => {
      const userTaskKey = it.userTaskKey ?? it.key;
      if (userTaskKey == null || userTaskKey === "") {
        this.log("warn", "skipping user task with no key in engine response");
        return [];
      }
      // The engine resolves a `formId="X"` linkage to the latest deployed form's key at
      // task creation, so `formKey` (not a form id) is the linkage it reports on the task.
      const formKey =
        it.formKey != null && it.formKey !== "" ? String(it.formKey) : undefined;
      const externalFormReference =
        typeof it.externalFormReference === "string" && it.externalFormReference !== ""
          ? it.externalFormReference
          : undefined;
      return [{
        userTaskKey: String(userTaskKey),
        elementId: typeof it.elementId === "string" ? it.elementId : undefined,
        variables: isRecord(it.variables) ? it.variables : undefined,
        ...(formKey ? { formKey } : {}),
        ...(externalFormReference ? { externalFormReference } : {}),
      }];
    });
  }

  async getForm(input: { formKey?: string; formId?: string }): Promise<FormSchema | null> {
    // The engine addresses deployed forms by key (`GET /forms/{formKey}`). A user task's
    // `formKey` is the engine's resolution of its `formId` linkage to the latest deployed
    // form, so callers pass that key. `formId` is accepted as a fallback identifier for
    // engines that address a form by its id; either way the engine returns the current
    // form or 404s (→ null) when there is no such form.
    //
    // This is the single gate that resolves which identifier addresses the form: an
    // empty/whitespace identifier is treated as *absent* (via `presentFormIdentifier`, the
    // shared presence rule) so a blank `formKey` (e.g. a `?formKey=` query param) falls
    // through to a valid `formId` instead of being taken as a present-but-unresolvable key
    // that short-circuits to null.
    const key = presentFormIdentifier(input.formKey) ?? presentFormIdentifier(input.formId);
    if (key == null) return null;
    let body: Record<string, unknown>;
    try {
      body = await this.client.getFormByKey(
        { formKey: key },
        { consistency: { waitUpToMs: 0 } },
      );
    } catch (err) {
      this.log("warn", "getForm: engine form fetch failed", {
        key,
        formKey: input.formKey,
        formId: input.formId,
        err: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
    if (!isRecord(body)) return null;
    const rawSchema = body.schema;
    // The engine serializes the form-js schema as a JSON string; parse it to the object
    // the surface renders. Tolerate an already-parsed object (an in-memory/embedded engine).
    let schema: Record<string, unknown> | undefined;
    if (typeof rawSchema === "string") {
      try {
        const parsed: unknown = JSON.parse(rawSchema);
        if (isRecord(parsed)) schema = parsed;
      } catch {
        this.log("warn", "getForm: form schema is not valid JSON", { key, formKey: input.formKey, formId: input.formId });
      }
    } else if (isRecord(rawSchema)) {
      schema = rawSchema;
    }
    if (!schema) return null;
    return {
      schema,
      ...(body.formKey != null && body.formKey !== "" ? { formKey: String(body.formKey) } : {}),
      ...(typeof body.formId === "string" && body.formId !== "" ? { formId: body.formId } : {}),
      ...(typeof body.version === "number" ? { version: body.version } : {}),
    };
  }

  async completeUserTask(userTaskKey: string, variables?: Record<string, unknown>): Promise<void> {
    await this.client.completeUserTask({ userTaskKey, variables: variables ?? {} });
  }

  async searchProcessInstances(filter?: {
    processInstanceKeys?: string[];
    state?: ProcessInstanceState;
  }): Promise<ProcessInstanceSnapshot[]> {
    const f: Record<string, unknown> = {};
    if (filter?.state) f.state = filter.state;
    const keys = filter?.processInstanceKeys?.filter((k) => k != null && k !== "");
    if (keys && keys.length > 0) f.processInstanceKey = { $in: keys };
    // A process-instance search is an eventually consistent read; ask for zero-wait
    // consistency so it reflects what is currently visible without blocking. Cap the page
    // to the number of keys asked for (each key matches at most one instance), so a bounded
    // reconcile query never silently truncates on the API's default page size.
    const page = keys && keys.length > 0 ? { limit: keys.length } : undefined;
    const body = await this.client.searchProcessInstances(
      { filter: f, ...(page ? { page } : {}) },
      { consistency: { waitUpToMs: 0 } },
    );
    const items = Array.isArray(body.items) ? body.items.filter(isRecord) : [];
    return items.flatMap((it) => {
      const key = it.processInstanceKey;
      if (key == null || key === "") {
        this.log("warn", "skipping process instance with no key in engine response");
        return [];
      }
      const state = normalizeProcessInstanceState(it.state);
      if (!state) {
        this.log("warn", "skipping process instance with unrecognized state", {
          processInstanceKey: String(key),
          state: String(it.state),
        });
        return [];
      }
      return [{ processInstanceKey: String(key), state }];
    });
  }

  async registerWorker(
    jobType: string,
    handler: JobHandler,
    options?: { workerName?: string; maxParallelJobs?: number; fetchVariables?: string[] },
  ): Promise<WorkerSubscription> {
    const worker = this.client.createJobWorker({
      jobType,
      workerName: options?.workerName ?? `urban:${jobType}`,
      maxParallelJobs: options?.maxParallelJobs ?? 8,
      fetchVariables: options?.fetchVariables,
      jobHandler: async (job) => {
        const rawKey = job.jobKey;
        if (rawKey == null || rawKey === "") {
          this.log("warn", `activation ${jobType}: skipping job with no jobKey in engine response`);
          return undefined;
        }
        const engineJob: EngineJob = {
          jobKey: String(rawKey),
          jobType,
          processInstanceKey:
            job.processInstanceKey != null ? String(job.processInstanceKey) : undefined,
          elementId: job.elementId,
          variables: job.variables ?? {},
        };
        let out: Record<string, unknown> | void;
        try {
          out = await handler(engineJob);
        } catch (err) {
          // A handler-raised BPMN error is a modelled, non-retryable outcome:
          // report it as a BPMN error (routed to an error boundary/event) rather
          // than a plain failure. If the transport lacks `error` (older SDK) — or
          // the `error` call itself fails — fall through to the `fail` path below
          // so the job is still acknowledged rather than left to lock-timeout.
          if (isBpmnError(err) && typeof job.error === "function") {
            // `message` is typed loosely (the guard survives module duplication),
            // so coerce to a string before slicing to avoid a secondary crash.
            const raw = err.message;
            const message = typeof raw === "string" && raw.length > 0 ? raw : err.errorCode;
            this.log("info", `handler ${jobType} raised BPMN error`, {
              errorCode: err.errorCode,
            });
            try {
              return await job.error({
                errorCode: err.errorCode,
                errorMessage: message.slice(0, 500),
              });
            } catch (errReportErr) {
              this.log("warn", `handler ${jobType}: BPMN error report failed, failing the job`, {
                err: errReportErr instanceof Error ? errReportErr.message : String(errReportErr),
              });
              // fall through to the fail path
            }
          }
          const message = err instanceof Error ? err.message : String(err);
          this.log("error", `handler ${jobType} threw`, {
            err: message,
            jobKey: engineJob.jobKey,
            processInstanceKey: engineJob.processInstanceKey,
            elementId: engineJob.elementId,
          });
          try {
            // A generic handler failure omits the retry count so the SDK decrements the job's
            // remaining retries (`job.retries - 1`): a transient failure (e.g. a fleeting store
            // error) self-heals on redelivery and only parks as an incident once the budget is
            // exhausted. A `BpmnError` reaching here (no `job.error()` transport, or the error
            // report itself threw) is the exception: it is a modelled, DETERMINISTIC outcome, so
            // retrying would re-throw the same error and burn the budget for nothing — pin
            // `retries: 0` to keep it non-retryable. Await + swallow so a rejected `fail` cannot
            // escape as an unhandled rejection.
            const body: { errorMessage: string; retries?: number } = {
              errorMessage: message.slice(0, 500),
            };
            if (isBpmnError(err)) body.retries = 0;
            return await job.fail(body);
          } catch {
            return undefined;
          }
        }
        // The handler resolved: its work is done. Reporting that result to the engine
        // (`complete`) is a SEPARATE concern — a failure here is a transport/engine problem
        // (e.g. a transient store error), NOT a handler bug. Failing it (even with a decrementing
        // retry) would burn the job's retry budget for a completion we can't confirm didn't land.
        // Instead, log and leave the job locked so the engine redelivers it on lock timeout;
        // handlers are idempotent (at-least-once), so a redelivery re-completes cleanly.
        try {
          return await job.complete(out ?? {});
        } catch (completeErr) {
          const message = completeErr instanceof Error ? completeErr.message : String(completeErr);
          this.log("error", `complete ${jobType} failed; leaving job for engine redelivery`, {
            err: message,
            jobKey: engineJob.jobKey,
            processInstanceKey: engineJob.processInstanceKey,
            elementId: engineJob.elementId,
          });
          return undefined;
        }
      },
    });
    // The nano-sdk job worker owns its own start lifecycle: `createJobWorker` runs
    // async Nano/Falcon detection and, once the transport is bound, starts polling
    // itself (Falcon) or hands off to an auto-started REST worker. Calling `start()`
    // here would race that detection and dereference a still-null transport, so we
    // don't — the worker autostarts.
    this.workers.add(worker);

    return {
      jobType,
      unsubscribe: async () => {
        await this.stopWorker(worker);
        this.workers.delete(worker);
      },
    };
  }

  /** Stop one worker, tolerating a Falcon worker whose transport never bound
   *  (detection still pending) — its `stop` throws, which must not fail teardown. */
  private async stopWorker(worker: NanoSdkJobWorker): Promise<void> {
    try {
      await (worker.stopGracefully ? worker.stopGracefully() : worker.stop());
    } catch {
      /* worker never fully started (transport unbound); nothing to drain */
    }
  }

  async close(): Promise<void> {
    for (const w of this.workers) await this.stopWorker(w);
    this.workers.clear();
    try {
      // Also drain any REST-fallback worker the SDK started internally (its handle is
      // not the one we hold), which `stopWorker` above cannot reach.
      await this.client.stopAllWorkers?.();
    } catch {
      /* no workers running / already stopped */
    }
    try {
      await this.client.close?.();
    } catch {
      /* transport already closed / never opened */
    }
  }
}

export interface NanoSdkEngineOptions {
  /** REST base, e.g. http://localhost:8080/v2. */
  restAddress: string;
  token?: string;
  /** CAMUNDA_TRANSPORT: "auto" | "falcon" | "rest" | "embedded". Passed to createCamundaClient. */
  transport?: string;
  log?: Log;
  /** Test seam: inject a ready-made SDK client (or a compatible fake). */
  client?: NanoSdkClient;
  /** Test seam: provide the SDK client factory instead of importing @nanobpm/nano-sdk. */
  createClient?: (opts: { restAddress: string; token?: string; transport?: string }) => NanoSdkClient;
}

async function importNanoSdk(): Promise<
  (opts: Record<string, unknown>) => NanoSdkClient
> {
  // Indirect the specifier so the (lazily loaded) module is not resolved at
  // typecheck time and stays out of the import graph for injected-client paths.
  const spec = "@nanobpm/nano-sdk";
  const mod: unknown = await import(spec);
  if (!isNanoSdkModule(mod)) {
    throw new Error("@nanobpm/nano-sdk does not export createCamundaClient");
  }
  return mod.createCamundaClient;
}

function isNanoSdkModule(value: unknown): value is {
  createCamundaClient: (opts: Record<string, unknown>) => NanoSdkClient;
} {
  return isRecord(value) && typeof value.createCamundaClient === "function";
}

/**
 * Build the Urban runtime's `EngineClient`, backed by a single `@nanobpm/nano-sdk`
 * client. Provide a `client`/`createClient` seam to inject a fake (tests, embedded
 * transport); otherwise a client is constructed from `restAddress`/`token`/`transport`.
 */
export async function createNanoSdkEngineClient(
  opts: NanoSdkEngineOptions,
): Promise<EngineClient> {
  const log = opts.log ?? (() => {});
  let client: NanoSdkClient;
  if (opts.client) {
    client = opts.client;
  } else if (opts.createClient) {
    client = opts.createClient({
      restAddress: opts.restAddress,
      token: opts.token,
      transport: opts.transport,
    });
  } else {
    const createCamundaClient = await importNanoSdk();
    client = createCamundaClient({
      config: {
        CAMUNDA_REST_ADDRESS: opts.restAddress,
        ...(opts.token ? { CAMUNDA_TOKEN: opts.token } : {}),
        CAMUNDA_TRANSPORT: opts.transport ?? "auto",
      },
    });
  }
  return new SdkEngineClient(client, log);
}
