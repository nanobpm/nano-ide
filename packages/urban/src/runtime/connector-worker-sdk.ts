// The in-process `@nanobpm/worker` shim (ADR 0050, in-process port).
//
// A connector pack's `worker.ts` is a self-contained program that imports the
// host-provided `@nanobpm/worker` SDK and calls `defineWorker({ type, handle })`.
// The old Rust host ran each such worker as its own supervised child process. The
// @nanobpm/urban runtime hosts app workers IN-PROCESS, so it hosts connector
// workers the same way: it aliases the pack's `@nanobpm/worker` import to THIS
// module, imports the pack entry, and reads back the registered handler(s) —
// which it then registers on the engine like any other worker.
//
// `defineWorker` here does NOT connect to anything. It only records the handler in
// a module-level registry that the runtime drains (`drainDefinedWorkers`). Because
// the pack and the runtime resolve `@nanobpm/worker` to the SAME module URL, they
// share this registry instance.
//
// This module is deliberately runtime-agnostic (no `node:*`, no `Deno`): it is the
// contract surface, and the Node/Deno specifics of aliasing the import live in the
// adapters.

/** One activated job handed to a connector worker's `handle` (the subset the
 *  `@nanobpm/worker` contract exposes; mirrors packages/connector-slack/types). */
export interface ConnectorWorkerJob {
  readonly jobKey: string;
  readonly type: string;
  readonly processInstanceKey: string;
  readonly elementId?: string;
  readonly variables: Record<string, unknown>;
  /** Complete the job, optionally with output variables. */
  complete(variables?: Record<string, unknown>): Promise<void>;
  /** Fail the job (retryable). */
  fail(message: string, retries?: number): Promise<void>;
  /** Raise a BPMN error (routed to an error boundary event). */
  error(code: string, message?: string): Promise<void>;
}

/** The options a connector worker passes to `defineWorker`. */
export interface ConnectorWorkerOptions {
  type: string;
  maxParallelJobs?: number;
  timeoutMs?: number;
  /** Ignored in-process: the runtime owns the engine connection. Accepted so a
   *  pack authored against the standalone SDK still type-checks and imports. */
  baseUrl?: string;
  worker?: string;
  handle(job: ConnectorWorkerJob): Promise<Record<string, unknown> | void> | Record<string, unknown> | void;
}

/** A worker the runtime will register on the engine, drained from the registry. */
export interface DefinedConnectorWorker {
  type: string;
  maxParallelJobs?: number;
  /** Job lock timeout, ms (issue #596) — carried from `defineWorker({ timeoutMs })`. */
  timeoutMs?: number;
  handle: ConnectorWorkerOptions["handle"];
}

// Module-level registry. Shared across every importer of this module URL, which is
// exactly how the pack's `defineWorker` call reaches the runtime's drain: both
// resolve `@nanobpm/worker` to this file.
const registered: DefinedConnectorWorker[] = [];

/** The `@nanobpm/worker` entrypoint the pack calls. Records the handler; does not
 *  connect. */
export function defineWorker(opts: ConnectorWorkerOptions): void {
  if (!opts || typeof opts.type !== "string" || opts.type.length === 0) {
    throw new Error("defineWorker: `type` is required");
  }
  if (typeof opts.handle !== "function") {
    throw new Error(`defineWorker("${opts.type}"): handle must be a function`);
  }
  registered.push({
    type: opts.type,
    maxParallelJobs: opts.maxParallelJobs,
    timeoutMs: opts.timeoutMs,
    handle: opts.handle,
  });
}

/** Return every worker registered since the last drain, and clear the registry.
 *  The runtime calls this immediately after importing one pack entry, so the
 *  returned set belongs to that pack. */
export function drainDefinedWorkers(): DefinedConnectorWorker[] {
  const out = registered.splice(0, registered.length);
  return out;
}
