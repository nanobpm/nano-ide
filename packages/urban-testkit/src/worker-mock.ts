// First-class job-worker mocking for the e2e test kit (epic #296, S1+S2+S4).
//
// This module owns the *shared* mock surface every mock slice builds on: the
// outcome model (`MockOutcome`) and the single canonical outcome applier
// (`applyOutcome`), plus the fluent `MockWorkerBuilder`. The later child-process
// slice (S3) reuses `MockOutcome` + `applyOutcome` verbatim rather than
// re-deriving a second copy — "derivation over duplication" (AGENTS.md).
//
// Why the outcome inventory is DERIVED, not hand-listed: the `WasmEngineClient`
// completes a job through exactly three engine calls in `#runJob` —
// `completeJob`, `failJob`, and `throwError` (see `@nanobpm/engine-wasm`
// `TestEngine`). `MockOutcome` therefore carries exactly one variant per engine
// completion method, and `applyOutcome`'s exhaustive `switch` maps each variant
// back to its method. Adding a new engine completion method surfaces here as a
// non-exhaustive switch (a compile error), so the mock layer can never silently
// omit an outcome the engine grew — that is what the S5 completeness guard keys
// on. An "incident" is NOT a fourth engine method: the engine raises an incident
// when a job fails with zero retries left, so `raiseIncident` is modelled as a
// zero-retry `fail` outcome (see `MockWorkerBuilder.raiseIncident`).

import type { EngineJob } from "@nanobpm/urban/runtime";

/**
 * A resolved worker outcome — a discriminated union with exactly one variant per
 * engine completion method (`completeJob` / `failJob` / `throwError`). Shared with
 * the child-process mock slice so both apply outcomes through the one
 * {@link applyOutcome} implementation.
 */
export type MockOutcome =
  /** Complete the job with these variables → `completeJob(jobKey, JSON.stringify(variables))`. */
  | { readonly kind: "complete"; readonly variables: Record<string, unknown> }
  /** Fail the job → `failJob(jobKey, retries, message)`. `retries: 0` raises an incident. */
  | { readonly kind: "fail"; readonly retries: number; readonly message: string }
  /** Raise a BPMN error → `throwError(jobKey, errorCode, message)` (drives the error boundary). */
  | { readonly kind: "throwError"; readonly errorCode: string; readonly message: string };

/**
 * The minimal engine surface {@link applyOutcome} needs — the three completion
 * methods a mocked job resolves through. `@nanobpm/engine-wasm`'s `TestEngine`
 * satisfies this structurally, so no cast is needed at the call site.
 */
export interface OutcomeEngine {
  completeJob(jobKey: string, variablesJson: string): unknown;
  failJob(jobKey: string, retries: number, message: string): unknown;
  throwError(jobKey: string, errorCode: string, errorMessage: string): unknown;
}

/**
 * Apply a resolved {@link MockOutcome} against the engine for `jobKey` — the single
 * canonical mapping from an outcome variant to its engine completion call. Mirrors
 * the real completion path in `WasmEngineClient.#runJob` exactly (synchronous, no
 * wall-clock), so a mocked job leaves the engine in the same shape a real handler
 * would and the deterministic drain still reaches a fixpoint.
 *
 * The `switch` is exhaustive over `MockOutcome["kind"]`: a new engine completion
 * method (hence a new outcome variant) makes this fail to compile until it is
 * handled here — the derivation seam the S5 completeness guard relies on.
 */
export function applyOutcome(engine: OutcomeEngine, jobKey: string, outcome: MockOutcome): void {
  switch (outcome.kind) {
    case "complete":
      engine.completeJob(jobKey, JSON.stringify(outcome.variables));
      return;
    case "fail":
      engine.failJob(jobKey, outcome.retries, outcome.message);
      return;
    case "throwError":
      engine.throwError(jobKey, outcome.errorCode, outcome.message);
      return;
    default: {
      // Exhaustiveness guard: `outcome` is `never` here iff every `MockOutcome` variant is
      // handled above. A new engine completion method (hence a new variant) makes this branch
      // reachable and fails to compile until it is handled — the derivation seam the S5
      // completeness guard relies on. The runtime throw is the belt-and-braces backstop so a
      // malformed outcome that slips past the type system fails loudly instead of silently
      // dropping the job.
      const _exhaustive: never = outcome;
      throw new Error(`unhandled mock outcome: ${JSON.stringify(_exhaustive)}`);
    }
  }
}

/** A pure, synchronous predicate over an {@link EngineJob} used by {@link MockWorkerBuilder.when}. */
export type JobPredicate = (job: EngineJob) => boolean;

/**
 * Clamp a caller-supplied `failWith` retry count to a finite, non-negative integer — the only
 * shape the engine's `failJob(jobKey, retries, …)` is defined for. `retries` is typed `number`, so
 * a test can pass a negative value, a fraction, `NaN`, or `Infinity`; each of those would give the
 * engine an ill-defined redelivery budget. `undefined` (the default) and any non-finite input map
 * to `0` (fail immediately → incident); a valid value is floored to a non-negative integer.
 */
function clampRetries(retries: number | undefined): number {
  if (retries === undefined || !Number.isFinite(retries)) return 0;
  return Math.max(0, Math.trunc(retries));
}

/** One conditional clause: an outcome, guarded by an optional predicate (absent ⇒ unconditional). */
interface MockClause {
  readonly predicate: JobPredicate | undefined;
  readonly outcome: MockOutcome;
}

/**
 * A fluent builder describing how a mocked `taskType` (or, for the child-process
 * slice, a called process) should resolve. Obtain one from `app.mockWorker(type)`.
 *
 * ## Conditions and ordering
 * A builder holds an ordered list of clauses. `when(predicate)` arms a guard for the
 * NEXT outcome; an outcome method with no preceding `when` is an unconditional
 * default. On each dispatch the clauses are evaluated in **registration order,
 * first match wins**: the first clause whose predicate is absent or returns `true`
 * for the job supplies the outcome. If **no** clause matches, {@link resolve}
 * returns `undefined` and the dispatch falls through to the next mock rule or, if
 * none, to the real handler. Because an unconditional clause matches every job, any
 * clause registered after it is unreachable.
 *
 * All outcome methods and `when` return `this`, so a guard chains before its
 * outcome, e.g. `mock.when(j => j.variables.vip === true).completeWith({ fast: true })`.
 */
export class MockWorkerBuilder {
  readonly #clauses: MockClause[] = [];
  #pendingPredicate: JobPredicate | undefined;
  readonly #remove: () => void;

  /** @param remove deregisters this builder from its owning registry (used by {@link reset}). */
  constructor(remove: () => void) {
    this.#remove = remove;
  }

  /**
   * Arm a predicate for the NEXT outcome added to this builder. Predicates must be
   * pure and synchronous over the {@link EngineJob} (its `jobType`, `variables`,
   * `elementId`, keys) — they are evaluated on every matching dispatch under the
   * virtual clock, so a side-effecting or async predicate would break determinism.
   * Evaluated in registration order, first match wins (see class docs).
   */
  when(predicate: JobPredicate): this {
    this.#pendingPredicate = predicate;
    return this;
  }

  /** Complete the job with `vars` (mirrors the engine's `completeJob`). */
  completeWith(vars: Record<string, unknown>): this {
    return this.#add({ kind: "complete", variables: vars });
  }

  /**
   * Fail the job. Defaults to `retries: 0`, which raises an incident (matching the
   * `failWith({ retries: 0 })` sketch); pass a positive `retries` to fail with
   * redelivery budget instead. Maps to the engine's `failJob`.
   */
  failWith(opts?: { retries?: number; message?: string }): this {
    return this.#add({
      kind: "fail",
      retries: clampRetries(opts?.retries),
      message: opts?.message ?? "urban-testkit mock: failWith",
    });
  }

  /**
   * Throw a BPMN error, driving the modelled error-boundary flow — maps to the
   * engine's `throwError`. `message` defaults to `code`.
   */
  throwBpmnError(code: string, message?: string): this {
    return this.#add({ kind: "throwError", errorCode: code, message: message ?? code });
  }

  /**
   * Raise an incident visible in the engine snapshot (`snapshot().incidents[]`).
   * The engine has no dedicated "raise incident" call; it raises one when a job
   * fails with zero retries left, so this is a zero-retry `failJob` carrying the
   * given message — the most direct path on the `TestEngine` surface.
   */
  raiseIncident(opts?: { message?: string }): this {
    return this.#add({
      kind: "fail",
      retries: 0,
      message: opts?.message ?? "urban-testkit mock: raiseIncident",
    });
  }

  /**
   * Resolve the outcome for `job`, or `undefined` when no clause matches (the
   * dispatch then falls through to the real handler). First-match-wins over the
   * clauses in registration order.
   */
  resolve(job: EngineJob): MockOutcome | undefined {
    for (const clause of this.#clauses) {
      if (clause.predicate === undefined || clause.predicate(job)) return clause.outcome;
    }
    return undefined;
  }

  /** True once at least one clause has been added — a bare, unused builder is inert. */
  get hasClauses(): boolean {
    return this.#clauses.length > 0;
  }

  /**
   * Remove this mock entirely: drop every clause and deregister from the owning
   * engine so the mocked type resumes running its real handler.
   */
  reset(): void {
    this.#clauses.length = 0;
    this.#pendingPredicate = undefined;
    this.#remove();
  }

  #add(outcome: MockOutcome): this {
    this.#clauses.push({ predicate: this.#pendingPredicate, outcome });
    this.#pendingPredicate = undefined;
    return this;
  }
}
