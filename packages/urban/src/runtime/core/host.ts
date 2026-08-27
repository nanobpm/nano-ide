// The host contract — the ONLY seam through which the runtime touches a concrete
// JavaScript runtime (Node or Deno) or the Nano engine. Everything under core/ is
// written against these interfaces and MUST NOT import `node:*` or reference `Deno`.
// The adapters/ directory supplies concrete implementations.

/** A minimal HTTP request as seen by a mounted surface/trigger handler. */
export interface HttpRequest {
  method: string;
  /** Path portion of the URL, e.g. "/tasks". */
  path: string;
  /** Parsed query parameters. */
  query: URLSearchParams;
  headers: Headers;
  /** Read the raw request body as text (empty string when there is none). */
  text(): Promise<string>;
}

/** A minimal HTTP response returned by a handler. */
export interface HttpResponse {
  status?: number;
  headers?: Record<string, string>;
  body?: string;
}

export type HttpHandler = (req: HttpRequest) => Promise<HttpResponse> | HttpResponse;

/** A running HTTP server handle. */
export interface HttpServer {
  readonly port: number;
  stop(): Promise<void>;
  /**
   * The host's native server object, when it exposes one — the Node adapter's `node:http` `Server`.
   * Lets an app attach a WebSocket upgrade (e.g. `ws`'s `WebSocketServer({ server })`) to the *same*
   * port the app already serves. `undefined` on hosts that don't surface an upgradeable server object
   * (the Deno adapter, whose WS story is `upgradeWebSocket` on the Deno global in the request
   * handler). Typed
   * `unknown` because this is the host-adapter boundary — the consumer narrows it with a runtime
   * check (e.g. `instanceof Server`) before use, rather than a type assertion.
   */
  readonly native?: unknown;
}

/** A handle to an active filesystem watch; call close() to stop watching. */
export interface WatchHandle {
  close(): void;
}

/** A minimal ambient async-scoped store — the subset of `AsyncLocalStorage` the runtime needs
 *  to thread a job's execution context to DataLayer writes for write-provenance capture. Backed
 *  by `node:async_hooks` in both the Node and Deno adapters (both provide it); core depends only
 *  on this interface, never on `node:*`. */
export interface AsyncStore<T> {
  /** Run `fn` with `value` as the current store value, restoring the prior value afterwards. */
  run<R>(value: T, fn: () => R): R;
  /** The current store value, or undefined outside any `run`. */
  current(): T | undefined;
}

/** A tiny synchronous SQLite handle — the subset the runtime needs. */
export interface SqliteDb {
  /** Execute one or more statements with no result (DDL, PRAGMA, migrations). */
  exec(sql: string): void;
  /** Run a parameterised statement, returning the changed-row count. */
  run(sql: string, params?: unknown[]): { changes: number; lastInsertRowid: number | bigint };
  /** Run a query, returning all rows as plain objects. */
  all<T = Record<string, unknown>>(sql: string, params?: unknown[]): T[];
  close(): void;
}

/**
 * HostContext is the runtime-agnostic capability surface. A Node adapter and a Deno
 * adapter each implement it; core code depends only on this.
 */
export interface HostContext {
  /** Which concrete runtime is backing this host. */
  readonly runtime: "node" | "deno";
  /** Read an environment variable. */
  env(name: string): string | undefined;
  /** Read a UTF-8 text file relative to the app root. */
  readTextFile(path: string): Promise<string>;
  /** List file names (not directories) directly under `dir`. Returns [] if missing. */
  listDir(dir: string): Promise<string[]>;
  /**
   * List sub-directory names (not files) directly under `dir`. Returns [] if missing. Optional:
   * the deploy-by-convention walk uses it to descend one level into `resources/<subdir>/` (a host
   * that can't enumerate directories then deploys only the files directly under `resources/`).
   */
  listSubdirs?(dir: string): Promise<string[]>;
  /** True if the path exists (file or directory). */
  exists(path: string): Promise<boolean>;
  /** Open (creating if needed) a SQLite database at a filesystem path. */
  openSqlite(path: string): SqliteDb;
  /**
   * Dynamically import a handler/module by app-relative path. Path resolution differs
   * between runtimes, so it lives behind the host seam.
   */
  importModule(path: string): Promise<Record<string, unknown>>;
  /**
   * Import a connector pack's worker `entry` (ADR 0050) with the bare
   * `@nanobpm/worker` specifier the pack imports aliased to the runtime's
   * in-process shim (`connector-worker-sdk.ts`), so its top-level
   * `defineWorker(...)` registers into the shared registry. `entry` is an
   * absolute path (already resolved from the installed pack). Hosts that cannot
   * alias a bare specifier (or run no connector workers) may omit this; the
   * connector mount then reports the workers as unsupported rather than crashing.
   */
  importConnectorModule?(entry: string): Promise<void>;
  /**
   * Start an HTTP server. Routing is done by the caller inside `handler`. `bindHost` is the
   * network interface to bind (e.g. `"127.0.0.1"` for loopback, `"0.0.0.0"` for all interfaces);
   * the runtime always resolves it from the manifest `network.bind` setting (issue #235,
   * loopback by default). It stays optional so hosts that can't bind-control still satisfy the
   * contract, but the built-in node/deno adapters fail *closed* to loopback when it is omitted —
   * they never inherit a bind-all default — so the secure-by-default guarantee can't silently
   * regress.
   */
  serveHttp(port: number, handler: HttpHandler, bindHost?: string): Promise<HttpServer>;
  /**
   * Recursively watch the app root for file changes, invoking `onChange` with the
   * changed path (app-root-relative when the runtime reports it that way). Optional:
   * hosts that cannot watch omit it, and callers fall back to run-once. Returns a
   * handle whose close() stops watching.
   */
  watch?(onChange: (path: string) => void): WatchHandle;
  /** Current wall-clock time in ms since epoch (seam for tests). */
  now(): number;
  /**
   * Create an ambient async-scoped store (backed by `AsyncLocalStorage`). Used to thread the
   * active job's execution context to DataLayer writes for write-provenance capture. Optional:
   * a host that cannot provide one leaves provenance capture disabled (absent-safe).
   */
  createAsyncStore?<T>(): AsyncStore<T>;
  /**
   * Structured log sink. Adds `debug` below `info`; the host adapter owns filtering + encoding.
   *
   * NOTE: widening this level union to include `"debug"` is a **breaking change** for any custom
   * `HostContext` implementation whose `log` was typed with the narrower `"info" | "warn" | "error"`
   * union — such a host must add a `"debug"` branch to keep satisfying the contract. See the
   * "Structured logging" custom-host note in the runtime README.
   */
  log(level: "debug" | "info" | "warn" | "error", msg: string, fields?: Record<string, unknown>): void;
}

/** A job handed to a worker handler, plus the ack/fail callbacks. `In` types the process
 *  variables carried on the job; it defaults to an open record when a handler doesn't
 *  declare a concrete input shape. The `object` bound (rather than `Record<string, unknown>`)
 *  lets plain `interface` shapes be used as `In` — interfaces lack the implicit index
 *  signature that a `Record` bound would demand. */
export interface EngineJob<In extends object = Record<string, unknown>> {
  jobKey: string;
  jobType: string;
  processInstanceKey?: string;
  elementId?: string;
  variables: In;
}

export type JobHandler = (
  job: EngineJob,
) => Promise<Record<string, unknown> | void> | Record<string, unknown> | void;

/**
 * A BPMN error raised by a job handler. When a handler throws this, the engine
 * adapter reports it to the engine as a BPMN error (`throwError`) — routed to a
 * matching error boundary/event subprocess — instead of a plain job failure
 * (which retries then raises an incident). This is the runtime face of a
 * connector worker's `job.error(code, message)` (ADR 0050): a non-retryable,
 * modelled outcome. Handlers that throw any other error are failed (retried).
 */
export class BpmnError extends Error {
  readonly errorCode: string;
  constructor(errorCode: string, message?: string) {
    super(message ?? errorCode);
    this.name = "BpmnError";
    this.errorCode = errorCode;
  }
}

/** Structural guard: true for a {@link BpmnError} or any error carrying a
 *  non-empty string `errorCode`, so the check survives module-duplication (a
 *  BpmnError constructed against a different copy of this module still routes as
 *  a BPMN error rather than a generic failure). */
export function isBpmnError(err: unknown): err is { errorCode: string; message?: string } {
  if (typeof err !== "object" || err === null) return false;
  const errorCode = "errorCode" in err ? err.errorCode : undefined;
  return (
    typeof errorCode === "string" &&
    errorCode.length > 0
  );
}

/**
 * The canonical presence rule for a form identifier ({@link EngineClient.getForm}): an
 * empty or whitespace-only value is treated as *absent*. Returns the *trimmed* value when
 * present (so a padded `" form-123 "` resolves against the space-free deployed key),
 * otherwise `undefined`. This is the single source of truth shared by `getForm`'s
 * resolution gate ({@link EngineClient.getForm} adapters) and the `taskInbox`
 * `/api/form` route's presence check, so the two cannot drift on what counts as "an
 * identifier was provided" (e.g. a whitespace-only `?formKey=   ` is absent in both).
 */
export function presentFormIdentifier(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

/** A registered worker subscription. */
export interface WorkerSubscription {
  readonly jobType: string;
  unsubscribe(): Promise<void>;
}

/**
 * A process instance's terminal-relevant lifecycle state, as the engine reports it.
 * `ACTIVE` (still running), `COMPLETED` (ended normally at an end event), or
 * `TERMINATED` (cancelled/terminated — via a row-cancel, an operator, or a crash).
 * Deliberately the small set the instance-tracking reconciler keys on, not the richer
 * element-instance state set (which adds SKIPPED/CANCELED/FAILED for tokens).
 */
export type ProcessInstanceState = "ACTIVE" | "COMPLETED" | "TERMINATED";

/**
 * A user task's lifecycle state, as the engine reports it on a `/v2/user-tasks/search`
 * result. `CREATED` is the only *open* (answerable) state — a task in any other state has
 * already been answered (`COMPLETED`), withdrawn (`CANCELED`), or errored (`FAILED`) and must
 * never surface in the `taskInbox` as if it were actionable.
 */
export type UserTaskState = "CREATED" | "COMPLETED" | "CANCELED" | "FAILED";

/** A single process instance's lifecycle snapshot returned by {@link EngineClient.searchProcessInstances}. */
export interface ProcessInstanceSnapshot {
  readonly processInstanceKey: string;
  readonly state: ProcessInstanceState;
}

/**
 * A single open user task as {@link EngineClient.searchUserTasks} reports it. Carries the
 * task's identity plus its resolved form linkage so the `taskInbox` surface (ADR 0026) can
 * fetch and render the linked `.form`. `formKey` is the engine's resolution of a
 * `<zeebe:formDefinition formId="X" />` linkage to the latest deployed form at task-creation
 * time; `externalFormReference` is a form linked outside the deployment. Both are absent for a
 * task with no linked form (the surface then falls back to the raw key-list + complete path).
 */
export interface UserTaskSummary {
  readonly userTaskKey: string;
  readonly elementId?: string;
  readonly variables?: Record<string, unknown>;
  /** The resolved key of the linked deployed form, if the task has one. */
  readonly formKey?: string;
  /** An external form reference (a form linked outside the deployment), if any. */
  readonly externalFormReference?: string;
}

/**
 * The lifecycle-state-agnostic selectors for a user-task search: which process instance,
 * assignee, and/or candidate group to match. Shared by {@link EngineClient.searchUserTasks}
 * (which adds an optional `state`) and {@link EngineClient.openUserTasks} (which pins
 * `state: "CREATED"` for you), so the two accessors cannot drift on how a task is selected.
 */
export interface UserTaskFilter {
  processInstanceKey?: string;
  assignee?: string;
  candidateGroup?: string;
}

/**
 * An element instance's lifecycle state, as the engine reports it on a
 * `/v2/element-instances/search` result. Mirrors the engine's `ElementInstanceStateEnum`:
 * `ACTIVE` (a token is currently *at* this element), `COMPLETED` (the token has left it), or
 * `TERMINATED` (the element was interrupted). Structurally the same state set as
 * {@link ProcessInstanceState} (one active state plus the `COMPLETED`/`TERMINATED` terminals),
 * but a distinct concept — element instances are the tokens *within* a process instance — so it
 * is kept as its own type rather than aliased.
 */
export type ElementInstanceState = "ACTIVE" | "COMPLETED" | "TERMINATED";

/**
 * A single element instance ("token") as {@link EngineClient.searchElementInstances} and
 * {@link EngineClient.getElementInstance} report it — the finest-grained "how far has this
 * process instance progressed" signal, below the process-instance lifecycle
 * ({@link ProcessInstanceSnapshot}) and independent of whether the element is a user task
 * ({@link UserTaskSummary}). It surfaces active *non-user-task* elements (a service task, a
 * gateway, a catch event) a user-task search cannot see — "the furthest element reached".
 * Carries the element instance's own key, its identity (`elementId`, its BPMN `elementType`
 * when the engine reports it), the owning process instance, and its lifecycle `state`.
 */
export interface ElementInstanceSummary {
  readonly elementInstanceKey: string;
  readonly processInstanceKey: string;
  readonly elementId: string;
  /** The BPMN element type (e.g. `"SERVICE_TASK"`, `"USER_TASK"`,
   *  `"INTERMEDIATE_CATCH_EVENT"`), when the engine reports it. Kept transport-agnostic (a
   *  bare string) so a new BPMN element type on the engine flows through without having to be
   *  enumerated here. Absent when the adapter's read model does not carry it. */
  readonly elementType?: string;
  readonly state: ElementInstanceState;
}

/**
 * The kind of wait an element instance is parked in, as a
 * `/v2/element-instances/wait-states/search` result reports it. Unlike a user-task search,
 * this surfaces *every* park — a `JOB` (a service task awaiting a worker), a `MESSAGE`
 * (an event awaiting correlation), a `TIMER`, a `SIGNAL`, a `CONDITION`, as well as a
 * `USER_TASK` — so a consumer can read "what is this instance blocked on" beyond user tasks.
 */
export type WaitStateType =
  | "JOB"
  | "MESSAGE"
  | "USER_TASK"
  | "TIMER"
  | "SIGNAL"
  | "CONDITION";

/**
 * A single parked (waiting) element instance as
 * {@link EngineClient.searchElementInstanceWaitStates} reports it. Every variant carries the
 * element instance's identity; the `waitStateType` discriminates the park-specific fields — a
 * `JOB` carries the `jobType`/`jobKey` it is parked on, a `MESSAGE` the awaited
 * `messageName`/`correlationKey`, a `USER_TASK` the `userTaskKey`, a `SIGNAL` the
 * `signalName` — so a caller narrows on `waitStateType` to reach them type-safely rather than
 * probing a flat optional-field bag.
 */
export type ElementInstanceWaitState =
  & {
    readonly elementInstanceKey: string;
    readonly processInstanceKey: string;
    readonly elementId: string;
    readonly elementType?: string;
  }
  & (
    | { readonly waitStateType: "JOB"; readonly jobType: string; readonly jobKey?: string }
    | {
      readonly waitStateType: "MESSAGE";
      readonly messageName: string;
      readonly correlationKey?: string;
    }
    | { readonly waitStateType: "USER_TASK"; readonly userTaskKey: string }
    | { readonly waitStateType: "TIMER" }
    | { readonly waitStateType: "SIGNAL"; readonly signalName: string }
    | { readonly waitStateType: "CONDITION" }
  );

/**
 * Selectors for an element-instance search: which process instance, element, and/or lifecycle
 * state to match. Used by {@link EngineClient.searchElementInstances}.
 */
export interface ElementInstanceFilter {
  processInstanceKey?: string;
  elementId?: string;
  state?: ElementInstanceState;
}

/**
 * Selectors for an element-instance *wait-state* search: which process instance, element,
 * and/or kind of wait to match. Used by {@link EngineClient.searchElementInstanceWaitStates}.
 * There is deliberately no lifecycle-`state` selector — a wait state is always an active park.
 */
export interface ElementInstanceWaitStateFilter {
  processInstanceKey?: string;
  elementId?: string;
  waitStateType?: WaitStateType;
}

/**
 * The lifecycle state of an incident, as {@link EngineClient.searchIncidents} reports it.
 * An `ACTIVE` incident is an open fault a human/agent can act on (resolve/retry); the other
 * values are terminal or transitional. Mirrors the engine's incident-state enum so a caller
 * narrows on it rather than probing a raw string.
 */
export type IncidentState =
  | "ACTIVE"
  | "MIGRATED"
  | "PENDING"
  | "RESOLVED"
  | "UNKNOWN";

/**
 * Selectors for an incident search: which process instance and/or lifecycle state to match.
 * Used by {@link EngineClient.searchIncidents}. An eventually consistent (zero-wait) read; an
 * unset selector matches every incident.
 */
export interface IncidentFilter {
  processInstanceKey?: string;
  state?: IncidentState;
}

/**
 * A single incident (a stuck token — a job out of retries, an unhandled error, a failed
 * gateway evaluation) as {@link EngineClient.searchIncidents} reports it. Carries the
 * `incidentKey` a caller passes to {@link EngineClient.resolveIncident}, the owning
 * `processInstanceKey`, and — when the incident is job-backed — the `jobKey` a caller passes
 * to {@link EngineClient.updateJobRetries} to make the job retriable before resolving.
 * `errorType`/`errorMessage` are the engine's fault description; they are free-form across
 * engines (the live SDK reports a Camunda error-type enum, the in-process engine a coarser
 * `kind`), so treat them as diagnostic text, not a stable taxonomy.
 */
export interface IncidentSummary {
  readonly incidentKey: string;
  readonly processInstanceKey: string;
  readonly elementId?: string;
  readonly elementInstanceKey?: string;
  readonly jobKey?: string;
  readonly errorType?: string;
  readonly errorMessage?: string;
  readonly state: IncidentState;
}

/**
 * A deployed form's form-js schema plus its identifying metadata, as
 * {@link EngineClient.getForm} returns it. `schema` is the parsed form-js document
 * (`{ type: "default", schemaVersion, components: [...] }`) that the surface renders
 * client-side; `formKey`/`formId`/`version` identify the exact deployed form resolved.
 */
export interface FormSchema {
  readonly formKey?: string;
  readonly formId?: string;
  readonly version?: number;
  readonly schema: Record<string, unknown>;
}

/**
 * EngineClient is the seam onto a Nano engine. The SDK/REST-backed adapter implements
 * it against a live engine; tests implement it in-memory. Core modules depend only on this.
 */
export interface EngineClient {
  /** Deploy model resources (BPMN/DMN/forms) and generic resources (prompts, scripts, and other
   *  arbitrary files, content-typed e.g. `text/markdown`/`application/octet-stream`; the engine
   *  versions each generic resource per its `resourceId` — carried on `name`). Returns the number
   *  deployed. */
  deployResources(
    resources: { name: string; content: string; contentType: string }[],
  ): Promise<{ deployed: number }>;
  /** Start a process instance. */
  createInstance(input: {
    processDefinitionId: string;
    variables?: Record<string, unknown>;
    awaitCompletion?: boolean;
  }): Promise<{ processInstanceKey: string; variables?: Record<string, unknown> }>;
  /** Cancel a running process instance (the pages surface's row-cancel action). */
  cancelInstance(input: { processInstanceKey: string }): Promise<void>;
  /** Publish a message for correlation. */
  publishMessage(input: {
    name: string;
    correlationKey?: string;
    variables?: Record<string, unknown>;
  }): Promise<void>;
  /** Search user tasks (optionally by process instance, assignee, or candidate group).
   *  By default this is unfiltered by lifecycle state and may return tasks in any state
   *  (e.g. completed/canceled); pass `state: "CREATED"` to constrain the search to open
   *  (answerable) tasks. Each result carries the task's resolved form linkage
   *  (`formKey`/`externalFormReference`) when present.
   *
   *  **Footgun:** because this defaults to *any* lifecycle state and lags a completion,
   *  a just-answered task is still returned for a moment — so treating mere *existence*
   *  of a result as "open / actionable" projects a completed task as if a human could
   *  still act on it (a torn read-model row). {@link UserTaskSummary} deliberately omits
   *  `state`, so a caller cannot re-filter results defensively. If you are deciding
   *  whether a human can act — any reconcile / affordance path — use
   *  {@link EngineClient.openUserTasks} instead; reserve `searchUserTasks` for the rare
   *  legitimate "any lifecycle state" audit/read case. */
  searchUserTasks(filter?: UserTaskFilter & {
    state?: UserTaskState;
  }): Promise<UserTaskSummary[]>;
  /** The user tasks that are actually *open* (answerable) — semantically the accessor to
   *  reach for whenever you are deciding whether a human can act (reconcile / affordance
   *  paths). A thin, intent-named wrapper that pins the lifecycle-state invariant the SDK
   *  documents: exactly `searchUserTasks({ ...filter, state: "CREATED" })`, since `CREATED`
   *  is the only open state ({@link UserTaskState}). Unlike a bare `searchUserTasks`, it
   *  cannot surface a completed/canceled task as if it were still actionable — the footgun
   *  described on `searchUserTasks`. Same selectors as `searchUserTasks` minus `state`
   *  (pinned to `CREATED`). */
  openUserTasks(filter?: UserTaskFilter): Promise<UserTaskSummary[]>;
  /**
   * Fetch a deployed form's form-js schema for the `taskInbox` surface. Resolve by
   * `formKey` (the linkage the engine attaches to a user task) or, as a best-effort
   * fallback, by `formId`. An empty or whitespace-only identifier is treated as absent,
   * so a blank `formKey` falls through to `formId`. How `formId` is addressed is
   * adapter-specific: an adapter may pass it straight through as the lookup key, or
   * resolve it to the latest deployed form's key. Returns `null` when no matching form
   * exists — the caller then falls back to the no-form path.
   */
  getForm(input: { formKey?: string; formId?: string }): Promise<FormSchema | null>;
  /** Complete a user task. */
  completeUserTask(userTaskKey: string, variables?: Record<string, unknown>): Promise<void>;
  /**
   * Search process instances by key and/or lifecycle state. The instance-tracking
   * reconciler uses this to detect a tracked instance reaching a terminal state
   * (`TERMINATED`/`COMPLETED`) even though no completion worker ran for it — the
   * read-model row it backs would otherwise stay "active" forever. An eventually
   * consistent read (zero-wait); pass the keys currently marked active in the
   * read model and, optionally, a `state` to narrow the result.
   */
  searchProcessInstances(filter?: {
    processInstanceKeys?: string[];
    state?: ProcessInstanceState;
  }): Promise<ProcessInstanceSnapshot[]>;
  /**
   * Search element instances ("tokens") by process instance, element, and/or lifecycle state
   * (`POST /v2/element-instances/search`). Where {@link searchProcessInstances} answers "is
   * this instance still running" and {@link searchUserTasks} answers "what user tasks are
   * open", this answers "what element has a token reached" — including the active
   * *non-user-task* elements (a service task, a gateway, a catch event) that a user-task
   * search cannot see, i.e. "the furthest element reached". An eventually consistent
   * (zero-wait) read; each {@link ElementInstanceSummary} carries the element instance's key,
   * its `elementId`/`elementType`, the owning process instance, and its `state`.
   */
  searchElementInstances(
    filter?: ElementInstanceFilter,
  ): Promise<ElementInstanceSummary[]>;
  /**
   * Search the *wait states* of element instances
   * (`POST /v2/element-instances/wait-states/search`) — every park, not only user tasks. A
   * `JOB` park (a service task awaiting a worker), a `MESSAGE` park (an event awaiting
   * correlation), a `TIMER`/`SIGNAL`/`CONDITION`, plus `USER_TASK`. A zero-wait read; each
   * result is discriminated by `waitStateType` (see {@link ElementInstanceWaitState}), so a
   * consumer can read the job/message parks a {@link searchUserTasks} cannot surface.
   */
  searchElementInstanceWaitStates(
    filter?: ElementInstanceWaitStateFilter,
  ): Promise<ElementInstanceWaitState[]>;
  /**
   * Fetch a single element instance by its key (`GET /v2/element-instances/{elementInstanceKey}`),
   * or `null` when it cannot be resolved — the key is blank, no such element instance exists
   * (a 404), or the fetch otherwise fails. A read is treated as absence rather than propagating
   * (mirroring {@link getForm}), so a caller distinguishes "have it" from "don't" without a
   * try/catch. A zero-wait read returning the same {@link ElementInstanceSummary} shape as
   * {@link searchElementInstances}.
   */
  getElementInstance(
    elementInstanceKey: string,
  ): Promise<ElementInstanceSummary | null>;
  /**
   * Search incidents by owning process instance and/or lifecycle state
   * (`POST /v2/incidents/search`) — the open faults blocking one or more instances (a job out
   * of retries, an unhandled error, a failed gateway evaluation). An eventually consistent
   * (zero-wait) read; each {@link IncidentSummary} carries the `incidentKey` to pass to
   * {@link resolveIncident} and, for a job-backed incident, the `jobKey` to pass to
   * {@link updateJobRetries}. The debugging counterpart to the read accessors above: where
   * they answer "how far has this instance progressed", this answers "why is it stuck".
   */
  searchIncidents(filter?: IncidentFilter): Promise<IncidentSummary[]>;
  /**
   * Resolve an open incident by key (`POST /v2/incidents/{incidentKey}/resolution`), unblocking
   * the parked token: a job incident returns the job to the activatable pool (so it must have
   * retries left first — see {@link updateJobRetries}), a gateway incident re-evaluates, an
   * uncaught-error incident re-creates the service-task job. A mutating operation.
   */
  resolveIncident(input: { incidentKey: string }): Promise<void>;
  /**
   * Update the remaining retries of a job (`PATCH /v2/jobs/{jobKey}`) — the "retry a failed
   * job" operation. Setting a failed job's retries back above zero makes it activatable again;
   * paired with {@link resolveIncident}, this is how a stuck `jobNoRetries` incident is cleared
   * (bump retries, then resolve). A mutating operation.
   */
  updateJobRetries(input: { jobKey: string; retries: number }): Promise<void>;
  /**
   * Set (merge) variables into a scope (`PUT /v2/element-instances/{scopeKey}/variables`).
   * `scopeKey` is a process-instance key or an element-instance key; when `local` is `true` the
   * variables are merged strictly into that local scope, otherwise (the default) they propagate
   * to the outermost scope. A mutating operation used to repair state before resolving an
   * incident or to steer an instance during debugging.
   */
  setVariables(input: {
    scopeKey: string;
    variables: Record<string, unknown>;
    local?: boolean;
  }): Promise<void>;
  /** Register a push worker for a job type. Draining is handled by the adapter. */
  registerWorker(
    jobType: string,
    handler: JobHandler,
    options?: { workerName?: string; maxParallelJobs?: number; fetchVariables?: string[] },
  ): Promise<WorkerSubscription>;
  /** Tear down all connections. */
  close(): Promise<void>;
}

/**
 * The names of every method on {@link EngineClient} — the single *runtime* source of
 * truth for the interface's surface. It is compile-time-pinned to `keyof EngineClient`
 * in both directions (see the two assertions below): the `satisfies` rejects a stray or
 * misspelled name, and the exhaustiveness assertion rejects an *omitted* one, so adding,
 * renaming, or removing an `EngineClient` method that this list does not mirror fails
 * `npm run typecheck`.
 *
 * A fake/adapter (e.g. `@nanobpm/urban-testkit`'s `WasmEngineClient`) can iterate this
 * list to assert at *runtime* that it implements the full surface — catching the
 * "the SDK grew a method the test double lags" seam-lag class (issue #341: `openUserTasks`,
 * and `getForm` before it) that a purely structural `implements EngineClient` check no
 * longer catches once the fake is published/compiled against an older `@nanobpm/urban`.
 */
export const ENGINE_CLIENT_METHODS = [
  "deployResources",
  "createInstance",
  "cancelInstance",
  "publishMessage",
  "searchUserTasks",
  "openUserTasks",
  "getForm",
  "completeUserTask",
  "searchProcessInstances",
  "searchElementInstances",
  "searchElementInstanceWaitStates",
  "getElementInstance",
  "searchIncidents",
  "resolveIncident",
  "updateJobRetries",
  "setVariables",
  "registerWorker",
  "close",
] as const satisfies readonly (keyof EngineClient)[];

// Compile-time exhaustiveness: every `EngineClient` method must appear in
// `ENGINE_CLIENT_METHODS`. If one is omitted, `Exclude<...>` is a non-`never` union of
// the missing keys, so this type resolves to `never` and the `true` assignment fails to
// compile — the twin of the `satisfies` above, together pinning the list to
// `keyof EngineClient` exactly (No Drift Surfaces).
type MissingEngineClientMethods = Exclude<keyof EngineClient, (typeof ENGINE_CLIENT_METHODS)[number]>;
const _engineClientMethodsAreExhaustive: [MissingEngineClientMethods] extends [never] ? true : never = true;
