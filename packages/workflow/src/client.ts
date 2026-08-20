// A client for a running nanobpmn gateway, built on `@nanobpm/nano-sdk` (the
// single engine-transport spine — ADR 0055). It derives a workflow's model,
// deploys it (with diagram interchange), starts instances, and correlates
// signals; the low-level job protocol used by the Worker runtime is the SDK's
// own job worker, reached through the exposed `sdk` client.

import { createCamundaClient, JobActionReceiptSymbol, ProcessDefinitionId, ProcessInstanceKey } from "@nanobpm/nano-sdk";
import { declarativeToBpmn, walkNodes } from "./declarative.js";
import { imperativeToBpmn } from "./imperative.js";
import { layoutBpmn } from "./layout.js";
import type { DeclarativeFlow, DeployResult, Job, Json, JsonObject, StartResult, Workflow } from "./types.js";
import { assertWorkflowIds, messageName } from "./xml.js";

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function errorCause(e: unknown): unknown {
  return isRecord(e) ? e.cause : undefined;
}

function errorCode(e: unknown): unknown {
  return isRecord(e) ? e.code : undefined;
}

function errorMessage(e: unknown): string {
  return isRecord(e) && typeof e.message === "string" ? e.message : String(e);
}

function errorStatus(e: unknown): number | undefined {
  if (!isRecord(e)) return undefined;
  if (typeof e.status === "number") return e.status;
  const response = e.response;
  return isRecord(response) && typeof response.status === "number" ? response.status : undefined;
}

function isJson(v: unknown): v is Json {
  if (v === null) return true;
  switch (typeof v) {
    case "boolean":
    case "number":
    case "string":
      return true;
    case "object":
      if (Array.isArray(v)) return v.every(isJson);
      return Object.values(v).every(isJson);
    default:
      return false;
  }
}

function toJsonObject(v: unknown): JsonObject {
  if (!isRecord(v)) throw new Error("SDK response was not an object");
  const result: JsonObject = {};
  for (const [key, value] of Object.entries(v)) {
    if (isJson(value)) result[key] = value;
  }
  return result;
}

/** Render a workflow (either surface) to its executable BPMN model. */
export function toBpmn(wf: Workflow): string {
  assertWorkflowIds(wf);
  return wf.kind === "imperative" ? imperativeToBpmn(wf) : declarativeToBpmn(wf);
}

let warnedNoLayout = false;

/**
 * Render a workflow to *deployable* BPMN — the executable model plus diagram
 * interchange (DI), auto-generated with `bpmn-auto-layout` — so the deployed
 * process opens rendered and inspectable in a modeller/Operate rather than as a
 * blank canvas. The semantic model stays authoritative; DI is derived.
 *
 * DI generation needs the optional peer dependency `bpmn-auto-layout`. When it is
 * absent, this degrades gracefully: it warns once and returns the DI-less model
 * so `deploy` still works everywhere. Pass `{ layout: false }` to skip layout
 * deliberately. A genuine layout failure (the dep is installed but errors) is
 * surfaced, not swallowed.
 */
export async function toDeployableBpmn(
  wf: Workflow,
  opts: { layout?: boolean } = {},
): Promise<string> {
  const semantic = toBpmn(wf);
  if (opts.layout === false) return semantic;
  try {
    return await layoutBpmn(semantic);
  } catch (e) {
    // Only fall back for the "optional dep not installed" case (layoutBpmn wraps
    // it with an ERR_MODULE_NOT_FOUND cause). Any other failure is a real layout
    // problem and must surface rather than silently deploy an uninspectable model.
    const cause = errorCause(e);
    if (errorCode(cause) !== "ERR_MODULE_NOT_FOUND") throw e;
    if (!warnedNoLayout) {
      warnedNoLayout = true;
      console.warn(
        `[@nanobpm/workflow] Deploying "${wf.id}" without a diagram: the optional ` +
          '"bpmn-auto-layout" dependency is not installed, so the model will be ' +
          "uninspectable in a modeller/Operate. Install it for diagram layout: " +
          "npm i bpmn-auto-layout",
      );
    }
    return semantic;
  }
}


/**
 * The subset of the `@nanobpm/nano-sdk` (Camunda orchestration-cluster) client
 * that the workflow surface uses. `createCamundaClient` returns a superset of
 * this, so a test — or an author bringing their own transport (e.g. the embedded
 * engine) — can inject any object satisfying it.
 */
export interface NanoSdkClient {
  createDeployment(
    input: { resources: File[]; [k: string]: unknown },
    options?: unknown,
  ): Promise<unknown>;
  createProcessInstance(
    input: { processDefinitionId: string; variables?: JsonObject },
    options?: unknown,
  ): Promise<unknown>;
  correlateMessage(
    input: { name: string; correlationKey: string; variables?: JsonObject },
    options?: unknown,
  ): Promise<unknown>;
  getProcessInstance(
    input: { processInstanceKey: string },
    consistency: { consistency: { waitUpToMs: number } },
    options?: unknown,
  ): Promise<unknown>;
  createJobWorker(cfg: JobWorkerConfig): NanoJobWorker;
}

/** Config for a nano-sdk job worker (the subset the Worker runtime sets). */
export interface JobWorkerConfig {
  jobType: string;
  jobHandler: (job: ActivatedJob) => Promise<unknown> | unknown;
  workerName?: string;
  maxParallelJobs?: number;
  /** Job lock timeout in ms. */
  jobTimeoutMs?: number;
  /** Long-poll timeout in ms. */
  pollTimeoutMs?: number;
  /** Start polling immediately. The Worker runtime sets this false and starts explicitly. */
  autoStart?: boolean;
}

/** The handle returned by `createJobWorker`. */
export interface NanoJobWorker {
  start(): void;
  stop(): void | Promise<void>;
  stopGracefully?(opts?: { waitUpToMs?: number }): Promise<void>;
}

/** The subset of a raw `@nanobpm/nano-sdk` job worker the adapter drives. Its
 *  `start()` may be synchronous or async: on nano-sdk >=1.2.5's Falcon/auto path
 *  it is async and the SDK self-starts the worker after an asynchronous transport
 *  bind (see {@link adaptJobWorker}). */
export interface RawNanoJobWorker {
  start(): void | Promise<void>;
  stop(): void | Promise<void>;
  stopGracefully(opts?: { waitUpToMs?: number }): Promise<unknown>;
}

/** Adapt a raw `@nanobpm/nano-sdk` job worker to the {@link NanoJobWorker} handle
 *  the Worker runtime drives, making the eager `start()` NULL-SAFE.
 *
 *  nano-sdk >=1.2.5's Falcon/auto worker SELF-STARTS after an ASYNCHRONOUS
 *  transport bind: `createJobWorker` hands back a worker whose transport is null
 *  until Nano is detected, at which point the SDK `bindTransport(t)`s it and
 *  `start()`s the worker ITSELF. Calling `start()` before that bind dereferences
 *  the null transport and — because `start()` is async — surfaces as an UNHANDLED
 *  REJECTION that crashes the process
 *  (`TypeError: Cannot read properties of null (reading 'subscribe')`, #415). The
 *  REST/manual worker, by contrast, never self-starts, so `start()` must still be
 *  called here. We resolve the version-skew by starting eagerly but NULL-SAFELY:
 *  swallow ONLY the pre-bind race (the SDK self-starts once the transport binds)
 *  and SURFACE any other start failure via `console.warn` rather than masking it.
 *  The SDK owns the start lifecycle end to end (it logs and falls back to REST on
 *  its own subscribe failure), so discarding the resolved result — as the previous
 *  `void worker.start()` already did — is safe. Pairs with the library-side
 *  null-safe, idempotent start (jwulf/nano-sdk-js#12) so neither an eager nor a
 *  duplicate start can crash. */
export function adaptJobWorker(worker: RawNanoJobWorker): NanoJobWorker {
  return {
    start: () => {
      try {
        const started = worker.start();
        if (isPromiseLike(started)) started.then(undefined, handleStartError);
      } catch (e) {
        handleStartError(e);
      }
    },
    stop: () => worker.stop(),
    stopGracefully: async (opts) => {
      await worker.stopGracefully(opts);
    },
  };
}

function isPromiseLike(v: unknown): v is PromiseLike<unknown> {
  return isRecord(v) && typeof v.then === "function";
}

/** The SDK's pre-bind start race is a NULL/undefined-transport dereference the SDK
 *  recovers from via its own self-start: a `TypeError` from reading the transport's
 *  `subscribe` off a `null`/`undefined` transport
 *  (`Cannot read properties of null (reading 'subscribe')`, #415). Match it NARROWLY
 *  — the specific `subscribe` dereference signature, not any null/undefined deref —
 *  so a genuine start failure on the REST/manual path (or an unrelated null-deref
 *  bug during `start()`) is never mistaken for the race and silently masked. */
function isPreBindStartRace(e: unknown): boolean {
  return (
    e instanceof TypeError &&
    /Cannot read propert(?:y|ies) of (?:null|undefined) \(reading ['"]subscribe['"]\)/.test(e.message)
  );
}

/** Handle an eager-start error NULL-SAFELY. Swallow ONLY the SDK's known pre-bind
 *  transport race (it self-starts once its transport binds — see
 *  {@link adaptJobWorker}); any OTHER error is a real start failure (e.g. on the
 *  REST/manual path) and is SURFACED via `console.warn` so it is not silently
 *  masked. Never rethrows — callers rely on this to keep an async `start()` from
 *  escaping as an unhandled rejection that crashes the process. The SDK owns the
 *  start lifecycle end to end (it logs and falls back to REST on its own subscribe
 *  failure), so we surface-and-continue rather than propagate. */
function handleStartError(e: unknown): void {
  if (isPreBindStartRace(e)) return;
  console.warn(
    "[@nanobpm/workflow] job worker start() failed (not the known pre-bind transport " +
      "race); the SDK owns start and REST fallback, so this is surfaced but not rethrown:",
    e,
  );
}

/** An activated job as delivered to a nano-sdk job handler: the workflow `Job`
 *  fields plus the acknowledgement actions. */
export type ActivatedJob = Job & {
  complete(variables?: JsonObject): Promise<unknown>;
  fail(body: { errorMessage: string; retries?: number }): Promise<unknown>;
};

/** Options common to both ways of building a `WorkflowClient`. */
interface WorkflowClientCommon {
  /** Auth token for the gateway (CAMUNDA_TOKEN). */
  token?: string;
  /** Transport mode passed to `createCamundaClient`: "auto" | "falcon" | "rest".
   *  Default "auto" (Falcon on a Nano server, REST elsewhere). */
  transport?: "auto" | "falcon" | "rest";
}

/** Construct a `WorkflowClient` from **either** a `baseUrl` (a nano-sdk client is
 *  built for you) **or** a pre-built `client`. The union makes TypeScript enforce
 *  that exactly one is supplied, matching the constructor's runtime requirement. */
export type WorkflowClientOptions =
  | (WorkflowClientCommon & {
      /** Base URL of the nanobpmn gateway, e.g. `http://localhost:8080`. The
       *  nano-sdk client normalises this to the `/v2` REST address. */
      baseUrl: string;
      client?: never;
    })
  | (WorkflowClientCommon & {
      /** Inject a pre-built nano-sdk client (or a compatible fake) instead of
       *  constructing one from `baseUrl`. Useful for tests, the embedded
       *  transport, and advanced authors who build the client themselves. */
      client: NanoSdkClient;
      baseUrl?: never;
    });

export class WorkflowError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly body?: string,
  ) {
    super(message);
    this.name = "WorkflowError";
  }
}

/** Normalise a thrown SDK/transport error into a WorkflowError, preserving an
 *  HTTP status when the SDK attached one. */
function asWorkflowError(e: unknown, what: string): WorkflowError {
  if (e instanceof WorkflowError) return e;
  const status = errorStatus(e);
  return new WorkflowError(`${what} failed: ${errorMessage(e)}`, status);
}

export class WorkflowClient {
  /** The underlying nano-sdk client, exposed so the Worker runtime and app
   *  authors can reach the engine through the same transport (ADR 0055). The
   *  exported `NanoSdkClient` type intentionally models only the subset of
   *  methods this package uses (deploy, create, correlate, get, job workers);
   *  the runtime value is the full nano-sdk client. */
  readonly sdk: NanoSdkClient;

  constructor(opts: WorkflowClientOptions) {
    if (opts?.client) {
      this.sdk = opts.client;
      return;
    }
    if (!opts?.baseUrl) throw new Error("WorkflowClient needs a baseUrl or a client");
    const raw = createCamundaClient({
      config: {
        CAMUNDA_REST_ADDRESS: opts.baseUrl.replace(/\/+$/, ""),
        ...(opts.token ? { CAMUNDA_TOKEN: opts.token } : {}),
        CAMUNDA_TRANSPORT: opts.transport ?? "auto",
      },
    });
    this.sdk = {
      createDeployment: (input) => raw.createDeployment(input),
      createProcessInstance: (input) =>
        raw.createProcessInstance(
          {
            ...input,
            processDefinitionId: ProcessDefinitionId.assumeExists(input.processDefinitionId),
          },
        ),
      correlateMessage: (input) => raw.correlateMessage(input),
      getProcessInstance: (input, consistency) =>
        raw.getProcessInstance(
          {
            processInstanceKey: ProcessInstanceKey.assumeExists(input.processInstanceKey),
          },
          consistency,
        ),
      createJobWorker: (cfg) => {
        const worker = raw.createJobWorker({
          ...cfg,
          jobHandler: async (job) => {
            await cfg.jobHandler(job);
            return JobActionReceiptSymbol;
          },
        });
        return adaptJobWorker(worker);
      },
    };
  }

  /**
   * Deploy a workflow's derived BPMN model. The deployed model includes
   * auto-generated diagram interchange (DI) so it is inspectable in a
   * modeller/Operate; pass `{ layout: false }` to deploy the DI-less semantic
   * model. DI needs the optional `bpmn-auto-layout` dependency — see
   * `toDeployableBpmn` for the graceful-degradation behaviour when it is absent.
   */
  async deploy(wf: Workflow, opts: { layout?: boolean } = {}): Promise<DeployResult> {
    const xml = await toDeployableBpmn(wf, opts);
    const file = new File([xml], `${wf.id}.bpmn`, { type: "text/xml" });
    try {
      return toJsonObject(await this.sdk.createDeployment({ resources: [file] }));
    } catch (e) {
      throw asWorkflowError(e, "deploy");
    }
  }

  /**
   * Start a workflow instance. For imperative workflows the engine variables are
   * seeded with `{ input, journal: {}, wfDone: false }` (the replay state); for
   * declarative flows `input` becomes the instance variables directly.
   */
  async start(wf: Workflow, input: JsonObject = {}): Promise<StartResult> {
    const variables: JsonObject =
      wf.kind === "imperative" ? { input, journal: {}, wfDone: false } : input;
    try {
      return toJsonObject(await this.sdk.createProcessInstance({
        processDefinitionId: wf.id,
        variables,
      }));
    } catch (e) {
      throw asWorkflowError(e, "start");
    }
  }

  /** Correlate a signal to a parked declarative `signal` step. Fails fast on an
   *  unknown signal name (a typo would otherwise send an uncorrelatable message
   *  that the gateway silently drops). */
  async signal(
    flow: DeclarativeFlow,
    signalName: string,
    correlationKey: string,
    variables: JsonObject = {},
  ): Promise<JsonObject> {
    // Signal steps can live anywhere in the tree (inside switch/branch/loop),
    // so walk the whole flow, not just the top-level sequence.
    const signals: string[] = [];
    walkNodes(flow.steps, (n) => {
      if (n.kind === "signal") signals.push(n.name);
    });
    if (!signals.includes(signalName)) {
      throw new WorkflowError(
        `unknown signal "${signalName}" on flow "${flow.id}" — declared signals: ${
          signals.length ? signals.map((s) => `"${s}"`).join(", ") : "(none)"
        }`,
      );
    }
    try {
      return toJsonObject(await this.sdk.correlateMessage({
        name: messageName(flow.id, signalName),
        correlationKey,
        variables,
      }));
    } catch (e) {
      throw asWorkflowError(e, `signal "${signalName}"`);
    }
  }

  /** Fetch an instance (used by demos/tests to observe completion). Reads with
   *  zero-wait consistency; returns null when the instance is not (yet) visible. */
  async getInstance(processInstanceKey: string): Promise<JsonObject | null> {
    try {
      return toJsonObject(await this.sdk.getProcessInstance(
        { processInstanceKey },
        { consistency: { waitUpToMs: 0 } },
      ));
    } catch {
      return null;
    }
  }
}
