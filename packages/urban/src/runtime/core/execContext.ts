// Ambient job execution context — threads the active job's process instance / element through
// to DataLayer writes so write-provenance capture (ProcessOS domain-signal plane, D0) can join
// written rows back to the instance/element that wrote them, WITHOUT plumbing the job through
// every call. Entirely domain-free: it knows nothing about any app's tables or their meaning.
//
// The async primitive (`AsyncLocalStorage`) is a host capability (`node:async_hooks`), so it is
// injected through the `HostContext` seam; core stays `node:*`-free per the host contract. When
// no store is installed — a host that doesn't provide one, or a plain unit test — `run()` just
// calls `fn` and `current()` returns undefined, so capture degrades to a no-op. Absent-safe and
// zero-cost when off, by construction.

import type { AsyncStore } from "./host.ts";

/** The ambient context of the job currently executing on a worker. All fields are optional so a
 *  job dispatched without an instance/element still runs; provenance is only recorded when an
 *  `instanceKey` is present. */
export interface JobExecContext {
  /** The process instance that dispatched the running job. */
  instanceKey?: string;
  /** The BPMN element (e.g. service task) the job is for. */
  elementId?: string;
  /** The job type (worker) currently executing. */
  jobType?: string;
}

let store: AsyncStore<JobExecContext> | undefined;

/**
 * Install the host-backed ambient store once per process. Idempotent — the first store created
 * wins: every Node/Deno store is an equivalent `AsyncLocalStorage` instance, and a process that
 * hosts several apps shares one async store safely (values are keyed by async execution context,
 * not by app). A `factory` that returns undefined (a host without the capability) leaves capture
 * disabled, but a later capable host may still install the process store.
 */
export function installExecStore(factory: () => AsyncStore<JobExecContext> | undefined): void {
  if (store) return;
  const next = factory();
  if (next) store = next;
}

/** Run `fn` with `ctx` as the ambient job context. A transparent pass-through when no store is
 *  installed (returns `fn()` directly). */
export function runInJobContext<R>(ctx: JobExecContext, fn: () => R): R {
  return store ? store.run(ctx, fn) : fn();
}

/** The ambient job context of the current async execution, or undefined outside a job (or when
 *  no store is installed). */
export function currentJobContext(): JobExecContext | undefined {
  return store?.current();
}

/** Test seam: drop the installed store so a subsequent {@link installExecStore} re-installs. */
export function __resetExecStoreForTests(): void {
  store = undefined;
}
