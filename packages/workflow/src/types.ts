// Public types for @nanobpm/workflow.

import type { Envelope } from "./envelope.js";

/** A JSON-serialisable value, as carried by process variables. */
export type Json = null | boolean | number | string | Json[] | { [k: string]: Json };
export type JsonObject = { [k: string]: Json };

/** A job as delivered by the nanobpmn gateway's `POST /v2/jobs/activation`. The
 *  `variables` type parameter carries the input envelope's inferred payload when
 *  a step is declared with a typed envelope; it defaults to the untyped
 *  `JsonObject`. */
export interface Job<V extends JsonObject = JsonObject> {
  jobKey: string;
  processInstanceKey: string;
  elementId: string;
  type: string;
  variables: V;
}

// --- Declarative surface (Strategy A: compile a step tree to a BPMN model) ----
//
// A flow is a TREE of nodes, not a flat list: leaf activities (`run`/`task`/
// `signal`) plus structural combinators (`switch`/`branch`/`loop` — XOR gateways
// + back-edges — and `parallel`/`forEach` — parallel gateways + multi-instance)
// that compile to real BPMN the engine runs. See declarative.ts for the compiler.

/** The input/output data envelopes lifted onto an activity node. */
export interface NodeEnvelopes {
  in?: Envelope;
  out?: Envelope;
}

/** A typed I/O contract for one step: its input and/or output data envelope.
 *  For a `signal`, `in` types the message payload. */
export interface StepContract {
  in?: Envelope;
  out?: Envelope;
}

/** A flow's typed I/O registry, keyed by step name — the single source of truth
 *  for each step's envelopes. Passed to `defineFlow`; a step whose name is a key
 *  is typed (and its envelopes lifted to the model), others fall back to the
 *  untyped `JsonObject`. */
export type FlowContracts = Record<string, StepContract>;

/** Handler for a declarative `run` step: does real work, returns variables. */
export type StepHandler<
  V extends JsonObject = JsonObject,
  R extends JsonObject = JsonObject,
> = {
  bivarianceHack(job: Job<V>): Promise<R | void> | R | void;
}["bivarianceHack"];

/** The OPEN registry of flow-node kinds — the single extension seam for the
 *  `FlowNode` union (epic #314, S0/#315). Each kind module under `src/nodes/`
 *  declaration-merges ONE property into this interface (`kindName: NodeShape`),
 *  so `FlowNode` grows without editing a central union here. The built-in kinds
 *  register `run`/`task`/`signal`/`timer`/`switch`/`branch`/`loop`/`break`/
 *  `continue`/`parallel`/`forEach` from their own modules through this same
 *  mechanism — see `src/nodes/README.md`.
 *
 *  Invariant: every value type MUST be an object with a `kind` discriminant
 *  equal to its key, so `FlowNode` stays a discriminated union.
 *
 *  This interface is intentionally empty here: it is the augmentation target the
 *  per-kind modules declaration-merge their variant into. */
export interface FlowNodeRegistry {}

/** A node in a declarative flow tree, derived from the {@link FlowNodeRegistry}.
 *  Leaf activities carry optional data envelopes (lifted to `nano:shape` +
 *  `dataEnvelope` in the model); structural combinators carry nested
 *  `FlowNode[]` bodies. */
export type FlowNode = FlowNodeRegistry[keyof FlowNodeRegistry];

/** A timer intermediate-catch definition: exactly one of `after` (an ISO-8601
 *  delay or FEEL expression) or `at` (an absolute instant or FEEL expression).
 *  Encoded as an XOR so downstream consumers can rely on exactly-one. */
export type TimerAt =
  | { after: string; at?: never }
  | { at: string; after?: never };

/** A flow's start-timer: the plain none start event becomes a durable timer
 *  start the engine fires on schedule. Exactly one of:
 *  - `cycle` — a recurring ISO-8601 interval (`R/PT1H`, `R5/PT30M`) or bare
 *    duration; the engine re-fires on each period. This is the model-native,
 *    durable, single-fire-per-cluster replacement for an app-side cron.
 *  - `after` — a one-shot ISO-8601 delay (`PT10S`) measured from deployment.
 *  - `at`    — a one-shot absolute instant (an ISO-8601 date-time, or a FEEL
 *    `=` expression).
 *  Encoded as an XOR so the exactly-one invariant holds at the type level. */
export type TimerStart =
  | { cycle: string; after?: never; at?: never }
  | { after: string; cycle?: never; at?: never }
  | { at: string; cycle?: never; after?: never };

/** One case of a `switch`: routed when `subject = value` (FEEL equality). */
export interface SwitchCase {
  value: string;
  body: FlowNode[];
}

/** @deprecated Renamed to {@link FlowNode} now that a flow is a tree of nodes,
 *  not a flat list of steps. Kept as an alias for source compatibility. */
export type DeclarativeStep = FlowNode;

export interface DeclarativeFlow {
  kind: "declarative";
  id: string;
  /** The flow's node tree (top-level sequence). */
  steps: FlowNode[];
  handlers: Record<string, StepHandler>;
  /** When set, the flow's start event is a durable timer start (see
   *  {@link TimerStart}) rather than a plain none start. */
  startTimer?: TimerStart;
}

// --- Imperative surface (Strategy B: a replayed orchestration function) -------

/** The context passed to an imperative orchestration function. */
export interface WorkflowContext {
  /** The workflow's start input (immutable across replays). */
  readonly input: JsonObject;
  /**
   * A durable activity. On first execution the handler runs (its side effects
   * happen once); on every subsequent replay the recorded result is returned
   * WITHOUT invoking the handler. The handler is the only place side effects
   * (I/O, network, shell, LLM) are allowed — the orchestration body itself must
   * be deterministic.
   */
  run<T extends Json = Json>(name: string, fn: () => Promise<T> | T): Promise<T>;
}

export type Orchestration = (ctx: WorkflowContext) => Promise<void>;

export interface ImperativeWorkflow {
  kind: "imperative";
  id: string;
  orchestrate: Orchestration;
  /** Derived job type of the single orchestrator task: `<id>:__orchestrate`. */
  orchestrateType: string;
}

export type Workflow = DeclarativeFlow | ImperativeWorkflow;

/** Result of deploying a workflow. */
export interface DeployResult {
  [k: string]: Json;
}

/** Result of starting a workflow instance. */
export interface StartResult {
  processInstanceKey?: string;
  [k: string]: Json | undefined;
}
