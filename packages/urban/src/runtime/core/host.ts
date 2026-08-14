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
  /** Start an HTTP server. Routing is done by the caller inside `handler`. */
  serveHttp(port: number, handler: HttpHandler): Promise<HttpServer>;
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
  /** Deploy model resources (BPMN/DMN/forms). Returns the number deployed. */
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
  /** Search open user tasks (optionally by process instance). Each result carries the
   *  task's resolved form linkage (`formKey`/`externalFormReference`) when present. */
  searchUserTasks(filter?: {
    processInstanceKey?: string;
    assignee?: string;
    candidateGroup?: string;
  }): Promise<UserTaskSummary[]>;
  /**
   * Fetch a deployed form's form-js schema for the `taskInbox` surface. Resolve by
   * `formKey` (the linkage the engine attaches to a user task) or, as a best-effort
   * fallback, by `formId` — passed straight through as the lookup key for engines that
   * address a form by its id; it is not separately resolved to a latest deployment here.
   * Returns `null` when no matching form exists — the caller then falls back to the
   * no-form path.
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
  /** Register a push worker for a job type. Draining is handled by the adapter. */
  registerWorker(
    jobType: string,
    handler: JobHandler,
    options?: { workerName?: string; maxParallelJobs?: number; fetchVariables?: string[] },
  ): Promise<WorkerSubscription>;
  /** Tear down all connections. */
  close(): Promise<void>;
}
