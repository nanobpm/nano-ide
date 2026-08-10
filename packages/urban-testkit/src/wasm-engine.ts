// A WASM-backed {@link EngineClient} for in-process, deterministic e2e tests
// (ADR 0059 test kit, S1 — issue #157). It backs the exact same `EngineClient`
// seam the live `@nanobpm/nano-sdk` engine adapter (in `@nanobpm/urban`)
// implements, so the shared contract suite in `./contract.ts` can be run against
// both — the seam that would have caught the cancelled-instance state-mapping bug.
//
// The engine (`@nanobpm/engine-wasm`, class `TestEngine`) is synchronous and
// pull-based (`activateJobs` + `completeJob`), with a virtual clock. This adapter
// gives the runtime the *push* worker semantics it expects by draining every
// registered worker to quiescence after each mutating call — so a registered
// worker runs autonomously exactly as it would against a live engine, but
// deterministically and with no wall-clock waits.

import type { TestEngine } from "@nanobpm/engine-wasm";
import {
  type EngineClient,
  type EngineJob,
  isBpmnError,
  isRecord,
  type JobHandler,
  type ProcessInstanceSnapshot,
  type ProcessInstanceState,
  type WorkerSubscription,
} from "@nanobpm/urban/runtime";

// A minimal ambient `Deno` declaration lets this file's runtime branch compile
// under Node's tsc (mirrors the pattern in the urban runtime Deno adapter); the
// `typeof Deno` guard picks the right file-read path at runtime on either host.
declare const Deno: { readFile(url: URL): Promise<Uint8Array> } | undefined;

/** A lock horizon for `activateJobs`. Jobs are completed synchronously inside
 *  {@link WasmEngineClient.drain}, so the lock never actually expires in a run;
 *  the value only has to be comfortably positive. */
const JOB_LOCK_MS = 60_000;

/** Default fan-out per `activateJobs` call when a worker sets no `maxParallelJobs`. */
const DEFAULT_MAX_JOBS = 32;

/** A hard cap on drain iterations, so a worker that endlessly re-creates work
 *  (a modelling bug) surfaces as a thrown error instead of hanging the test. */
const MAX_DRAIN_ITERATIONS = 100_000;

/** Map the wasm engine's process-instance `state` string onto the
 *  transport-agnostic {@link ProcessInstanceState}, mirroring the engine's REST
 *  projection: the transient `Terminating` drain state has already discarded its
 *  tokens and is on its way to `Terminated`, so it projects as `TERMINATED`
 *  externally (parity with `process_instance_state_enum` in the engine server).
 *  Returns `undefined` for an unrecognized value, which the caller skips. */
export function wasmStateToProcessInstanceState(
  raw: unknown,
): ProcessInstanceState | undefined {
  if (typeof raw !== "string") return undefined;
  switch (raw.toUpperCase()) {
    case "ACTIVE":
      return "ACTIVE";
    case "COMPLETED":
      return "COMPLETED";
    case "TERMINATED":
    case "TERMINATING":
      return "TERMINATED";
    default:
      return undefined;
  }
}

/** A registered worker's dispatch parameters. */
interface RegisteredWorker {
  readonly handler: JobHandler;
  readonly workerName: string;
  readonly maxParallelJobs: number;
}

let bootPromise: Promise<typeof import("@nanobpm/engine-wasm")> | undefined;

/** Boot the wasm module once per process, single-flight. The first caller starts
 *  initialization; concurrent callers await the *same* promise, so `initSync`
 *  runs exactly once even when parallel tests each construct an engine (a plain
 *  boolean flag would let two callers race past the guard and double-init).
 *
 *  `@nanobpm/engine-wasm` is imported dynamically so merely importing the testkit
 *  (e.g. the contract runner) does not eagerly load the wasm engine; it is pulled
 *  in only when an engine is actually constructed. Loads the `.wasm` bytes via
 *  `import.meta.resolve` so it works from a published package or a workspace
 *  checkout, on both Node and Deno, with no bundler import-attribute support. */
function bootEngineWasm(): Promise<typeof import("@nanobpm/engine-wasm")> {
  if (!bootPromise) {
    bootPromise = (async () => {
      const mod = await import("@nanobpm/engine-wasm");
      const url = new URL(
        import.meta.resolve("@nanobpm/engine-wasm/nanobpmn_engine_bg.wasm"),
      );
      const bytes = typeof Deno !== "undefined"
        ? await Deno.readFile(url)
        : new Uint8Array(await (await import("node:fs/promises")).readFile(url));
      mod.initSync({ module: bytes });
      return mod;
    })();
  }
  return bootPromise;
}

/**
 * An {@link EngineClient} backed by the in-process `@nanobpm/engine-wasm`
 * engine. Construct via {@link createWasmEngineClient}. Beyond the interface it
 * exposes {@link advanceTime}, {@link snapshot}, and {@link now} for the settle
 * loop and assertions (S2).
 */
export class WasmEngineClient implements EngineClient {
  readonly #engine: TestEngine;
  readonly #workers = new Map<string, RegisteredWorker>();

  private constructor(engine: TestEngine) {
    this.#engine = engine;
  }

  /** Boot the wasm module (idempotent) and return a fresh, empty engine. */
  static async create(): Promise<WasmEngineClient> {
    const mod = await bootEngineWasm();
    return new WasmEngineClient(new mod.TestEngine());
  }

  async deployResources(
    resources: { name: string; content: string; contentType: string }[],
  ): Promise<{ deployed: number }> {
    for (const r of resources) this.#engine.deploy(r.content);
    return { deployed: resources.length };
  }

  async createInstance(input: {
    processDefinitionId: string;
    variables?: Record<string, unknown>;
    awaitCompletion?: boolean;
  }): Promise<{ processInstanceKey: string; variables?: Record<string, unknown> }> {
    const snap = this.#parseObj(
      this.#engine.createInstance(
        input.processDefinitionId,
        JSON.stringify(input.variables ?? {}),
      ),
    );
    const processInstanceKey = requireCreated(snap.created);
    // Registered workers run autonomously against a live engine; mirror that by
    // draining to quiescence so a job whose worker is registered is served now.
    await this.drain();
    if (input.awaitCompletion) {
      return {
        processInstanceKey,
        variables: this.#instanceVariables(processInstanceKey),
      };
    }
    return { processInstanceKey };
  }

  async cancelInstance(input: { processInstanceKey: string }): Promise<void> {
    this.#engine.cancelInstance(input.processInstanceKey);
    await this.drain();
  }

  async publishMessage(input: {
    name: string;
    correlationKey?: string;
    variables?: Record<string, unknown>;
  }): Promise<void> {
    this.#engine.correlateMessage(
      input.name,
      input.correlationKey ?? "",
      JSON.stringify(input.variables ?? {}),
    );
    await this.drain();
  }

  async searchUserTasks(filter?: {
    processInstanceKey?: string;
    assignee?: string;
    candidateGroup?: string;
  }): Promise<{ userTaskKey: string; elementId?: string; variables?: Record<string, unknown> }[]> {
    return records(this.#snapshot().userTasks)
      .filter((t) => str(t.state) === "Created")
      .filter((t) =>
        filter?.processInstanceKey === undefined ||
        str(t.instanceKey) === filter.processInstanceKey
      )
      .filter((t) => filter?.assignee === undefined || str(t.assignee) === filter.assignee)
      .filter((t) =>
        filter?.candidateGroup === undefined ||
        strings(t.candidateGroups).includes(filter.candidateGroup)
      )
      .map((t) => ({
        userTaskKey: str(t.key),
        elementId: typeof t.elementId === "string" ? t.elementId : undefined,
        variables: this.#instanceVariables(str(t.instanceKey)),
      }));
  }

  async completeUserTask(
    userTaskKey: string,
    variables?: Record<string, unknown>,
  ): Promise<void> {
    this.#engine.completeUserTask(userTaskKey, JSON.stringify(variables ?? {}));
    await this.drain();
  }

  async searchProcessInstances(filter?: {
    processInstanceKeys?: string[];
    state?: ProcessInstanceState;
  }): Promise<ProcessInstanceSnapshot[]> {
    const wanted = filter?.processInstanceKeys
      ? new Set(filter.processInstanceKeys)
      : undefined;
    const out: ProcessInstanceSnapshot[] = [];
    for (const inst of records(this.#snapshot().instances)) {
      const key = str(inst.key);
      if (wanted && !wanted.has(key)) continue;
      const state = wasmStateToProcessInstanceState(inst.state);
      if (state === undefined) continue;
      if (filter?.state !== undefined && state !== filter.state) continue;
      out.push({ processInstanceKey: key, state });
    }
    return out;
  }

  async registerWorker(
    jobType: string,
    handler: JobHandler,
    options?: { workerName?: string; maxParallelJobs?: number; fetchVariables?: string[] },
  ): Promise<WorkerSubscription> {
    this.#workers.set(jobType, {
      handler,
      workerName: options?.workerName ?? `urban-testkit:${jobType}`,
      maxParallelJobs: options?.maxParallelJobs ?? DEFAULT_MAX_JOBS,
    });
    // A freshly-registered worker picks up any jobs already waiting for its type.
    await this.drain();
    const workers = this.#workers;
    return {
      jobType,
      async unsubscribe() {
        workers.delete(jobType);
      },
    };
  }

  async close(): Promise<void> {
    this.#workers.clear();
    this.#engine.free();
  }

  // --- Extras beyond EngineClient (used by the settle loop + assertions) ---

  /** Advance the virtual clock by `ms`, firing due timers, then drain workers so
   *  any jobs the timers created are served. */
  async advanceTime(ms: number): Promise<void> {
    this.#engine.advanceTime(ms);
    await this.drain();
  }

  /** The current virtual clock (ms). */
  get now(): number {
    return this.#engine.now;
  }

  /** The raw engine snapshot (parsed). */
  snapshot(): Record<string, unknown> {
    return this.#snapshot();
  }

  /**
   * Serve every registered worker's activatable jobs to quiescence: repeatedly
   * activate + run + acknowledge until a full pass activates nothing. A handler
   * that returns a value completes the job with it; a {@link isBpmnError} throw
   * raises a BPMN error; any other throw fails the job (decrementing retries,
   * raising an incident at zero) — parity with the live adapter.
   */
  async drain(): Promise<void> {
    for (let i = 0; i < MAX_DRAIN_ITERATIONS; i++) {
      let activatedAny = false;
      for (const [jobType, worker] of this.#workers) {
        const jobs = this.#parseArray(
          this.#engine.activateJobs(
            jobType,
            worker.maxParallelJobs,
            JOB_LOCK_MS,
            worker.workerName,
          ),
        );
        for (const raw of jobs) {
          activatedAny = true;
          await this.#runJob(worker, raw);
        }
      }
      if (!activatedAny) return;
    }
    throw new Error(
      `drain did not quiesce after ${MAX_DRAIN_ITERATIONS} iterations (worker re-creating work?)`,
    );
  }

  async #runJob(worker: RegisteredWorker, raw: Record<string, unknown>): Promise<void> {
    const jobKey = str(raw.key);
    const job: EngineJob = {
      jobKey,
      jobType: str(raw.type),
      processInstanceKey: raw.instanceKey == null ? undefined : str(raw.instanceKey),
      elementId: typeof raw.elementId === "string" ? raw.elementId : undefined,
      variables: isRecord(raw.variables) ? raw.variables : {},
    };
    try {
      const out = await worker.handler(job);
      this.#engine.completeJob(jobKey, JSON.stringify(out ?? {}));
    } catch (err) {
      if (isBpmnError(err)) {
        this.#engine.throwError(jobKey, err.errorCode, err.message ?? err.errorCode);
        return;
      }
      const retries = typeof raw.retries === "number" ? raw.retries : 1;
      this.#engine.failJob(
        jobKey,
        Math.max(0, retries - 1),
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  #snapshot(): Record<string, unknown> {
    return this.#parseObj(this.#engine.snapshot());
  }

  #instanceVariables(key: string): Record<string, unknown> {
    const inst = records(this.#snapshot().instances).find((i) => str(i.key) === key);
    return isRecord(inst?.variables) ? inst.variables : {};
  }

  #parseObj(json: string): Record<string, unknown> {
    const v: unknown = JSON.parse(json);
    return isRecord(v) ? v : {};
  }

  #parseArray(json: string): Record<string, unknown>[] {
    const v: unknown = JSON.parse(json);
    return records(v);
  }
}

/** Boot the wasm engine (idempotent) and return a fresh {@link WasmEngineClient}. */
export function createWasmEngineClient(): Promise<WasmEngineClient> {
  return WasmEngineClient.create();
}

function requireCreated(created: unknown): string {
  if (created == null || created === "") {
    throw new Error("engine createInstance response missing `created` instance key");
  }
  return String(created);
}

/** The `Record<string, unknown>` elements of an unknown value (non-records dropped). */
function records(v: unknown): Record<string, unknown>[] {
  return Array.isArray(v) ? v.filter(isRecord) : [];
}

/** The `string` elements of an unknown value (non-strings dropped). */
function strings(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

function str(v: unknown): string {
  return v == null ? "" : String(v);
}
