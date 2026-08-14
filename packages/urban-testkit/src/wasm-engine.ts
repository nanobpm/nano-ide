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
  type JobHandler,
  type WorkerSubscription,
} from "@nanobpm/urban/runtime";

// These three are structurally re-declared here (rather than imported from
// `@nanobpm/urban/runtime`) on purpose: they let the kit depend only on urban's
// long-published public API, so a scaffolded app can pin the *current* urban
// release instead of an unreleased one. `ProcessInstanceState`/`Snapshot` are
// structurally identical to urban's (an `EngineClient` implementation stays
// assignable by structural typing), and `isRecord` is a generic JSON guard.

/** A process instance's externally-visible lifecycle state — the small set the
 *  instance-tracking reconciler keys on. Structurally identical to urban's
 *  `ProcessInstanceState`. */
export type ProcessInstanceState = "ACTIVE" | "COMPLETED" | "TERMINATED";

/** A single process instance's lifecycle snapshot, as returned by
 *  {@link EngineClient.searchProcessInstances}. Structurally identical to urban's. */
export interface ProcessInstanceSnapshot {
  readonly processInstanceKey: string;
  readonly state: ProcessInstanceState;
}

/** Narrow an untyped JSON value to a plain object. Used to bridge the wasm
 *  engine's JSON-string API into the typed `EngineClient` contract. */
function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Whether a deploy resource is an executable engine model (BPMN or DMN) the WASM engine can parse.
 *  BPMN/DMN are XML (`text/xml`); forms (`application/json`) and other assets are not engine models.
 *  Falls back to the file extension when a contentType is absent. */
function isEngineModel(r: { name?: string; contentType?: string }): boolean {
  const ct = (r.contentType ?? "").toLowerCase();
  if (ct.includes("xml")) return true;
  if (ct.length > 0) return false;
  const name = (r.name ?? "").toLowerCase();
  return name.endsWith(".bpmn") || name.endsWith(".dmn");
}

/** Whether a deploy resource is a form-js `.form` (JSON) — the WASM engine can't execute
 *  it, but the kit captures its schema so the taskInbox surface's `getForm` resolves under
 *  the test engine exactly as it does against a live one. */
function isFormResource(r: { name?: string; contentType?: string }): boolean {
  const ct = (r.contentType ?? "").toLowerCase();
  if (ct.includes("json")) return true;
  if (ct.length > 0) return false;
  return (r.name ?? "").toLowerCase().endsWith(".form");
}

/** Return a copy of `source` containing only the requested keys that are
 *  actually present — the client-side analogue of an engine `fetchVariables`
 *  projection. */
function pick(
  source: Record<string, unknown>,
  keys: readonly string[],
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of keys) {
    if (Object.hasOwn(source, k)) out[k] = source[k];
  }
  return out;
}

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
  /** When set, a job surfaces only this subset of variables (mirrors the live
   *  SDK adapter's `fetchVariables`, which the engine applies server-side). */
  readonly fetchVariables?: readonly string[];
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
    })().catch((err) => {
      // A transient failure (e.g. an fs read error) must not poison every
      // later create(): clear the cached rejection so the next call retries.
      bootPromise = undefined;
      throw err;
    });
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
  /** Deployed form-js schemas captured at deploy time (the WASM engine discards
   *  `.form` resources), keyed by their assigned form key. `#formKeyById` maps a
   *  form's authored id to the key of its most recently deployed version, so a
   *  `getForm({ formId })` resolves to the latest — mirroring the live engine. */
  readonly #formsByKey = new Map<string, { formId?: string; version: number; schema: Record<string, unknown> }>();
  readonly #formKeyById = new Map<string, string>();
  #nextFormKey = 1;
  /** Optional observer notified with a job's type each time a job is dispatched to a
   *  worker handler. Additive, default-absent seam used by the S4 coverage gate to know
   *  which worker/job types were actually exercised; a no-op for every other caller. */
  #onJob: ((jobType: string) => void) | undefined;

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
    // The runtime's `deployModels` sends every model resource here — processes AND decisions AND
    // forms (the manifest `models.forms`). Only executable models go to the engine: BPMN + DMN are
    // XML (`text/xml`); a `.form` is `application/json` and has no engine execution semantics, so
    // forwarding its JSON to the BPMN parser throws "no <process> element found". Deploy only the
    // XML resources and skip the rest, so an app that ships a form still boots under the test engine.
    let deployed = 0;
    for (const r of resources) {
      if (isEngineModel(r)) {
        this.#engine.deploy(r.content);
        deployed++;
        continue;
      }
      // A `.form` has no engine execution semantics, but the taskInbox surface fetches
      // its schema via `getForm`; capture it so the surface works under the test engine.
      if (isFormResource(r)) this.#captureForm(r.content);
    }
    return { deployed };
  }

  /** Parse and store a deployed form-js schema. A form is identified by its `id`; a
   *  redeploy of the same id bumps the version and points the id at the newer key so
   *  `getForm({ formId })` resolves to the latest. */
  #captureForm(content: string): void {
    let schema: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(content);
      if (!isRecord(parsed)) return;
      schema = parsed;
    } catch {
      return;
    }
    const formId = typeof schema.id === "string" && schema.id !== "" ? schema.id : undefined;
    const prevKey = formId ? this.#formKeyById.get(formId) : undefined;
    const version = prevKey ? (this.#formsByKey.get(prevKey)?.version ?? 0) + 1 : 1;
    const formKey = `form-${this.#nextFormKey++}`;
    this.#formsByKey.set(formKey, { formId, version, schema });
    if (formId) this.#formKeyById.set(formId, formKey);
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
  }): Promise<{
    userTaskKey: string;
    elementId?: string;
    variables?: Record<string, unknown>;
    formKey?: string;
    externalFormReference?: string;
  }[]> {
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
      .map((t) => {
        // Surface the task's form linkage. The WASM engine doesn't itself resolve a
        // `formId="X"` linkage to a form key, so map any authored `formId` on the task to
        // the key of the latest deployed form of that id (what `getForm` then fetches);
        // pass through a `formKey`/`externalFormReference` the snapshot already carries.
        const authoredId = typeof t.formId === "string" ? t.formId : undefined;
        const formKey =
          (t.formKey != null && t.formKey !== "" ? str(t.formKey) : undefined) ??
          (authoredId ? this.#formKeyById.get(authoredId) : undefined);
        const externalFormReference =
          typeof t.externalFormReference === "string" && t.externalFormReference !== ""
            ? t.externalFormReference
            : undefined;
        return {
          userTaskKey: str(t.key),
          elementId: typeof t.elementId === "string" ? t.elementId : undefined,
          // Match the live SdkEngineClient: surface the task-local variables
          // attached to the user-task item (undefined when absent), not the
          // whole instance's variables (see runtime/engine/nanosdk.ts).
          variables: isRecord(t.variables) ? t.variables : undefined,
          ...(formKey ? { formKey } : {}),
          ...(externalFormReference ? { externalFormReference } : {}),
        };
      });
  }

  /** Resolve a captured form-js schema by key or by (latest) id. Structurally matches
   *  urban's `EngineClient.getForm`; returns `null` when no such form was deployed. */
  async getForm(input: { formKey?: string; formId?: string }): Promise<
    { formKey?: string; formId?: string; version?: number; schema: Record<string, unknown> } | null
  > {
    const key =
      (input.formKey && input.formKey !== "" ? input.formKey : undefined) ??
      (input.formId ? this.#formKeyById.get(input.formId) : undefined);
    if (!key) return null;
    const found = this.#formsByKey.get(key);
    if (!found) return null;
    return {
      formKey: key,
      ...(found.formId ? { formId: found.formId } : {}),
      version: found.version,
      schema: found.schema,
    };
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
      // Skip keyless items so a missing/null key can't leak in as "" (matches
      // the live SDK adapter, which drops instances with no key).
      if (key === "") continue;
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
      fetchVariables: options?.fetchVariables,
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

  /**
   * Register an observer notified with the `jobType` each time a job is dispatched to a
   * worker handler (before the handler runs, so a failing handler still counts as
   * "exercised"). Returns an unsubscribe. A single observer is held — a later call
   * replaces the earlier one — which is all the coverage gate needs; pass `undefined`
   * (or call the returned unsubscribe) to clear it. The observer is a passive spectator:
   * a throw from it is swallowed and never affects job completion, the drain, or incidents.
   */
  observeJobs(onJob: ((jobType: string) => void) | undefined): () => void {
    this.#onJob = onJob;
    return () => {
      if (this.#onJob === onJob) this.#onJob = undefined;
    };
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
    // A keyless job cannot be completed/failed/errored; skip it rather than
    // issue an invalid completeJob("") (mirrors the live SDK adapter, which
    // logs and leaves such a job for redelivery).
    if (jobKey === "") return;
    const jobType = str(raw.type);
    // Notify the coverage observer (if any) that a job of this type was dispatched — before
    // running the handler, so an exercised-but-failing worker still counts. Isolated in its own
    // try/catch: this is a non-invasive test seam, so a throwing observer must never abort the
    // drain nor alter job/engine semantics (it would otherwise propagate out of #runJob).
    if (this.#onJob !== undefined) {
      try {
        this.#onJob(jobType);
      } catch {
        // Swallow: an observer is a passive spectator of dispatch, never a participant.
      }
    }
    const allVariables = isRecord(raw.variables) ? raw.variables : {};
    const job: EngineJob = {
      jobKey,
      jobType,
      processInstanceKey: raw.instanceKey == null ? undefined : str(raw.instanceKey),
      elementId: typeof raw.elementId === "string" ? raw.elementId : undefined,
      // Honour fetchVariables: surface only the requested subset (intersected
      // with what is present), matching the live SDK adapter's server-side fetch.
      variables: worker.fetchVariables === undefined
        ? allVariables
        : pick(allVariables, worker.fetchVariables),
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
