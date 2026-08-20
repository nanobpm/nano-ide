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

import type { TestEngine } from "@nanobpm/engine-wasm/readmodel";
// The engine's derived read-model DTO types — the single source of truth for the
// shapes its REST read channel returns (`searchUserTasks` / `searchProcessInstances` /
// `getFormByKey`). Generated from the Camunda-parity OpenAPI in engine-wasm (#881), so
// this adapter reads those results through the *derived* types instead of hand-mirroring
// their fields — No Drift Surfaces (AGENTS.md). Type-only, so nothing is pulled at runtime.
import type {
  FormResult,
  ProcessInstanceSearchQueryResult,
  UserTaskSearchQueryResult,
} from "@nanobpm/engine-wasm/readmodel-types";
import {
  applyAmbientLineage,
  type EngineClient,
  type EngineJob,
  isBpmnError,
  type JobHandler,
  type UserTaskState,
  type UserTaskFilter,
  type WorkerSubscription,
} from "@nanobpm/urban/runtime";
import { applyOutcome, MockWorkerBuilder } from "./worker-mock.ts";
import {
  childProcessIdFromJobType,
  childProcessJobType,
  MockChildProcessBuilder,
  rewriteCallActivities,
} from "./child-process-mock.ts";

// `ProcessInstanceState` and the wasm→state projection
// `wasmStateToProcessInstanceState` are the canonical read-model mapping owned by
// `@nanobpm/engine-testkit` (issue Magikcraft/nano-bpm#894); import and re-export
// them so this adapter and the lifted assertion DSL share ONE definition
// (No Drift Surfaces, AGENTS.md) instead of the two byte-identical copies they had
// before. The state mapping is therefore sourced from `@nanobpm/engine-testkit`
// (this adapter already imports `@nanobpm/urban/runtime` too). `ProcessInstanceSnapshot`
// stays declared here as a local structural mirror of urban's shape — not re-exported
// from engine-testkit — so a scaffolded app can still pin the *current* urban release
// without engine-testkit dictating that DTO; `isRecord` is a generic JSON guard.
import {
  type ProcessInstanceState,
  wasmStateToProcessInstanceState,
} from "@nanobpm/engine-testkit";
export { type ProcessInstanceState, wasmStateToProcessInstanceState };

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

/** Defensively narrow an untyped read-model search response to its object rows. The DTO
 *  annotation on a `JSON.parse`d body is a shape *claim*, not a runtime guarantee, so guard
 *  the body, its `items` array, and each row: a malformed/changed engine response (a non-object
 *  body, a non-array `items`, or `null`/non-object rows) yields `[]`/drops the bad row instead
 *  of throwing downstream. Keeps the caller's DTO row type — the single source of truth both
 *  `searchUserTasks` and `searchProcessInstances` extract through, so they cannot drift. */
export function searchRows<T>(body: { items: T[] }): T[] {
  if (!isRecord(body) || !Array.isArray(body.items)) return [];
  return body.items.filter(isRecord);
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

/** A real-timer macrotask yield: runs after every currently-queued microtask, so awaiting it
 *  lets a just-dispatched worker handler's async chain drain to the point it either completes
 *  or parks on a virtual-clock `app.wait` timer. Uses the real `setTimeout` captured up front so
 *  it is immune to a handler (or test) swapping `globalThis.setTimeout`. */
const realSetTimeout: typeof setTimeout = globalThis.setTimeout;
const flushMacrotask = (): Promise<void> => new Promise<void>((resolve) => realSetTimeout(resolve, 0));

/** A registered worker's dispatch parameters. */
interface RegisteredWorker {
  readonly handler: JobHandler;
  readonly workerName: string;
  readonly maxParallelJobs: number;
  /** When set, a job surfaces only this subset of variables (mirrors the live
   *  SDK adapter's `fetchVariables`, which the engine applies server-side). */
  readonly fetchVariables?: readonly string[];
}

/** A synthetic activation descriptor for a mock-only type (a mocked `taskType` with no real
 *  `registerWorker`). It only supplies the `activateJobs` parameters so a mock-only type's jobs
 *  can be pulled; its `handler` is never called (the mock either resolves the job or, on no
 *  clause match, `#runJob` leaves it because `hasRealWorker` is false). */
function mockOnlyWorker(jobType: string): RegisteredWorker {
  return {
    handler: () => {
      throw new Error(`mock-only worker for "${jobType}" has no handler — this should be unreachable`);
    },
    workerName: `urban-testkit:mock:${jobType}`,
    maxParallelJobs: DEFAULT_MAX_JOBS,
  };
}

let bootPromise: Promise<typeof import("@nanobpm/engine-wasm/readmodel")> | undefined;

/** Boot the wasm module once per process, single-flight. The first caller starts
 *  initialization; concurrent callers await the *same* promise, so `initSync`
 *  runs exactly once even when parallel tests each construct an engine (a plain
 *  boolean flag would let two callers race past the guard and double-init).
 *
 *  `@nanobpm/engine-wasm/readmodel` is imported dynamically so merely importing the
 *  testkit (e.g. the contract runner) does not eagerly load the wasm engine; it is
 *  pulled in only when an engine is actually constructed. We import the **read-model**
 *  subpath (not the lean default): it is the lean engine plus the gateway's SQLite
 *  read model compiled to wasm, so the REST read methods (`getFormByKey`,
 *  `searchUserTasks`, `searchProcessInstances`, …) are served by the *real* read
 *  channel instead of a hand-maintained JS twin (epic Magikcraft/nano-bpm#796).
 *  Loads the `.wasm` bytes via `import.meta.resolve` so it works from a published
 *  package or a workspace checkout, on both Node and Deno, with no bundler
 *  import-attribute support. */
function bootEngineWasm(): Promise<typeof import("@nanobpm/engine-wasm/readmodel")> {
  if (!bootPromise) {
    bootPromise = (async () => {
      const mod = await import("@nanobpm/engine-wasm/readmodel");
      const url = new URL(
        import.meta.resolve(
          "@nanobpm/engine-wasm/readmodel/nanobpmn_engine_bg.wasm",
        ),
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
  /** Job-worker mocks keyed by jobType (epic #296, S1). A mocked type is resolved by its
   *  {@link MockWorkerBuilder} at dispatch (see {@link mockWorker}) instead of running the
   *  real handler; an un-mocked type — or a mock whose clauses don't match a given job —
   *  runs real code. Empty and untouched unless a test calls {@link mockWorker}, so mocking
   *  is strictly opt-in and zero-cost when unused. */
  readonly #workerMocks = new Map<string, MockWorkerBuilder>();
  /** Child-process (call-activity) mocks keyed by *called process id* (epic #296, S3). A call
   *  activity to a mocked process id is resolved by its {@link MockChildProcessBuilder} — completed
   *  (merging its variables into the parent) or failed — instead of the engine's native pass-through.
   *  Empty and untouched unless a test calls {@link mockChildProcess}, so it is strictly opt-in. */
  readonly #childProcessMocks = new Map<string, MockChildProcessBuilder>();
  /** The synthetic call-activity job types minted by {@link deployResources}'s rewrite (one per
   *  distinct called process id seen across deployed models). These are always dispatched by
   *  {@link drain} — resolved through a child-process mock when one exists, else completed through
   *  with no variables to reproduce the engine's native call-activity pass-through. Populated only
   *  for models that actually contain a call activity. */
  readonly #childProcessJobTypes = new Set<string>();
  /** Optional observer notified with a job's type each time a job is dispatched to a
   *  worker handler. Additive, default-absent seam used by the S4 coverage gate to know
   *  which worker/job types were actually exercised; a no-op for every other caller. The
   *  second argument reports whether the dispatch was satisfied by a mock (epic #296, S4),
   *  so a mocked-but-exercised type is recorded as covered AND flagged as mocked. */
  #onJob: ((jobType: string, mocked: boolean) => void) | undefined;

  /** Worker handlers that have been dispatched but not yet resolved — a real push worker runs
   *  autonomously, so a handler doing time-bounded work (`app.wait` on the virtual clock) must
   *  NOT block {@link drain}: it is dispatched fire-and-forget and tracked here, then driven to
   *  completion as virtual time advances (`advanceTime` fires its waits). {@link drain} quiesces
   *  these each iteration — awaiting the ones that finish (or park on a *future* wait) — so a
   *  quick handler's effects stay visible after `settle()` exactly as before, while a parked one
   *  is simply left in-flight instead of deadlocking the drain on a clock that only moves later. */
  readonly #inflight = new Set<Promise<void>>();
  /** Job keys whose handler is currently in-flight (dispatched, not yet settled). Advancing virtual
   *  time past a job's activation lock makes the engine re-offer a still-running job; this set lets
   *  {@link drain} skip spawning a duplicate handler for one the in-flight instance already owns. */
  readonly #inflightJobKeys = new Set<string>();
  /** The first error a tracked in-flight handler surfaced from its engine-completion call, held so
   *  {@link drain} can rethrow it at the next quiesce point (preserving fail-loud), then cleared. */
  #inflightError: unknown;
  /** Monotonic count of tracked handlers that have *settled* (completed or failed and left
   *  {@link #inflight}) — never incremented by a handler still parked on a future virtual wait.
   *  {@link drain} samples it around {@link #quiesce} to detect a handler that finished mid-quiesce
   *  and may have enqueued fresh engine work, so it loops for another activation pass instead of
   *  returning early on `!activatedAny` and leaving that work undrained until a later `settle`. */
  #completions = 0;

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
    // The runtime's `deployModels` sends every deployable here — BPMN + DMN (`text/xml`),
    // `.form` (`application/json`), and, under ADR 0062 deploy-by-convention, any other file
    // swept from `resources/`. Only executable models can run under the WASM engine: BPMN/DMN
    // are parsed by the engine. This adapter does *not* forward `.form` resources into the engine
    // (only `isEngineModel` resources are deployed above), so a deployed `.form` is accepted and
    // counted but is not resolvable here — deploying it populates no read model. The `getForm`
    // read path delegates to the engine's real read model (`getFormByKey`), not a JS shadow store,
    // but it can only return a form once the `.form` *write* path (Magikcraft/nano-bpm#815) lands
    // *and* this adapter is updated to forward `.form` content; that does not happen automatically.
    // Any *other* generic resource likewise has no read surface here. Every non-executable resource
    // is inert to the BPMN parser here.
    for (const r of resources) {
      if (isEngineModel(r)) this.#engine.deploy(this.#rewriteForChildProcessMocks(r.content));
    }
    // Match `SdkEngineClient.deployResources`: the deployment accepts every resource, so the
    // `deployed` count is the total — a form (or any non-executable asset) still counts as
    // deployed even though the WASM engine doesn't execute it.
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
        // Auto-thread the `_urban.lineage` envelope via the same shared step the live
        // SdkEngineClient uses (No Drift Surfaces), so lineage is observable in-harness (issue #254).
        JSON.stringify(applyAmbientLineage(input.variables)),
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
      JSON.stringify(applyAmbientLineage(input.variables)),
    );
    await this.drain();
  }

  async searchUserTasks(filter?: UserTaskFilter & {
    state?: UserTaskState;
  }): Promise<{
    userTaskKey: string;
    elementId?: string;
    variables?: Record<string, unknown>;
    formKey?: string;
    externalFormReference?: string;
  }[]> {
    // Delegate to the engine's real REST read channel (`POST /user-tasks/search`) instead of
    // scraping the primary-state snapshot. The read model honours the `{ state? }` filter
    // (e.g. `"CREATED"`) itself, so pass it through rather than re-implementing state matching.
    // Parse the result through the engine's DERIVED `UserTaskSearchQueryResult` DTO
    // (`@nanobpm/engine-wasm/readmodel-types`) — the single source of truth for the row shape —
    // so `items` is a typed `UserTaskResult[]` rather than a hand-scraped `Record` bag.
    const body: UserTaskSearchQueryResult = JSON.parse(
      this.#engine.searchUserTasks(
        JSON.stringify(filter?.state ? { state: filter.state } : {}),
      ),
    );
    // `body`/`items` come straight from an untyped `JSON.parse` boundary, so the DTO annotation
    // is a shape *claim*, not a runtime guarantee. `searchRows` guards the body and drops
    // non-object rows so a malformed/changed engine response can't throw downstream.
    return searchRows(body)
      // The read model does not yet honour the non-lifecycle selectors
      // (`processInstanceKey`/`assignee`/`candidateGroup` — the write/index side is
      // Magikcraft/nano-bpm#815's follow-up), so apply them client-side here. This mirrors the
      // *effective* behaviour of the gateway-backed `SdkEngineClient`, which gets them honoured
      // server-side; the results are identical, only the filtering site differs.
      .filter((t) =>
        filter?.processInstanceKey === undefined ||
        str(t.processInstanceKey) === filter.processInstanceKey
      )
      .filter((t) => filter?.assignee === undefined || t.assignee === filter.assignee)
      .filter((t) =>
        filter?.candidateGroup === undefined ||
        (Array.isArray(t.candidateGroups) && t.candidateGroups.includes(filter.candidateGroup))
      )
      .flatMap((t) => {
        // A keyless row cannot be acted on — drop it (parity with `SdkEngineClient`, which logs
        // and skips such a row). `presentKey` also normalises a numeric key to a trimmed string.
        const userTaskKey = presentKey(t.userTaskKey);
        if (userTaskKey === undefined) return [];
        // The read model already resolves a `<zeebe:formDefinition formId="X" />` linkage to the
        // latest deployed form's key server-side, so `formKey`/`externalFormReference` arrive
        // resolved on the row — no client-side id→key map (the deleted `#formKeyById` shadow).
        // Presence is type-aware (mirrors the shared form contract's `pickFormLinkage`): a
        // `formKey` counts only when a string/number, an `externalFormReference` only when a
        // string, so a non-string value can never coerce into a garbage `"[object Object]"` id.
        const formKey = presentKey(t.formKey);
        const externalFormReference = presentString(t.externalFormReference);
        return [{
          userTaskKey,
          elementId: typeof t.elementId === "string" ? t.elementId : undefined,
          ...(formKey ? { formKey } : {}),
          ...(externalFormReference ? { externalFormReference } : {}),
        }];
      });
  }

  /** The open (answerable) user tasks — `searchUserTasks` pinned to `state: "CREATED"`.
   *  Mirrors `SdkEngineClient.openUserTasks`: the single safe accessor for reconcile/
   *  affordance paths, derived from `searchUserTasks` so the two cannot drift. */
  openUserTasks(filter?: UserTaskFilter): Promise<{
    userTaskKey: string;
    elementId?: string;
    variables?: Record<string, unknown>;
    formKey?: string;
    externalFormReference?: string;
  }[]> {
    return this.searchUserTasks({ ...filter, state: "CREATED" });
  }

  /** Fetch a deployed form's form-js schema from the engine's real read model
   *  (`GET /forms/{formKey}` via `getFormByKey`). Structurally matches urban's
   *  `EngineClient.getForm`; returns `null` when no such form exists in the read model. */
  async getForm(input: { formKey?: string; formId?: string }): Promise<
    { formKey?: string; formId?: string; version?: number; schema: Record<string, unknown> } | null
  > {
    // Mirror `SdkEngineClient.getForm`'s identifier normalization exactly (a behavioral
    // drift surface guarded by a test): an empty/whitespace-only identifier is *absent*, so a
    // blank `formKey` falls through to whatever `formId` is present. The engine addresses a form
    // by a single deploy key, so pass whichever identifier is present straight through to
    // `getFormByKey` (no local id→key map — the read model owns that resolution now). That
    // fallback identifier need not be a usable key: a malformed key — e.g. an authored `formId`
    // handed through as the fallback — makes `getFormByKey` *throw*; like the REST gateway's 404,
    // that is treated below as "no such form" (null), not propagated.
    const key = present(input.formKey) ?? present(input.formId);
    if (key == null) return null;
    // The engine addresses a form by a numeric deploy key and *throws* on a malformed key (e.g. an
    // authored id passed through as the fallback). Mirror `SdkEngineClient.getForm`, which treats a
    // failed fetch as "no such form" and returns null rather than propagating. Parse through the
    // engine's DERIVED `FormResult` DTO (`@nanobpm/engine-wasm/readmodel-types`) — its `schema`
    // (JSON string), `formKey`, `formId`, and `version` fields are the single source of truth.
    let body: FormResult | null;
    try {
      body = JSON.parse(this.#engine.getFormByKey(key));
    } catch {
      return null;
    }
    // Build the typed result through the shared `parseForm` boundary guard (single source of
    // truth): `getFormByKey` returns JSON `null` for an unknown key, and the `FormResult` DTO
    // annotation is only a shape *claim*, so `parseForm` guards the body (excluding arrays) and a
    // missing/invalid schema, treating either as "no such form" (`null`).
    return parseForm(body);
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
    // Delegate to the engine's real REST read channel (`POST /process-instances/search`)
    // instead of scraping the primary-state snapshot. The read model does not yet honour
    // filter/sort/page fields server-side (it returns every instance — the write/index side is
    // Magikcraft/nano-bpm#815's follow-up), so apply the key/state selectors client-side. This
    // mirrors the *effective* behaviour of the gateway-backed `SdkEngineClient`, which gets them
    // honoured server-side; only the filtering site differs. Parse through the engine's DERIVED
    // `ProcessInstanceSearchQueryResult` DTO (`@nanobpm/engine-wasm/readmodel-types`) so each
    // row is a typed `ProcessInstanceResult` rather than a hand-scraped `Record` bag.
    const body: ProcessInstanceSearchQueryResult = JSON.parse(
      this.#engine.searchProcessInstances("{}"),
    );
    const out: ProcessInstanceSnapshot[] = [];
    // Same untyped-JSON defence as `searchUserTasks`: `searchRows` guards the body and drops
    // non-object rows so a malformed/changed engine response can't throw while reading
    // `inst.processInstanceKey`.
    for (const inst of searchRows(body)) {
      const key = presentKey(inst.processInstanceKey);
      // Skip keyless items so a missing/null key can't leak in as "" (matches
      // the live SDK adapter, which drops instances with no key).
      if (key === undefined) continue;
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
    this.#workerMocks.clear();
    this.#childProcessMocks.clear();
    this.#childProcessJobTypes.clear();
    this.#engine.free();
  }

  // --- Extras beyond EngineClient (used by the settle loop + assertions) ---

  /**
   * Register (or fetch the existing) job-worker mock for `taskType` (epic #296, S1).
   * A mocked type is resolved by its {@link MockWorkerBuilder} at the dispatch seam
   * ({@link drain} → `#runJob`) — completed / failed / errored by the mock's matching
   * clause **instead of** the app's real handler — while un-mocked types, and jobs a
   * mock's `when(...)` clauses don't match, still run real code. The builder shadows
   * the real handler for the app's lifetime; call `.reset()` on it (or
   * {@link clearWorkerMock}) to remove the mock and restore real behaviour.
   *
   * Idempotent per type: repeated calls return the SAME builder, so conditional
   * clauses accumulate in registration order across calls. Purely opt-in — no mock
   * bookkeeping happens on any dispatch until this is first called for a type.
   */
  mockWorker(taskType: string): MockWorkerBuilder {
    let builder = this.#workerMocks.get(taskType);
    if (builder === undefined) {
      builder = new MockWorkerBuilder(() => {
        this.#workerMocks.delete(taskType);
      });
      this.#workerMocks.set(taskType, builder);
    }
    return builder;
  }

  /**
   * Remove any job-worker mock for `taskType`, restoring its real handler. No-op if
   * unmocked. Delegates to the builder's {@link MockWorkerBuilder.reset} so a test that
   * still holds the builder reference sees its clauses and pending predicate cleared too
   * — not just the registry entry dropped.
   */
  clearWorkerMock(taskType: string): void {
    this.#workerMocks.get(taskType)?.reset();
  }

  /**
   * Register (or fetch the existing) child-process (call-activity) mock for `processId`
   * (epic #296, S3). A call activity whose `zeebe:calledElement processId` matches is resolved
   * by the returned {@link MockChildProcessBuilder} — `completeWith(vars)` merges `vars` into the
   * parent before it continues past the call activity; `failWith(...)` raises an incident on the
   * call-activity element — **instead of** the engine's native pass-through, while un-mocked call
   * activities keep their native behaviour. Reuses the shared {@link MockOutcome}/`applyOutcome`.
   *
   * The seam is a deploy-time rewrite: {@link deployResources} turns each call activity into a
   * synthetic job keyed by its called process id, which {@link drain} resolves through this
   * builder. So this must be called for a process id whose parent model was deployed as a call
   * activity; a mock on an id with no such call activity simply never fires. Call `.reset()` on
   * the builder (or {@link clearChildProcessMock}) to restore the native pass-through.
   *
   * Idempotent per id: repeated calls return the SAME builder. Only the **mock registry** is
   * opt-in here — registering an outcome is what makes a call activity resolve to something other
   * than the native pass-through. The deploy-time rewrite and drain-time dispatch of call-activity
   * jobs are NOT gated on this call: {@link deployResources} rewrites every call activity and
   * {@link drain} activates those synthetic jobs (completing them through with no variables) even
   * with zero mocks registered.
   */
  mockChildProcess(processId: string): MockChildProcessBuilder {
    let builder = this.#childProcessMocks.get(processId);
    if (builder === undefined) {
      builder = new MockChildProcessBuilder(() => {
        this.#childProcessMocks.delete(processId);
      });
      this.#childProcessMocks.set(processId, builder);
    }
    return builder;
  }

  /**
   * Remove any child-process mock for `processId`, restoring the engine's native call-activity
   * pass-through. No-op if unmocked. Delegates to the builder's
   * {@link MockChildProcessBuilder.reset} so a test still holding the reference sees its outcome
   * cleared too — not just the registry entry dropped.
   */
  clearChildProcessMock(processId: string): void {
    this.#childProcessMocks.get(processId)?.reset();
  }

  /** Rewrite a model's call activities into synthetic child-process jobs (see
   *  {@link rewriteCallActivities}) and remember their job types so {@link drain} dispatches them.
   *  A model with no call activity is returned untouched, so non-call-activity apps pay nothing. */
  #rewriteForChildProcessMocks(xml: string): string {
    const { xml: rewritten, calledProcessIds } = rewriteCallActivities(xml);
    for (const processId of calledProcessIds) {
      this.#childProcessJobTypes.add(childProcessJobType(processId));
    }
    return rewritten;
  }

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
   * "exercised"). The second argument reports whether that dispatch was satisfied by a
   * job-worker mock (epic #296, S4) — the coverage gate records the type as exercised
   * either way, and additionally flags it as mocked so a mocked worker stays an honest,
   * visible entry rather than a silently-hidden gap. Returns an unsubscribe. A single
   * observer is held — a later call replaces the earlier one — which is all the coverage
   * gate needs; pass `undefined` (or call the returned unsubscribe) to clear it. The
   * observer is a passive spectator: a throw from it is swallowed and never affects job
   * completion, the drain, or incidents.
   */
  observeJobs(onJob: ((jobType: string, mocked: boolean) => void) | undefined): () => void {
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
   * Serve every registered worker's — and every mock-only type's — activatable jobs to
   * quiescence: repeatedly activate + run + acknowledge until a full pass activates
   * nothing. A handler that returns a value completes the job with it; a
   * {@link isBpmnError} throw raises a BPMN error; any other throw fails the job
   * (decrementing retries, raising an incident at zero) — parity with the live adapter.
   *
   * A **mock-only** type (one with a {@link mockWorker} mock but no real
   * `registerWorker`) is also drained, so a test can mock a worker the app never
   * registered (e.g. an unimplemented external integration). Its jobs are activated and
   * resolved by the mock; a job the mock's clauses don't match is left locked (no real
   * handler exists to run it), which keeps the drain a fixpoint rather than spinning.
   *
   * Synthetic **child-process** job types (minted by {@link deployResources} for a rewritten
   * call activity, epic #296 S3) are also drained: each such job is resolved through its
   * {@link mockChildProcess} outcome, or — when the called process is unmocked — completed
   * through with no variables, reproducing the engine's native call-activity pass-through.
   */
  async drain(): Promise<void> {
    for (let i = 0; i < MAX_DRAIN_ITERATIONS; i++) {
      let activatedAny = false;
      for (const jobType of this.#dispatchableJobTypes()) {
        // A synthetic child-process job type has no registered worker and is resolved on its own
        // dedicated path (call-activity outcome / native pass-through), never as a worker.
        // Classify by membership in the minted set (not a prefix test) AND the absence of a real
        // worker, so a real worker whose type happened to share the synthetic prefix is never
        // hijacked onto the child-process path.
        const realWorker = this.#workers.get(jobType);
        const isChildProcess = realWorker === undefined && this.#childProcessJobTypes.has(jobType);
        // A mock-only or child-process type has no registered worker; use a synthetic activation
        // descriptor so its jobs can be pulled. Its handler is never invoked.
        const worker = realWorker ?? mockOnlyWorker(jobType);
        const jobs = this.#parseArray(
          this.#engine.activateJobs(
            jobType,
            worker.maxParallelJobs,
            JOB_LOCK_MS,
            worker.workerName,
          ),
        );
        for (const raw of jobs) {
          if (isChildProcess) {
            activatedAny = true;
            this.#runChildProcessJob(jobType, raw);
            continue;
          }
          // Advancing virtual time can expire a still-running job's activation lock, so the engine
          // re-offers a job whose handler is already in-flight (parked on a future `app.wait`). Don't
          // spawn a duplicate handler for it, and don't count it as progress — the in-flight instance
          // owns its single completion (a second `completeJob` would hit "not in a state that can be
          // acted on").
          const jobKey = str(raw.key);
          if (jobKey !== "" && this.#inflightJobKeys.has(jobKey)) continue;
          activatedAny = true;
          // Fire-and-forget: a push worker runs autonomously, so dispatching must not block the
          // drain on the handler. A quick handler is still awaited to completion by the `#quiesce`
          // below (so its effects are visible after `settle`); a handler parked on a *future*
          // virtual-clock `app.wait` is left in-flight for `advanceTime` to drive, instead of
          // deadlocking the drain on a clock that only moves later.
          this.#track(jobKey, this.#runJob(worker, realWorker !== undefined, raw));
        }
      }
      // Let every handler dispatched this iteration run until it completes (its `completeJob` may
      // enqueue fresh engine work the next iteration picks up) or parks on a future wait.
      const completionsBefore = this.#completions;
      await this.#quiesce();
      // A handler that *settled* during `#quiesce` (as opposed to merely parking on a future wait)
      // may have enqueued fresh engine work via its `completeJob`. Even when this pass activated
      // nothing, that newly enqueued work must get an activation pass, so only reach the fixpoint —
      // and return — once a pass both activates nothing new AND settles no in-flight handler.
      const settledAny = this.#completions !== completionsBefore;
      if (!activatedAny && !settledAny) return;
    }
    throw new Error(
      `drain did not quiesce after ${MAX_DRAIN_ITERATIONS} iterations (worker re-creating work?)`,
    );
  }

  /** Track a fire-and-forget worker handler promise (and its job key) until it settles. `#runJob`
   *  maps a handler throw onto the engine's completion surface internally, so a rejection here can
   *  only come from the engine completion call itself; capture it (deduped) so {@link drain} can
   *  rethrow it loudly rather than let it escape as an unhandled rejection. */
  #track(jobKey: string, p: Promise<void>): void {
    if (jobKey !== "") this.#inflightJobKeys.add(jobKey);
    const tracked = p
      .catch((err: unknown) => {
        if (this.#inflightError === undefined) this.#inflightError = err;
      })
      .finally(() => {
        this.#completions++;
        this.#inflight.delete(tracked);
        if (jobKey !== "") this.#inflightJobKeys.delete(jobKey);
      });
    this.#inflight.add(tracked);
  }

  /** Drain in-flight worker handlers to a fixpoint at the current virtual instant: flush macrotasks
   *  until the in-flight count stops changing. A handler that completes (or fails) leaves the set
   *  and may enqueue engine work; a handler parked on a *future* `app.wait` timer stops consuming
   *  microtasks, so the count stabilises and this returns with that handler still in-flight — to be
   *  resumed by a later `advanceTime`. Rethrows the first engine-completion error a tracked handler
   *  surfaced, preserving the fail-loud semantics the previous inline `await` had. */
  async #quiesce(): Promise<void> {
    let prev = -1;
    while (this.#inflight.size !== prev) {
      prev = this.#inflight.size;
      await flushMacrotask();
    }
    if (this.#inflightError !== undefined) {
      const err = this.#inflightError;
      this.#inflightError = undefined;
      throw err;
    }
  }

  /** The job types to activate on a drain pass: every registered worker, every mock-only type
   *  that actually carries at least one clause (an empty/reset mock induces no dispatch), plus
   *  every synthetic child-process type (always dispatched — resolved via a mock or completed
   *  through to mirror the native call-activity pass-through). De-duplicated so a type that lands
   *  in more than one source (e.g. a worker mock mistakenly registered for a synthetic
   *  child-process jobType) is only activated once per drain pass. */
  #dispatchableJobTypes(): string[] {
    const types = new Set<string>(this.#workers.keys());
    for (const [jobType, mock] of this.#workerMocks) {
      if (!this.#workers.has(jobType) && mock.hasClauses) types.add(jobType);
    }
    for (const jobType of this.#childProcessJobTypes) {
      if (!this.#workers.has(jobType)) types.add(jobType);
    }
    return [...types];
  }

  /**
   * Resolve one synthetic call-activity job (epic #296, S3). If a {@link mockChildProcess} mock
   * is registered for the encoded called process id, apply its outcome via the shared
   * `applyOutcome` — completing the parent with the mocked variables merged, or failing/erroring
   * it — exactly like a real completion path (synchronous, no wall-clock, so the drain still
   * quiesces). With no mock, complete the job with no variables, reproducing the engine's native
   * call-activity pass-through. A throw from applying the outcome (e.g. a non-serializable
   * `completeWith` value) is routed through the same error→completion mapping as a real handler,
   * so it never escapes and aborts the whole drain.
   */
  #runChildProcessJob(jobType: string, raw: Record<string, unknown>): void {
    const jobKey = str(raw.key);
    if (jobKey === "") return;
    const processId = childProcessIdFromJobType(jobType);
    const outcome = this.#childProcessMocks.get(processId)?.resolve();
    try {
      if (outcome === undefined) {
        this.#engine.completeJob(jobKey, "{}");
      } else {
        applyOutcome(this.#engine, jobKey, outcome);
      }
    } catch (err) {
      this.#failFromError(raw, jobKey, err);
    }
  }

  async #runJob(
    worker: RegisteredWorker,
    hasRealWorker: boolean,
    raw: Record<string, unknown>,
  ): Promise<void> {
    const jobKey = str(raw.key);
    // A keyless job cannot be completed/failed/errored; skip it rather than
    // issue an invalid completeJob("") (mirrors the live SDK adapter, which
    // logs and leaves such a job for redelivery).
    if (jobKey === "") return;
    const jobType = str(raw.type);
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
    // Resolve any registered mock for this type against the constructed `EngineJob` (whose
    // `variables` already reflect any `fetchVariables` filtering applied above) BEFORE notifying the
    // coverage observer, so the observer learns whether this dispatch is mock-satisfied. A
    // mock whose `when(...)` clauses don't match yields `undefined` here and falls through to
    // the real handler below, exactly like an un-mocked type. Mock resolution is a pure lookup
    // over the in-memory registry — it introduces no timers/real-time, so `drain()` still
    // reaches a fixpoint deterministically.
    const mockOutcome = this.#workerMocks.get(jobType)?.resolve(job);
    // Will this dispatch actually be serviced? Only when a mock clause matched (`mockOutcome`) OR a
    // real handler exists to run it. A mock-only type whose clauses don't match is left locked with
    // nothing run (see below), so it is NOT serviced — and must not be recorded as exercised, or a
    // job no mock and no handler touched would fabricate coverage and hide a genuine gap.
    const willBeServiced = mockOutcome !== undefined || hasRealWorker;
    // Notify the coverage observer (if any) that a job of this type was dispatched — before the
    // handler runs (or the mock applies), so an exercised-but-failing worker, and a mocked type
    // whose real handler never runs, both still count as exercised. The `mocked` flag lets the
    // gate record the type as covered yet flag it as mock-satisfied. Gated on `willBeServiced` so
    // an unserviceable dispatch never fabricates coverage. Isolated in its own try/catch: this is a
    // non-invasive test seam, so a throwing observer must never abort the drain nor alter
    // job/engine semantics (it would otherwise propagate out of #runJob).
    if (this.#onJob !== undefined && willBeServiced) {
      try {
        this.#onJob(jobType, mockOutcome !== undefined);
      } catch {
        // Swallow: an observer is a passive spectator of dispatch, never a participant.
      }
    }
    // A matching mock shadows the real handler: apply its outcome via the shared applier — the
    // exact same engine completion calls the real path below uses — and return without running
    // (or even needing) the app's handler. `applyOutcome` runs the same engine calls a real
    // handler resolves through (notably `JSON.stringify(variables)` for a `complete` outcome),
    // so it can throw exactly like the real path's completion does; route that throw through the
    // same error-to-`failJob`/`throwError` handling rather than letting it escape `#runJob` and
    // abort the whole drain.
    if (mockOutcome !== undefined) {
      try {
        applyOutcome(this.#engine, jobKey, mockOutcome);
      } catch (err) {
        this.#failFromError(raw, jobKey, err);
      }
      return;
    }
    // Fell through the mock (no match / no clause). With no real worker registered for this type
    // there is nothing to run — the job was activated by a mock-only type. Leave it (locked for
    // this virtual instant) rather than fabricate a completion; the drain still quiesces because a
    // locked job won't re-activate. With a real worker, run it exactly as an un-mocked type.
    if (!hasRealWorker) return;
    try {
      const out = await worker.handler(job);
      this.#engine.completeJob(jobKey, JSON.stringify(out ?? {}));
    } catch (err) {
      this.#failFromError(raw, jobKey, err);
    }
  }

  /** Map a thrown handler/outcome error to the engine's completion surface — the single
   *  canonical error→completion mapping shared by the real-handler path and the mock-apply path.
   *  A {@link isBpmnError} throw raises a BPMN error (drives the modelled boundary); any other
   *  throw fails the job, decrementing its redelivery budget (`retries - 1`, floored at 0, so the
   *  last attempt raises an incident) exactly as the live SDK adapter does. */
  #failFromError(raw: Record<string, unknown>, jobKey: string, err: unknown): void {
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

function str(v: unknown): string {
  return v == null ? "" : String(v);
}

/** A trimmed identifier, or `undefined` when blank/whitespace-only — the shared presence rule
 *  the urban form contract (`resolveFormIdentifier`/`pickFormLinkage`) applies, so a blank
 *  `formKey`/`externalFormReference` is treated as absent rather than a present-but-empty value.
 *  Re-declared locally (not imported) because the kit depends only on urban's long-published
 *  public API — see the re-declaration note at the top of this file. */
function present(v: string | undefined): string | undefined {
  const t = v?.trim();
  return t ? t : undefined;
}

/** Presence-check a possibly-numeric form key under the shared trim rule — mirrors the urban
 *  form contract's `presentKey` (`packages/urban/src/runtime/core/form-contract.ts`). The
 *  read-model body may carry a `formKey` as a number, so coerce a *number* to a string; a string
 *  is taken as-is; **any other type is absent**. It deliberately never `String(...)`-coerces an
 *  arbitrary value, so a non-string (e.g. an object) can't leak in as a truthy `"[object Object]"`
 *  identifier. Re-declared locally (not imported) for the same long-published-API-floor reason as
 *  `present`/`str` above. Exported for the coercion-defect-class guard in the test suite. */
export function presentKey(v: unknown): string | undefined {
  if (typeof v === "number") return present(String(v));
  if (typeof v === "string") return present(v);
  return undefined;
}

/** Presence-check a string-only identifier (`externalFormReference`/`formId`) under the shared
 *  trim rule — mirrors the urban form contract, which treats these as present only when a string.
 *  A number or any other type is absent, and it never `String(...)`-coerces, so a non-string can't
 *  leak in as a garbage identifier. Exported for the coercion-defect-class guard in the tests. */
export function presentString(v: unknown): string | undefined {
  return typeof v === "string" ? present(v) : undefined;
}

/** Parse a form-js schema from a read-model `FormResult.schema`: the engine serializes it as a
 *  JSON string (the REST wire shape), but tolerate an already-parsed object too. Returns `null`
 *  when the value is neither, mirroring urban's `parseFormSchema`. */
function parseFormSchema(raw: unknown): Record<string, unknown> | null {
  if (isRecord(raw)) return raw;
  if (typeof raw !== "string") return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** Build the typed `getForm` result from an untyped read-model body (the `getFormByKey` JSON
 *  boundary). The `FormResult` DTO annotation on a `JSON.parse`d body is a shape *claim*, not a
 *  runtime guarantee, so guard the body with `isRecord` — which, unlike `typeof === "object"`,
 *  also excludes arrays — before reading its fields. A missing/invalid schema is treated as "no
 *  such form" (`null`). Identifier presence is type-aware (mirrors the shared form contract's
 *  `buildFormSchema`): a `formKey` counts only when a string/number, a `formId` only when a string,
 *  so a non-string value can never coerce into a garbage `"[object Object]"` identifier. The single
 *  source of truth `getForm` extracts through, so the boundary's tolerance cannot drift. */
export function parseForm(
  body: FormResult | null,
): { formKey?: string; formId?: string; version?: number; schema: Record<string, unknown> } | null {
  if (!isRecord(body)) return null;
  const schema = parseFormSchema(body.schema);
  if (!schema) return null;
  const formKey = presentKey(body.formKey);
  const formId = presentString(body.formId);
  return {
    ...(formKey ? { formKey } : {}),
    ...(formId ? { formId } : {}),
    ...(typeof body.version === "number" ? { version: body.version } : {}),
    schema,
  };
}
