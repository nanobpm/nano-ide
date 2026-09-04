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
  /** The key of the deployed process definition this instance runs — the handle a caller feeds to
   *  {@link EngineClient.getProcessDefinitionXml} to fetch the deployed BPMN (the instance →
   *  `processDefinitionKey` → deployed XML path, no repo checkout). Absent when the engine omits it. */
  readonly processDefinitionKey?: string;
  /** The key of this instance's *immediate* parent process instance — the caller that instantiated
   *  it as a native child (a `<bpmn:callActivity>`). `undefined` for a top-level (root) instance,
   *  and absent when the engine omits it (same optional/engine-provided convention as
   *  `processDefinitionKey`). Lets a reduced-capability read path map a native child back to the
   *  subject that spawned it without a raw-REST channel. */
  readonly parentProcessInstanceKey?: string;
  /** The key of this instance's *root* process instance — the top-level ancestor of the
   *  call-activity hierarchy this instance belongs to (equal to `processInstanceKey` for a
   *  top-level instance). `undefined`/absent when the engine omits it (only present for hierarchies
   *  created on an engine version that reports it). Lets a reduced-capability read path correlate a
   *  deep native descendant straight back to its root subject. */
  readonly rootProcessInstanceKey?: string;
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
  /** The key of the process instance this task belongs to. Absent when the engine omits it (same
   *  optional/engine-provided convention as `processDefinitionKey`). For a task owned by a native
   *  child instance, this is the child's own key — the handle a reduced-capability read path feeds
   *  to {@link EngineClient.searchProcessInstances} to resolve the child's parent/root linkage. */
  readonly processInstanceKey?: string;
  /** The key of the *immediate* parent process instance of this task's owning instance — the caller
   *  that spawned it as a native child. Absent when the engine's user-task read model omits it (as
   *  it does today: the engine surfaces the parent linkage on {@link ProcessInstanceSnapshot}, so a
   *  caller resolves it via `processInstanceKey` → `searchProcessInstances`). Declared here for
   *  parity with the process-instance snapshot and to flow through automatically if the read model
   *  starts carrying it. */
  readonly parentProcessInstanceKey?: string;
  /** The key of the *root* process instance of this task's owning instance — the top-level ancestor
   *  of the call-activity hierarchy the task lives in. Absent when the engine omits it. Lets a
   *  reduced-capability read path (`pollUserTasks` and other reconcile/affordance surfaces)
   *  correlate a native-child (e.g. human-escalation grandchild) task straight back to its root
   *  subject through the typed seam, with no raw-REST fallback. */
  readonly rootProcessInstanceKey?: string;
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
  /** Select only tasks whose owning instance has this *immediate* parent process instance. Honored
   *  server-side by the live gateway where the read model supports it; the in-process testkit
   *  applies it client-side against the row's parent linkage (absent today on the user-task read
   *  model, so it matches nothing until the engine surfaces it there). */
  parentProcessInstanceKey?: string;
  /** Select only tasks whose owning instance belongs to this *root* process-instance hierarchy — the
   *  selector a reduced-capability path uses to fetch every open task under one root subject. */
  rootProcessInstanceKey?: string;
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
 * `/v2/element-instances/wait-states/search` result reports it. This is the *canonical*
 * six-type contract (Zeebe's, as of 2026): a `JOB` (a service task awaiting a worker), a
 * `MESSAGE` (an event awaiting correlation), a `TIMER`, a `SIGNAL`, a `CONDITION`, as well
 * as a `USER_TASK`.
 *
 * **Not every deployed engine implements the whole union.** It is forward-looking on
 * purpose (the response mapper and {@link normalizeWaitStateType} tolerate all six so a
 * newer engine's rows map cleanly), but the *currently deployed* nanobpmn gateway's
 * read-model floor is narrower — see {@link DEPLOYED_WAIT_STATE_TYPES}. A
 * {@link ElementInstanceWaitStateFilter} whose `waitStateType` falls outside that floor is
 * rejected (the gateway answers HTTP 422); {@link assertDeployedWaitStateType} enforces the
 * same floor client-side so the divergence surfaces as a clear error offline, in tests, and
 * against a live engine alike. The floor now covers `JOB | MESSAGE | USER_TASK`
 * (Magikcraft/nano-bpm#1042 shipped `USER_TASK` parks); `TIMER`/`SIGNAL`/`CONDITION` remain
 * the follow-on. Ref: Magikcraft/nano-bpm#1042.
 */
export type WaitStateType =
  | "JOB"
  | "MESSAGE"
  | "USER_TASK"
  | "TIMER"
  | "SIGNAL"
  | "CONDITION";

/**
 * The `waitStateType` values the *currently deployed* nanobpmn gateway's wait-state read
 * model actually implements — the **deployed floor**, a strict subset of the canonical
 * {@link WaitStateType} union. The gateway's read model started as a snapshot of the Zeebe
 * contract taken 2026-06-09 that recognized only `JOB | MESSAGE`; Magikcraft/nano-bpm#1042
 * has since shipped `USER_TASK` parks (added on user-task CREATED, removed on
 * COMPLETED/CANCELED, with the park identity under `details.taskKey`), moving the floor up to
 * `JOB | MESSAGE | USER_TASK`. `TIMER`/`SIGNAL`/`CONDITION` are still rejected with HTTP 422
 * (the 8.10 follow-on tracked in Magikcraft/nano-bpm#1042).
 *
 * This constant is the **single source of truth** for that floor: the SDK-backed and
 * WASM-backed {@link EngineClient} adapters both gate through {@link assertDeployedWaitStateType},
 * and the WASM emulation synthesizes only these park kinds — so a test cannot pass against
 * the emulation while a real gateway would 422 (No Drift Surfaces). Widen it (adding a leg
 * backed by the real gateway) only once the engine actually serves the richer type — the
 * tracking gap is Magikcraft/nano-bpm#1042.
 */
export const DEPLOYED_WAIT_STATE_TYPES: readonly WaitStateType[] = ["JOB", "MESSAGE", "USER_TASK"];

/**
 * Thrown when a wait-state search is asked to filter on a {@link WaitStateType} the deployed
 * gateway's read model does not implement (outside {@link DEPLOYED_WAIT_STATE_TYPES}). It
 * fails fast client-side with a clear, offline-detectable error rather than letting the call
 * reach the gateway and surface as an opaque HTTP 422 "did not match any variant of untagged
 * enum WaitStateTypeFilterProperty". Ref: Magikcraft/nano-bpm#1042.
 */
export class UnsupportedWaitStateTypeError extends Error {
  readonly waitStateType: string;
  readonly supported: readonly WaitStateType[];
  constructor(waitStateType: string) {
    super(
      `unsupported waitStateType "${waitStateType}": the deployed nanobpmn gateway's ` +
        `wait-state read model implements only ${DEPLOYED_WAIT_STATE_TYPES.join(" | ")} and ` +
        `rejects any other value with HTTP 422. Ref: Magikcraft/nano-bpm#1042.`,
    );
    this.name = "UnsupportedWaitStateTypeError";
    this.waitStateType = waitStateType;
    this.supported = DEPLOYED_WAIT_STATE_TYPES;
  }
}

/**
 * Assert a wait-state filter's `waitStateType` is within the deployed floor
 * ({@link DEPLOYED_WAIT_STATE_TYPES}), throwing {@link UnsupportedWaitStateTypeError}
 * otherwise. An absent selector is always allowed (the search is unfiltered by type). Both
 * {@link EngineClient} adapters call this before issuing a wait-state search, so the floor is
 * enforced identically whether the query runs against a live gateway or the in-process
 * emulation. No-ops for an in-floor type.
 */
export function assertDeployedWaitStateType(waitStateType?: WaitStateType): void {
  if (waitStateType !== undefined && !DEPLOYED_WAIT_STATE_TYPES.includes(waitStateType)) {
    throw new UnsupportedWaitStateTypeError(waitStateType);
  }
}

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
 *
 * A `waitStateType` selector must fall within the deployed floor
 * ({@link DEPLOYED_WAIT_STATE_TYPES}); a value outside it is rejected with
 * {@link UnsupportedWaitStateTypeError} (the live gateway answers HTTP 422).
 */
export interface ElementInstanceWaitStateFilter {
  processInstanceKey?: string;
  elementId?: string;
  waitStateType?: WaitStateType;
}

/**
 * The engine's own incident-state enum — the lifecycle states an engine actually reports and
 * that are valid as a search selector. An `ACTIVE` incident is an open fault a human/agent can
 * act on (resolve/retry); the other values are terminal or transitional. This is the single
 * source of truth for real engine states; {@link IncidentState} derives from it.
 */
export type EngineIncidentState = "ACTIVE" | "MIGRATED" | "PENDING" | "RESOLVED";

/**
 * The lifecycle state of an incident, as {@link EngineClient.searchIncidents} reports it.
 * Extends {@link EngineIncidentState} with the client-side `"UNKNOWN"` sentinel — a fallback
 * used when the engine returns an unrecognized/absent value, so an incident is surfaced rather
 * than dropped for an odd state. Because `"UNKNOWN"` is not a real engine state, it is not a
 * valid {@link IncidentFilter} selector. A caller narrows on this union rather than probing a
 * raw string.
 */
export type IncidentState = EngineIncidentState | "UNKNOWN";

/**
 * Selectors for an incident search: which process instance and/or lifecycle state to match.
 * Used by {@link EngineClient.searchIncidents}. An eventually consistent (zero-wait) read; an
 * unset selector matches every incident.
 */
export interface IncidentFilter {
  processInstanceKey?: string;
  state?: EngineIncidentState;
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
 * Selectors for a variable search: which process instance and/or scope to match, optionally
 * narrowed to a single variable `name`. Used by {@link EngineClient.searchVariables}. An
 * eventually consistent (zero-wait) read; an unset selector matches every variable in scope.
 */
export interface VariableFilter {
  processInstanceKey?: string;
  scopeKey?: string;
  name?: string;
}

/**
 * A single process variable as {@link EngineClient.searchVariables} reports it — the read
 * counterpart to the write-only {@link EngineClient.setVariables}. Mirrors the engine's v2
 * `/variables/search` row: the variable's own `variableKey`, its `name`, its serialized JSON
 * `value` (a string — an object/array value arrives JSON-encoded, so a caller `JSON.parse`s it),
 * the `scopeKey` it is directly defined in (a process-instance key for a process-level variable,
 * an element-instance key for a local one) and the owning `processInstanceKey`. `isTruncated` is
 * `true` when the engine clipped a large `value` for the read model — the caller then knows the
 * `value` is a preview, not the whole payload. This is the only way to read a parked token's
 * business payload (`prKey`, `round`, an escalation `question`/`answer`, `resolution`,
 * `directive`); the ADR 0065 projections carry lifecycle/position, not the payload.
 */
export interface VariableSummary {
  readonly variableKey: string;
  readonly name: string;
  readonly value: string;
  readonly scopeKey: string;
  readonly processInstanceKey: string;
  readonly isTruncated: boolean;
}

/**
 * Selectors for a job search: which process instance, lifecycle `state`, job `type`, `elementId`,
 * and/or leasing `worker` to match. Used by {@link EngineClient.searchJobs}. `state` is kept a
 * transport-agnostic bare string (the engine's job-state enum is broad and forward-looking — e.g.
 * `CREATED`/`COMPLETED`/`FAILED`/`TIMED_OUT`), so a new engine state flows through without having
 * to be enumerated here. An eventually consistent (zero-wait) read; an unset selector matches
 * every job.
 */
export interface JobFilter {
  processInstanceKey?: string;
  state?: string;
  type?: string;
  elementId?: string;
  worker?: string;
}

/**
 * A single job as {@link EngineClient.searchJobs} reports it — mirrors the engine's v2
 * `/jobs/search` row. Carries the `jobKey` a caller passes to
 * {@link EngineClient.updateJobRetries} (the only source of a `jobKey` for a job NOT already
 * behind a `jobNoRetries` incident, which {@link searchIncidents} surfaces), the job `type` and
 * lifecycle `state` (a bare string — see {@link JobFilter}), the owning `processInstanceKey`, and
 * the best-effort diagnostics `worker`/`retries`/`elementId`/`deadline`. The `worker` field is the
 * "is it actually stuck" signal: a `CREATED` job WITH a `worker` set has been leased by an agent,
 * while one with NONE set is merely queued — so `worker` is omitted (absent) when unset. `retries`,
 * `elementId`, and `deadline` are likewise present when the engine reports them, omitted otherwise.
 */
export interface JobSummary {
  readonly jobKey: string;
  readonly type: string;
  readonly state: string;
  readonly processInstanceKey: string;
  readonly worker?: string;
  readonly retries?: number;
  readonly elementId?: string;
  readonly deadline?: string;
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
    /** Select only instances whose *immediate* parent is this process instance — the reduced-path
     *  query for "the native children spawned by this subject". */
    parentProcessInstanceKey?: string;
    /** Select only instances belonging to this *root* process-instance hierarchy — "every instance
     *  under this root subject", the deep-descendant correlation query. */
    rootProcessInstanceKey?: string;
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
   * (`POST /v2/element-instances/wait-states/search`) — the parks the deployed engine's
   * read model serves. A zero-wait read; each result is discriminated by `waitStateType`
   * (see {@link ElementInstanceWaitState}), so a consumer can read the job/message parks a
   * {@link searchUserTasks} cannot surface.
   *
   * **Deployed floor.** The currently deployed nanobpmn gateway implements
   * `JOB | MESSAGE | USER_TASK` ({@link DEPLOYED_WAIT_STATE_TYPES}); a `USER_TASK` park can be
   * read here (or through {@link searchUserTasks}). A `waitStateType` filter outside the floor
   * (`TIMER`/`SIGNAL`/`CONDITION`) is rejected with {@link UnsupportedWaitStateTypeError} (the
   * live gateway answers HTTP 422); an unfiltered search returns only in-floor parks. The
   * `waitStateType` union is forward-looking (richer engines may serve more), but this adapter
   * contract pins the floor so a query cannot pass in emulation while a real engine rejects it.
   * Ref: Magikcraft/nano-bpm#1042.
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
   * Search process variables by owning process instance and/or scope, optionally narrowed to a
   * single `name` (`POST /v2/variables/search`). The read counterpart to the write-only
   * {@link setVariables}: it is the only way to see a parked token's business payload (`prKey`,
   * `round`, an escalation `question`/`answer`, `resolution`, `directive`) — the ADR 0065
   * projections carry lifecycle/position, not the payload. An eventually consistent (zero-wait)
   * read; each {@link VariableSummary} carries the variable's serialized JSON `value` (a string)
   * and an `isTruncated` flag set when the engine clipped a large value for the read model.
   */
  searchVariables(filter?: VariableFilter): Promise<VariableSummary[]>;
  /**
   * Search jobs by owning process instance, lifecycle `state`, job `type`, `elementId`, and/or
   * leasing `worker` (`POST /v2/jobs/search`). This is the "is it actually stuck" read: a
   * `CREATED` job WITH a `worker` set has been leased by an agent, while one with NONE set is
   * merely queued. It is also the on-tool source of a `jobKey` for {@link updateJobRetries} when
   * the job is NOT behind an incident — {@link searchIncidents} only surfaces a `jobKey` for a
   * job that already faulted (a `jobNoRetries` incident), so retrying an un-incidented job would
   * otherwise be impossible without a direct engine-API call. An eventually consistent (zero-wait)
   * read; each {@link JobSummary} carries the `jobKey` plus best-effort `worker`/`retries`/
   * `elementId`/`deadline` diagnostics.
   */
  searchJobs(filter?: JobFilter): Promise<JobSummary[]>;
  /**
   * Fetch the deployed BPMN XML of a process definition by its `processDefinitionKey`
   * (`GET /v2/process-definitions/{processDefinitionKey}/xml`), or `null` when the key is blank,
   * unknown (a 404), or the definition carries no XML. This is the *deployed* model — the routing
   * source of truth, including its FEEL gateway conditions — so an agent can reason about WHY an
   * instance routed where it did without checking out `resources/processes/*.bpmn` from the app
   * repo. An instance already carries its `processDefinitionKey` (via {@link searchProcessInstances}),
   * so the path is instance → `processDefinitionKey` → deployed XML. A read is treated as absence
   * (`null`) rather than propagating (mirroring {@link getForm}/{@link getElementInstance}), so a
   * caller distinguishes "have it" from "don't" without a try/catch. A zero-wait read.
   */
  getProcessDefinitionXml(processDefinitionKey: string): Promise<string | null>;
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
  "searchVariables",
  "searchJobs",
  "getProcessDefinitionXml",
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
