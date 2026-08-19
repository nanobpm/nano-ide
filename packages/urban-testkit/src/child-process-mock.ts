// Child-process / call-activity mocking for the e2e test kit (epic #296, S3).
//
// Camunda's `CamundaProcessTestContext.mockChildProcess()` lets a parent process be
// tested without deploying/executing the *called* process behind a call activity. This
// module ports that to `@nanobpm/urban-testkit`: `app.mockChildProcess(processId)`
// returns a {@link MockChildProcessBuilder} whose `completeWith(vars)` / `failWith(...)`
// decide how the parent's call activity to `processId` resolves.
//
// ## Reuse, not duplication (AGENTS.md "Derivation Over Duplication")
// The outcome model is the SAME one the job-worker slice landed: this module imports the
// {@link MockOutcome} type from `./worker-mock.ts` rather than re-deriving a second copy, and the
// one canonical outcome applier (`applyOutcome`) is invoked in `WasmEngineClient` (see
// `WasmEngineClient.drain`). A child-process mock is just a call-activity job resolved through that
// same applier.
//
// ## Why the seam is a deploy-time rewrite (see `WasmEngineClient.deployResources`)
// The WASM `TestEngine` treats a BPMN call activity as an immediate pass-through: it never
// instantiates the called process, does not wait, and dispatches no job — so there is no
// runtime seam (unlike the `#runJob` job-dispatch seam job-worker mocks hook). To give the
// call activity real, mockable semantics, `deployResources` rewrites each call activity into
// a synthetic service-task job keyed by its called process id; `drain` resolves that job
// through this builder's outcome (or completes it through with no variables when unmocked,
// reproducing the engine's native pass-through). Because the synthetic job completes BEFORE
// the parent token continues, a `completeWith`'s variables are visible to everything
// downstream of the call activity (e.g. a gateway), and a `failWith` raises a real incident
// on the call-activity element — exactly the observable behaviour a real called process would
// produce.

import type { MockOutcome } from "./worker-mock.ts";

/**
 * A fluent builder describing how a mocked child process (a call activity's *called
 * process*, keyed by its process id) should resolve. Obtain one from
 * `app.mockChildProcess(processId)`.
 *
 * A child process resolves to a single outcome — unlike a job-worker mock there are no
 * per-job conditions, because a call activity to a given process id has one meaning in a
 * test. Setting an outcome is therefore **last-write-wins**: a later `completeWith` /
 * `failWith` replaces the earlier one. Both outcome methods return `this` for fluency.
 *
 * The outcome is expressed as the shared {@link MockOutcome} and applied through the shared
 * `applyOutcome`, so a mocked child process resolves through the exact same engine calls a
 * real completion/failure would — keeping the deterministic drain a fixpoint.
 */
export class MockChildProcessBuilder {
  #outcome: MockOutcome | undefined;
  #removed = false;
  readonly #remove: () => void;

  /** @param remove deregisters this builder from its owning registry (used by {@link reset}). */
  constructor(remove: () => void) {
    this.#remove = remove;
  }

  /**
   * Complete the child process, merging `vars` into the parent instance as the call
   * activity's output — the parent then continues past the call activity with `vars`
   * visible to everything downstream. Mirrors a called process completing and propagating
   * these variables back to the parent (the mock is explicit about which variables surface,
   * independent of the model's `propagateAllChildVariables` setting). Maps to a `complete`
   * {@link MockOutcome}.
   */
  completeWith(vars: Record<string, unknown>): this {
    this.#set({ kind: "complete", variables: vars });
    return this;
  }

  /**
   * Fail the child process, so the parent surfaces the failure at the call activity instead of
   * continuing: an incident is raised on the call-activity element (visible in
   * `snapshot().incidents[]`). Maps to a zero-retry `fail` {@link MockOutcome}.
   *
   * Unlike a job-worker `failWith`, a child-process failure has **no redelivery budget**: a call
   * activity is not a redelivered job, so there is deliberately no `retries` option — a failed
   * child process is an incident. (A positive retry budget would also re-activate the synthetic
   * call-activity job every drain pass and never quiesce.)
   */
  failWith(opts?: { message?: string }): this {
    this.#set({
      kind: "fail",
      retries: 0,
      message: opts?.message ?? "urban-testkit mock: child process failWith",
    });
    return this;
  }

  /**
   * Resolve the configured outcome, or `undefined` when none has been set (the call activity
   * then completes through with no variables — the engine's native pass-through). A reset
   * builder always resolves `undefined`.
   */
  resolve(): MockOutcome | undefined {
    return this.#outcome;
  }

  /** True once an outcome has been configured — a bare, unused builder is inert. */
  get hasOutcome(): boolean {
    return this.#outcome !== undefined;
  }

  /**
   * Remove this mock: drop the configured outcome and deregister from the owning engine, so
   * the mocked process id resumes the engine's native call-activity pass-through. Idempotent
   * — a second call is a no-op. After reset the builder is **tombstoned**: any further
   * `completeWith` / `failWith` throws, because an outcome set on a deregistered builder never
   * affects dispatch. Create a fresh mock via `app.mockChildProcess(id)` instead.
   */
  reset(): void {
    if (this.#removed) return;
    this.#outcome = undefined;
    this.#removed = true;
    this.#remove();
  }

  #set(outcome: MockOutcome): void {
    if (this.#removed) {
      throw new Error(
        "MockChildProcessBuilder has been reset() and is no longer registered. Create a fresh " +
          "mock via app.mockChildProcess(processId) instead of re-arming a removed builder — an " +
          "outcome set on a removed builder never affects dispatch.",
      );
    }
    this.#outcome = outcome;
  }
}

/** The prefix marking a synthetic job type minted for a rewritten call activity. Chosen to be
 *  vanishingly unlikely to collide with a real `zeebe:taskDefinition type`. */
const CHILD_PROCESS_JOB_PREFIX = "__urban-testkit:child-process__:";

/** The synthetic job type a call activity to `processId` is rewritten to (see
 *  {@link isChildProcessJobType} / {@link childProcessIdFromJobType} for the inverse). */
export function childProcessJobType(processId: string): string {
  return CHILD_PROCESS_JOB_PREFIX + processId;
}

/** Whether `jobType` is a synthetic child-process job type minted by the call-activity rewrite. */
export function isChildProcessJobType(jobType: string): boolean {
  return jobType.startsWith(CHILD_PROCESS_JOB_PREFIX);
}

/** The called process id encoded in a synthetic child-process job type (inverse of
 *  {@link childProcessJobType}). */
export function childProcessIdFromJobType(jobType: string): string {
  return jobType.slice(CHILD_PROCESS_JOB_PREFIX.length);
}

/**
 * Rewrite every BPMN call activity in `xml` into a synthetic service task whose
 * `zeebe:taskDefinition type` is {@link childProcessJobType}`(calledProcessId)`, preserving the
 * element's `id` (so incoming/outgoing sequence flows and attached boundary events still
 * resolve), every non-`extensionElements` child (e.g. `multiInstanceLoopCharacteristics`,
 * `incoming`/`outgoing`), and every *other* `extensionElements` child (e.g. `zeebe:ioMapping`,
 * `zeebe:taskHeaders`) — only the `zeebe:calledElement` is replaced by the synthetic
 * `taskDefinition`. Returns the rewritten XML plus the distinct called process ids found.
 *
 * The `WasmEngineClient` uses this at deploy time so a call activity becomes a job the drain can
 * resolve (through a child-process mock, or completing it through with no variables when
 * unmocked). A call activity without a resolvable `zeebe:calledElement processId` is left
 * untouched (nothing to key a mock on) — the engine's native pass-through still applies.
 *
 * The transform is intentionally conservative and string-based: it matches the `callActivity`
 * element (with or without a namespace prefix, self-closing or not) and rewrites only its tag
 * name and the `calledElement` inside its `extensionElements`, so the surrounding model is
 * preserved byte-for-byte.
 */
export function rewriteCallActivities(xml: string): { xml: string; calledProcessIds: string[] } {
  // Fast path: no call activity → return the input untouched (zero cost for the common case).
  if (!xml.includes("callActivity")) return { xml, calledProcessIds: [] };

  const calledProcessIds = new Set<string>();
  // Match an optional namespace prefix (e.g. `bpmn:`), then the whole element — either
  // self-closing (`<callActivity .../>`) or with a body (`<callActivity ...>…</callActivity>`).
  const element = /<([\w.-]+:)?callActivity\b([^>]*?)(\/>|>([\s\S]*?)<\/(?:[\w.-]+:)?callActivity>)/g;
  const rewritten = xml.replace(
    element,
    (whole, prefixRaw: string | undefined, attrs: string, tail: string, body: string | undefined) => {
      const processId = extractCalledProcessId(body ?? "");
      // No resolvable called process id ⇒ leave the call activity as-is (nothing to mock against).
      if (processId === undefined) return whole;
      calledProcessIds.add(processId);
      const prefix = prefixRaw ?? "";
      const taskDef = `<zeebe:taskDefinition type="${childProcessJobType(processId)}"/>`;
      // Remove only the `<zeebe:calledElement…/>` the synthetic taskDefinition replaces, then
      // inject the taskDefinition — preserving every other child of the call activity, including
      // any sibling extensionElements content (ioMapping, task headers, other engine extensions).
      const merged = injectTaskDefinition(stripCalledElement(body ?? ""), prefix, taskDef);
      return `<${prefix}serviceTask${attrs}>${merged}</${prefix}serviceTask>`;
    },
  );
  return { xml: rewritten, calledProcessIds: [...calledProcessIds] };
}

/** The `processId` of a `<zeebe:calledElement processId="…"/>` within a call activity body, or
 *  `undefined` when absent/blank. Accepts either quote style — XML attribute values may be single-
 *  or double-quoted, and a single-quoted `processId` must still key the child-process mock. */
function extractCalledProcessId(body: string): string | undefined {
  const m = /<(?:[\w.-]+:)?calledElement\b[^>]*?\bprocessId=(["'])([^"']*)\1/.exec(body);
  const id = m?.[2]?.trim();
  return id ? id : undefined;
}

/** Remove the `<zeebe:calledElement …>` element (self-closing or with a body) that the synthetic
 *  taskDefinition replaces, leaving every other child — including any other `extensionElements`
 *  content — in place. */
function stripCalledElement(body: string): string {
  return body
    .replace(/<(?:[\w.-]+:)?calledElement\b[^>]*?\/>/g, "")
    .replace(/<(?:[\w.-]+:)?calledElement\b[\s\S]*?<\/(?:[\w.-]+:)?calledElement>/g, "");
}

/** Inject the synthetic `<zeebe:taskDefinition/>` into a call-activity body, preserving existing
 *  extension content: into the first surviving `<extensionElements>` block (right after its opening
 *  tag, or by expanding a self-closing one), or — when none remains — a fresh prefixed
 *  `<extensionElements>` block prepended so it stays first in the element's children. */
function injectTaskDefinition(body: string, prefix: string, taskDef: string): string {
  const selfClosing = /<((?:[\w.-]+:)?extensionElements)\b[^>]*?\/>/;
  if (selfClosing.test(body)) {
    return body.replace(selfClosing, (_m, name: string) => `<${name}>${taskDef}</${name}>`);
  }
  const open = /<(?:[\w.-]+:)?extensionElements\b[^>]*?>/;
  if (open.test(body)) {
    return body.replace(open, (m: string) => `${m}${taskDef}`);
  }
  return `<${prefix}extensionElements>${taskDef}</${prefix}extensionElements>${body}`;
}
