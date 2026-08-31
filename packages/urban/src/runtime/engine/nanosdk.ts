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
  ElementInstanceState,
  ElementInstanceSummary,
  ElementInstanceFilter,
  ElementInstanceWaitState,
  ElementInstanceWaitStateFilter,
  WaitStateType,
  EngineJob,
  FormSchema,
  IncidentFilter,
  IncidentState,
  IncidentSummary,
  JobFilter,
  JobHandler,
  JobSummary,
  ProcessInstanceSnapshot,
  ProcessInstanceState,
  UserTaskState,
  UserTaskSummary,
  UserTaskFilter,
  VariableFilter,
  VariableSummary,
  WorkerSubscription,
} from "../core/host.ts";
import { assertDeployedWaitStateType, isBpmnError } from "../core/host.ts";
import {
  buildFormSchema,
  parseFormSchema,
  pickFormLinkage,
  resolveFormIdentifier,
} from "../core/form-contract.ts";
import type { EngineSdkClient } from "./sdk.ts";
import { isRecord } from "../core/guards.ts";
import { applyAmbientLineage } from "../core/lineage.ts";

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

/** Map the engine's element-instance `state` onto the transport-agnostic
 *  {@link ElementInstanceState} union, or `undefined` for an unrecognized value (which the
 *  caller skips rather than surfacing a malformed row). Case-insensitive so a future casing
 *  tweak on the engine side doesn't silently drop element instances. Kept separate from
 *  {@link normalizeProcessInstanceState} — the two model distinct engine enums that only
 *  coincide today — so element and process state can diverge without a hidden coupling. */
export function normalizeElementInstanceState(
  raw: unknown,
): ElementInstanceState | undefined {
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

/** Map the engine's wait-state `waitStateType` onto the transport-agnostic
 *  {@link WaitStateType} union, or `undefined` for an unrecognized value. Case-insensitive
 *  so a casing tweak doesn't silently drop parks. */
export function normalizeWaitStateType(raw: unknown): WaitStateType | undefined {
  if (typeof raw !== "string") return undefined;
  switch (raw.toUpperCase()) {
    case "JOB":
      return "JOB";
    case "MESSAGE":
      return "MESSAGE";
    case "USER_TASK":
      return "USER_TASK";
    case "TIMER":
      return "TIMER";
    case "SIGNAL":
      return "SIGNAL";
    case "CONDITION":
      return "CONDITION";
    default:
      return undefined;
  }
}

/** Map the engine's incident `state` onto the transport-agnostic {@link IncidentState} union,
 *  falling back to `"UNKNOWN"` for an unrecognized/absent value (an incident is never dropped
 *  for an odd state — unlike element/process rows, whose state is a hard identity field — so a
 *  caller still sees the fault). Case-insensitive so a casing tweak doesn't mis-map. */
export function normalizeIncidentState(raw: unknown): IncidentState {
  if (typeof raw !== "string") return "UNKNOWN";
  switch (raw.toUpperCase()) {
    case "ACTIVE":
      return "ACTIVE";
    case "MIGRATED":
      return "MIGRATED";
    case "PENDING":
      return "PENDING";
    case "RESOLVED":
      return "RESOLVED";
    default:
      return "UNKNOWN";
  }
}

/** A non-empty string form of an engine key/id, or `undefined` when absent/blank (including a
 *  whitespace-only string). Coerces a numeric key to a string (the engine may serialize a key
 *  either way) but never `String(...)`-coerces an arbitrary object into a garbage
 *  `"[object Object]"` id. The blank check trims, matching `getElementInstance`'s blank-key
 *  guard and the form-key presence helpers, so a `"   "` key can never leak into a result. */
function presentEngineKey(value: unknown): string | undefined {
  if (typeof value === "number") {
    return Number.isFinite(value) ? String(value) : undefined;
  }
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

/** The non-empty, trimmed string form of a *required* engine key, or throws when the value is
 *  absent/blank (including a whitespace-only string). A mutating seam operation addresses a
 *  single entity by key, so a blank key is a caller bug that must fail fast with an actionable
 *  message rather than reach the engine as an empty path segment / invalid changeset and surface
 *  an opaque transport error. Reuses {@link presentEngineKey}'s trim-and-coerce rule so a padded
 *  key like `" 5 "` is normalized identically to how read paths resolve it. */
function requireEngineKey(value: unknown, name: string): string {
  const key = presentEngineKey(value);
  if (key === undefined) {
    throw new Error(`${name} must be a non-empty key`);
  }
  return key;
}

/** A required text field (a wait-state discriminator's `jobType`/`messageName`/`signalName`),
 *  or `undefined` when absent or blank — the caller skips the row rather than emitting a typed
 *  wait state carrying an empty required string. Returns the trimmed value, matching the
 *  presence rule used for keys, so surrounding whitespace can never leak into a result. */
function presentText(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

/** The element type carried on an element-instance/wait-state row. The Camunda SDK DTO calls
 *  it `type`; a plain REST/Rust-engine body may call it `elementType`. Accept either. */
function pickElementType(row: Record<string, unknown>): string | undefined {
  return presentText(row.elementType) ?? presentText(row.type);
}

/** Map one engine element-instance row onto an {@link ElementInstanceSummary}, or `undefined`
 *  when the row is malformed (missing key/elementId/process instance, or an unrecognized
 *  state). The single source of truth both `searchElementInstances` and `getElementInstance`
 *  extract through, so the two cannot drift. */
export function mapElementInstanceRow(
  row: Record<string, unknown>,
  log: Log,
): ElementInstanceSummary | undefined {
  const elementInstanceKey = presentEngineKey(row.elementInstanceKey);
  if (elementInstanceKey === undefined) {
    log("warn", "skipping element instance with no key in engine response");
    return undefined;
  }
  const processInstanceKey = presentEngineKey(row.processInstanceKey);
  if (processInstanceKey === undefined) {
    log("warn", "skipping element instance with no processInstanceKey in engine response", {
      elementInstanceKey,
    });
    return undefined;
  }
  const elementId = typeof row.elementId === "string" && row.elementId.trim() !== ""
    ? row.elementId.trim()
    : undefined;
  if (elementId === undefined) {
    log("warn", "skipping element instance with no elementId in engine response", {
      elementInstanceKey,
    });
    return undefined;
  }
  const state = normalizeElementInstanceState(row.state);
  if (state === undefined) {
    log("warn", "skipping element instance with unrecognized state", {
      elementInstanceKey,
      state: String(row.state),
    });
    return undefined;
  }
  const elementType = pickElementType(row);
  return {
    elementInstanceKey,
    processInstanceKey,
    elementId,
    ...(elementType ? { elementType } : {}),
    state,
  };
}

/** Map one engine wait-state row onto an {@link ElementInstanceWaitState}, or `undefined`
 *  when the row is malformed (missing identity, or an unrecognized `waitStateType`). The
 *  Camunda SDK nests the park-specific fields under `details`; a plain REST body may inline
 *  them — read `details` first, then fall back to the row itself, so both wire shapes map. */
export function mapElementInstanceWaitStateRow(
  row: Record<string, unknown>,
  log: Log,
): ElementInstanceWaitState | undefined {
  const elementInstanceKey = presentEngineKey(row.elementInstanceKey);
  const processInstanceKey = presentEngineKey(row.processInstanceKey);
  const elementId = typeof row.elementId === "string" && row.elementId.trim() !== ""
    ? row.elementId.trim()
    : undefined;
  if (elementInstanceKey === undefined || processInstanceKey === undefined || elementId === undefined) {
    log("warn", "skipping element-instance wait state with incomplete identity in engine response");
    return undefined;
  }
  const details = isRecord(row.details) ? row.details : row;
  const waitStateType = normalizeWaitStateType(details.waitStateType ?? row.waitStateType);
  if (waitStateType === undefined) {
    log("warn", "skipping element-instance wait state with unrecognized waitStateType", {
      elementInstanceKey,
      waitStateType: String(details.waitStateType ?? row.waitStateType),
    });
    return undefined;
  }
  const elementType = pickElementType(row);
  const base = {
    elementInstanceKey,
    processInstanceKey,
    elementId,
    ...(elementType ? { elementType } : {}),
  };
  switch (waitStateType) {
    case "JOB": {
      // `jobType` is the required discriminator of a JOB park; without it the row is malformed.
      const jobType = presentText(details.jobType);
      if (jobType === undefined) {
        log("warn", "skipping JOB wait state with no jobType in engine response", {
          elementInstanceKey,
        });
        return undefined;
      }
      const jobKey = presentEngineKey(details.jobKey);
      return { ...base, waitStateType, jobType, ...(jobKey ? { jobKey } : {}) };
    }
    case "MESSAGE": {
      // `messageName` is the required discriminator of a MESSAGE park.
      const messageName = presentText(details.messageName);
      if (messageName === undefined) {
        log("warn", "skipping MESSAGE wait state with no messageName in engine response", {
          elementInstanceKey,
        });
        return undefined;
      }
      const correlationKey = presentText(details.correlationKey);
      return {
        ...base,
        waitStateType,
        messageName,
        ...(correlationKey ? { correlationKey } : {}),
      };
    }
    case "USER_TASK": {
      // `userTaskKey` is the required identity of a USER_TASK park; without it the row is
      // malformed. Skip it (like the missing-identity guards above) rather than emit a typed
      // wait state carrying an empty key that would break a downstream join.
      const userTaskKey = presentEngineKey(details.taskKey ?? details.userTaskKey);
      if (userTaskKey === undefined) {
        log("warn", "skipping USER_TASK wait state with no userTaskKey in engine response", {
          elementInstanceKey,
        });
        return undefined;
      }
      return { ...base, waitStateType, userTaskKey };
    }
    case "SIGNAL": {
      // `signalName` is the required discriminator of a SIGNAL park.
      const signalName = presentText(details.signalName);
      if (signalName === undefined) {
        log("warn", "skipping SIGNAL wait state with no signalName in engine response", {
          elementInstanceKey,
        });
        return undefined;
      }
      return { ...base, waitStateType, signalName };
    }
    case "TIMER":
      return { ...base, waitStateType };
    case "CONDITION":
      return { ...base, waitStateType };
  }
}

/** Map one engine incident row onto an {@link IncidentSummary}, or `undefined` when the row is
 *  malformed (missing the `incidentKey` or the owning `processInstanceKey` — the two identity
 *  fields a caller needs to resolve/act on it). `jobKey`/`elementInstanceKey`/`errorType`/
 *  `errorMessage` are best-effort diagnostics: present when the engine reports them, omitted
 *  otherwise. The single source of truth `searchIncidents` extracts through. */
export function mapIncidentRow(
  row: Record<string, unknown>,
  log: Log,
): IncidentSummary | undefined {
  const incidentKey = presentEngineKey(row.incidentKey);
  if (incidentKey === undefined) {
    log("warn", "skipping incident with no incidentKey in engine response");
    return undefined;
  }
  const processInstanceKey = presentEngineKey(row.processInstanceKey);
  if (processInstanceKey === undefined) {
    log("warn", "skipping incident with no processInstanceKey in engine response", {
      incidentKey,
    });
    return undefined;
  }
  const elementId = presentText(row.elementId);
  const elementInstanceKey = presentEngineKey(row.elementInstanceKey);
  const jobKey = presentEngineKey(row.jobKey);
  const errorType = presentText(row.errorType);
  const errorMessage = presentText(row.errorMessage);
  return {
    incidentKey,
    processInstanceKey,
    ...(elementId ? { elementId } : {}),
    ...(elementInstanceKey ? { elementInstanceKey } : {}),
    ...(jobKey ? { jobKey } : {}),
    ...(errorType ? { errorType } : {}),
    ...(errorMessage ? { errorMessage } : {}),
    state: normalizeIncidentState(row.state),
  };
}

/** Map one engine variable row onto a {@link VariableSummary}, or `undefined` when the row is
 *  malformed (missing the `variableKey`, owning `processInstanceKey`, or `name` — the identity a
 *  caller needs). `value` is the engine's serialized JSON value (a string); a non-string value is
 *  JSON-encoded so the field is always a string a caller can `JSON.parse`. `scopeKey` falls back to
 *  the process-instance key for a process-level variable that omits it. `isTruncated` is the
 *  engine's large-value-clipped flag, defaulting to `false`. The single source of truth
 *  `searchVariables` extracts through. */
export function mapVariableRow(
  row: Record<string, unknown>,
  log: Log,
): VariableSummary | undefined {
  const variableKey = presentEngineKey(row.variableKey);
  if (variableKey === undefined) {
    log("warn", "skipping variable with no variableKey in engine response");
    return undefined;
  }
  const processInstanceKey = presentEngineKey(row.processInstanceKey);
  if (processInstanceKey === undefined) {
    log("warn", "skipping variable with no processInstanceKey in engine response", {
      variableKey,
    });
    return undefined;
  }
  const name = presentText(row.name);
  if (name === undefined) {
    log("warn", "skipping variable with no name in engine response", { variableKey });
    return undefined;
  }
  // A process-level variable is scoped to the process instance itself; the engine may omit
  // `scopeKey` for it, so fall back to the process-instance key rather than dropping the row.
  const scopeKey = presentEngineKey(row.scopeKey) ?? processInstanceKey;
  // The engine serializes `value` as a JSON string. Keep a string as-is; encode any other type
  // (an object/array/number a permissive engine might inline) so the field is always a string the
  // caller can `JSON.parse`.
  const value = typeof row.value === "string" ? row.value : JSON.stringify(row.value ?? null);
  return {
    variableKey,
    name,
    value,
    scopeKey,
    processInstanceKey,
    isTruncated: row.isTruncated === true,
  };
}

/** Map one engine job row onto a {@link JobSummary}, or `undefined` when the row is malformed
 *  (missing the `jobKey`, `type`, or owning `processInstanceKey`). `worker`/`retries`/`elementId`/
 *  `deadline` are best-effort diagnostics: present when the engine reports them, omitted otherwise
 *  — an unset `worker` is the "queued, not leased" signal, so it must be absent rather than `""`.
 *  `state` is passed through as a bare string (the engine's job-state enum is broad). The single
 *  source of truth `searchJobs` extracts through. */
export function mapJobRow(
  row: Record<string, unknown>,
  log: Log,
): JobSummary | undefined {
  const jobKey = presentEngineKey(row.jobKey);
  if (jobKey === undefined) {
    log("warn", "skipping job with no jobKey in engine response");
    return undefined;
  }
  const type = presentText(row.type);
  if (type === undefined) {
    log("warn", "skipping job with no type in engine response", { jobKey });
    return undefined;
  }
  const processInstanceKey = presentEngineKey(row.processInstanceKey);
  if (processInstanceKey === undefined) {
    log("warn", "skipping job with no processInstanceKey in engine response", { jobKey });
    return undefined;
  }
  const state = presentText(row.state);
  if (state === undefined) {
    log("warn", "skipping job with no state in engine response", { jobKey });
    return undefined;
  }
  const worker = presentText(row.worker);
  const retries = typeof row.retries === "number" && Number.isFinite(row.retries)
    ? row.retries
    : undefined;
  const elementId = presentText(row.elementId);
  const deadline = presentText(row.deadline);
  return {
    jobKey,
    type,
    state,
    processInstanceKey,
    ...(worker ? { worker } : {}),
    ...(retries !== undefined ? { retries } : {}),
    ...(elementId ? { elementId } : {}),
    ...(deadline ? { deadline } : {}),
  };
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
  searchElementInstances(
    input: { filter?: Record<string, unknown>; page?: Record<string, unknown> },
    consistency?: unknown,
    options?: unknown,
  ): Promise<Record<string, unknown>>;
  searchElementInstanceWaitStates(
    input: { filter?: Record<string, unknown>; page?: Record<string, unknown> },
    consistency?: unknown,
    options?: unknown,
  ): Promise<Record<string, unknown>>;
  getElementInstance(
    input: { elementInstanceKey: string },
    consistency?: unknown,
    options?: unknown,
  ): Promise<Record<string, unknown>>;
  searchIncidents(
    input: { filter?: Record<string, unknown>; page?: Record<string, unknown> },
    consistency?: unknown,
    options?: unknown,
  ): Promise<Record<string, unknown>>;
  searchVariables(
    input: { filter?: Record<string, unknown>; page?: Record<string, unknown> },
    consistency?: unknown,
    options?: unknown,
  ): Promise<Record<string, unknown>>;
  searchJobs(
    input: { filter?: Record<string, unknown>; page?: Record<string, unknown> },
    consistency?: unknown,
    options?: unknown,
  ): Promise<Record<string, unknown>>;
  getProcessDefinitionXml(
    input: { processDefinitionKey: string },
    consistency?: unknown,
    options?: unknown,
  ): Promise<unknown>;
  resolveIncident(
    input: { incidentKey: string },
    options?: unknown,
  ): Promise<unknown>;
  updateJob(
    input: { jobKey: string; changeset: Record<string, unknown> },
    options?: unknown,
  ): Promise<unknown>;
  createElementInstanceVariables(
    input: { elementInstanceKey: string; variables: Record<string, unknown>; local?: boolean },
    options?: unknown,
  ): Promise<unknown>;
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
    // Auto-thread the `_urban.lineage` envelope (issue #254): a handler that spawns an
    // instance propagates its `rootRequestKey` and stamps `causedByInstanceKey`; a genuine
    // top-level request mints a fresh root. An explicit caller-supplied envelope wins.
    const body = await this.client.createProcessInstance({
      processDefinitionId: input.processDefinitionId,
      variables: applyAmbientLineage(input.variables),
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
    // Message-started instances inherit lineage too (issue #254): thread the envelope onto the
    // message variables so the instance the message starts carries `_urban.lineage`.
    await this.client.publishMessage({
      name: input.name,
      correlationKey: input.correlationKey ?? "",
      variables: applyAmbientLineage(input.variables),
    });
  }

  async searchUserTasks(filter?: UserTaskFilter & {
    state?: UserTaskState;
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
      // task creation, so `formKey` (not a form id) is the linkage it reports on the task;
      // no `resolveFormKeyByFormId` resolver is passed because the gateway already resolved it.
      return [{
        userTaskKey: String(userTaskKey),
        elementId: typeof it.elementId === "string" ? it.elementId : undefined,
        variables: isRecord(it.variables) ? it.variables : undefined,
        ...pickFormLinkage(it),
      }];
    });
  }

  /** The open (answerable) user tasks — `searchUserTasks` pinned to `state: "CREATED"`.
   *  The single safe accessor for reconcile/affordance paths (see `EngineClient.openUserTasks`);
   *  derives from `searchUserTasks` so the two cannot drift. */
  openUserTasks(filter?: UserTaskFilter): Promise<UserTaskSummary[]> {
    return this.searchUserTasks({ ...filter, state: "CREATED" });
  }

  async getForm(input: { formKey?: string; formId?: string }): Promise<FormSchema | null> {
    // The engine addresses deployed forms by key (`GET /forms/{formKey}`). A user task's
    // `formKey` is the engine's resolution of its `formId` linkage to the latest deployed
    // form, so callers pass that key. `formId` is accepted as a fallback identifier for
    // engines that address a form by its id; either way the engine returns the current
    // form or 404s (→ null) when there is no such form.
    //
    // This is the single gate that resolves which identifier addresses the form: an
    // empty/whitespace identifier is treated as *absent* (via the shared presence rule in
    // `resolveFormIdentifier`) so a blank `formKey` (e.g. a `?formKey=` query param) falls
    // through to a valid `formId` instead of being taken as a present-but-unresolvable key
    // that short-circuits to null. The REST gateway addresses a form by `value` regardless
    // of whether it is a deploy key or an authored id, so `kind` is not consulted here.
    const resolved = resolveFormIdentifier(input);
    if (resolved == null) return null;
    const key = resolved.value;
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
    // The engine serializes the form-js schema as a JSON string; parse it to the object
    // the surface renders. Tolerate an already-parsed object (an in-memory/embedded engine).
    const schema = parseFormSchema(body.schema);
    if (!schema) {
      if (typeof body.schema === "string") {
        this.log("warn", "getForm: form schema is not valid JSON", { key, formKey: input.formKey, formId: input.formId });
      }
      return null;
    }
    return buildFormSchema({
      schema,
      formKey: body.formKey,
      formId: body.formId,
      version: body.version,
    });
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
      return [{
        processInstanceKey: String(key),
        state,
        ...(presentEngineKey(it.processDefinitionKey)
          ? { processDefinitionKey: presentEngineKey(it.processDefinitionKey) }
          : {}),
      }];
    });
  }

  async searchElementInstances(
    filter?: ElementInstanceFilter,
  ): Promise<ElementInstanceSummary[]> {
    // Mirror `searchProcessInstances`: build the engine filter from the transport-agnostic
    // selectors, read at zero-wait consistency (an element-instance search is eventually
    // consistent), and map each row through the single `mapElementInstanceRow` gate — which
    // also `searchElementInstances`/`getElementInstance` share — dropping malformed rows.
    const f: Record<string, unknown> = {};
    if (filter?.processInstanceKey) f.processInstanceKey = filter.processInstanceKey;
    if (filter?.elementId) f.elementId = filter.elementId;
    if (filter?.state) f.state = filter.state;
    const body = await this.client.searchElementInstances(
      { filter: f },
      { consistency: { waitUpToMs: 0 } },
    );
    const items = Array.isArray(body.items) ? body.items.filter(isRecord) : [];
    return items.flatMap((it) => {
      const mapped = mapElementInstanceRow(it, this.log);
      return mapped ? [mapped] : [];
    });
  }

  async searchElementInstanceWaitStates(
    filter?: ElementInstanceWaitStateFilter,
  ): Promise<ElementInstanceWaitState[]> {
    // The wait-states search surfaces the parks the deployed engine's read model serves.
    // A `waitStateType` selector outside the deployed floor (`JOB | MESSAGE`) is rejected by
    // the gateway with HTTP 422; fail fast client-side with a clear error instead, so the
    // divergence is caught offline and identically to the WASM adapter (No Drift Surfaces).
    assertDeployedWaitStateType(filter?.waitStateType);
    // Same zero-wait read + per-row mapping-gate shape as `searchElementInstances`; the SDK
    // nests park-specific fields under `details`, which `mapElementInstanceWaitStateRow`
    // unwraps.
    const f: Record<string, unknown> = {};
    if (filter?.processInstanceKey) f.processInstanceKey = filter.processInstanceKey;
    if (filter?.elementId) f.elementId = filter.elementId;
    if (filter?.waitStateType) f.waitStateType = filter.waitStateType;
    const body = await this.client.searchElementInstanceWaitStates(
      { filter: f },
      { consistency: { waitUpToMs: 0 } },
    );
    const items = Array.isArray(body.items) ? body.items.filter(isRecord) : [];
    return items.flatMap((it) => {
      const mapped = mapElementInstanceWaitStateRow(it, this.log);
      return mapped ? [mapped] : [];
    });
  }

  async getElementInstance(
    elementInstanceKey: string,
  ): Promise<ElementInstanceSummary | null> {
    // A blank key can never address an element instance — short-circuit to null rather than
    // issue a `GET /element-instances/` with an empty segment. Normalize the key up front (as
    // `getForm` resolves a normalized identifier before fetching) so a padded-but-valid key
    // like `" 5 "` addresses the same element instance rather than 404ing on the raw segment.
    if (typeof elementInstanceKey !== "string" || elementInstanceKey.trim() === "") {
      return null;
    }
    const key = elementInstanceKey.trim();
    let body: Record<string, unknown>;
    try {
      body = await this.client.getElementInstance(
        { elementInstanceKey: key },
        { consistency: { waitUpToMs: 0 } },
      );
    } catch (err) {
      // A 404 (no such element instance) is an expected "not found", not a fault — mirror
      // `getForm`, which treats a failed fetch as absence (null) rather than propagating.
      this.log("warn", "getElementInstance: engine fetch failed", {
        elementInstanceKey: key,
        err: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
    if (!isRecord(body)) return null;
    return mapElementInstanceRow(body, this.log) ?? null;
  }

  async searchIncidents(filter?: IncidentFilter): Promise<IncidentSummary[]> {
    // Same shape as `searchElementInstances`: build the engine filter from the transport-agnostic
    // selectors, read at zero-wait consistency (an incident search is eventually consistent), and
    // map each row through the single `mapIncidentRow` gate, dropping malformed rows.
    const f: Record<string, unknown> = {};
    // Normalize the request selectors the same way the response mapper normalizes keys: a
    // whitespace-only/padded `processInstanceKey` must not reach the engine as a garbage filter
    // segment (which would silently return surprising empty results).
    const processInstanceKey = presentEngineKey(filter?.processInstanceKey);
    if (processInstanceKey) f.processInstanceKey = processInstanceKey;
    if (filter?.state) f.state = filter.state;
    const body = await this.client.searchIncidents(
      { filter: f },
      { consistency: { waitUpToMs: 0 } },
    );
    const items = Array.isArray(body.items) ? body.items.filter(isRecord) : [];
    return items.flatMap((it) => {
      const mapped = mapIncidentRow(it, this.log);
      return mapped ? [mapped] : [];
    });
  }

  async searchVariables(filter?: VariableFilter): Promise<VariableSummary[]> {
    // Same shape as `searchIncidents`: build the engine filter from the transport-agnostic
    // selectors, read at zero-wait consistency (a variable search is eventually consistent), and
    // map each row through the single `mapVariableRow` gate, dropping malformed rows.
    const f: Record<string, unknown> = {};
    const processInstanceKey = presentEngineKey(filter?.processInstanceKey);
    if (processInstanceKey) f.processInstanceKey = processInstanceKey;
    const scopeKey = presentEngineKey(filter?.scopeKey);
    if (scopeKey) f.scopeKey = scopeKey;
    const name = filter?.name?.trim();
    if (name) f.name = name;
    const body = await this.client.searchVariables(
      { filter: f },
      { consistency: { waitUpToMs: 0 } },
    );
    const items = Array.isArray(body.items) ? body.items.filter(isRecord) : [];
    return items.flatMap((it) => {
      const mapped = mapVariableRow(it, this.log);
      return mapped ? [mapped] : [];
    });
  }

  async searchJobs(filter?: JobFilter): Promise<JobSummary[]> {
    // Same shape as `searchIncidents`: build the engine filter from the transport-agnostic
    // selectors, read at zero-wait consistency (a job search is eventually consistent), and map
    // each row through the single `mapJobRow` gate, dropping malformed rows.
    const f: Record<string, unknown> = {};
    const processInstanceKey = presentEngineKey(filter?.processInstanceKey);
    if (processInstanceKey) f.processInstanceKey = processInstanceKey;
    const state = filter?.state?.trim();
    if (state) f.state = state;
    const type = filter?.type?.trim();
    if (type) f.type = type;
    const elementId = filter?.elementId?.trim();
    if (elementId) f.elementId = elementId;
    const worker = filter?.worker?.trim();
    if (worker) f.worker = worker;
    const body = await this.client.searchJobs(
      { filter: f },
      { consistency: { waitUpToMs: 0 } },
    );
    const items = Array.isArray(body.items) ? body.items.filter(isRecord) : [];
    return items.flatMap((it) => {
      const mapped = mapJobRow(it, this.log);
      return mapped ? [mapped] : [];
    });
  }

  async getProcessDefinitionXml(
    processDefinitionKey: string,
  ): Promise<string | null> {
    // A blank key can never address a definition — short-circuit to null rather than issue a
    // `GET /process-definitions//xml` with an empty segment. Normalize a padded-but-valid key so
    // `" 5 "` addresses the same definition, mirroring `getElementInstance`.
    const key = presentEngineKey(processDefinitionKey);
    if (key === undefined) return null;
    let xml: unknown;
    try {
      xml = await this.client.getProcessDefinitionXml(
        { processDefinitionKey: key },
        { consistency: { waitUpToMs: 0 } },
      );
    } catch (err) {
      // A 404 (no such definition) is an expected "not found", not a fault — mirror `getForm`/
      // `getElementInstance`, which treat a failed fetch as absence (null) rather than propagating.
      this.log("warn", "getProcessDefinitionXml: engine fetch failed", {
        processDefinitionKey: key,
        err: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
    // The endpoint returns the raw BPMN XML as a string (204 → empty). Treat a blank/absent body
    // as "no XML" (null) so a caller distinguishes "have it" from "don't".
    return typeof xml === "string" && xml.trim() !== "" ? xml : null;
  }

  async resolveIncident(input: { incidentKey: string }): Promise<void> {
    await this.client.resolveIncident({
      incidentKey: requireEngineKey(input.incidentKey, "incidentKey"),
    });
  }

  async updateJobRetries(input: { jobKey: string; retries: number }): Promise<void> {
    // The "retry a failed job" operation: a job's remaining retries are the `retries` field of
    // the `updateJob` changeset. Bumping them back above zero makes a failed job activatable so a
    // paired `resolveIncident` can return it to the pool.
    const jobKey = requireEngineKey(input.jobKey, "jobKey");
    // `retries` serializes straight into the engine changeset, and `number` admits `NaN`,
    // fractional, and negative values — none of which is a valid retry count. Reject them up
    // front so a tool-driven call fails with a clear message instead of an opaque engine error.
    if (!Number.isInteger(input.retries) || input.retries < 0) {
      throw new Error("retries must be a non-negative integer");
    }
    await this.client.updateJob({
      jobKey,
      changeset: { retries: input.retries },
    });
  }

  async setVariables(input: {
    scopeKey: string;
    variables: Record<string, unknown>;
    local?: boolean;
  }): Promise<void> {
    // A scope is addressed by its element-instance key (the process instance's root scope is an
    // element instance too), so `scopeKey` maps straight onto `elementInstanceKey`. `local`
    // defaults to engine behaviour (propagate to the outermost scope) when unset.
    await this.client.createElementInstanceVariables({
      elementInstanceKey: requireEngineKey(input.scopeKey, "scopeKey"),
      variables: input.variables,
      ...(input.local === undefined ? {} : { local: input.local }),
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
