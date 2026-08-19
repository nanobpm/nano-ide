// Strategy A — the declarative surface: a TREE of nodes compiled to a real BPMN
// model. Leaf activities (`run`/`task`/`signal`) plus structural combinators
// (`switch`/`branch`/`loop`) that compile to exclusive gateways + back-edges the
// engine already runs (engine-core supports XOR gateways with in-order condition
// evaluation and a default flow, and tasks with multiple incoming flows act as
// an implicit XOR merge), plus concurrency combinators — `parallel` (an AND
// fork/join over parallel gateways) and `forEach` (a data-driven fan-out lowering
// to a parallel/sequential multi-instance activity or sub-process).
//
//   const convergence = defineFlow(
//     "convergence-loop",
//     {                                             // contracts keyed by step name
//       "review-round": { in: PrReviewRoundIn, out: PrReviewRoundOut },
//       "persist-round": { out: RoundState },
//       "wait-review":  { in: ReviewReady },
//       "wait-answer":  { in: EscalationAnswered },
//     },
//     (w) => {
//       w.loop((b) => {
//         b.run("review-round", reviewRound);       // job.variables typed from the contract
//         b.switch("status", {
//           converged: (c) => { c.run("persist-converged", finalize); c.break(); },
//           addressed: (c) => c.branch("round >= maxRounds", {
//             then: (g) => { g.run("persist-escalation-maxrounds", persistEsc);
//                            g.signal("wait-answer", { correlationKey: "prKey" }); },
//             else: (g) => { g.run("persist-round", persistRound);   // returns { round: round + 1 }
//                            g.signal("wait-review", { correlationKey: "prKey" }); },
//           }),
//           default: (c) => { c.run("persist-escalation", persistEsc);
//                             c.signal("wait-answer", { correlationKey: "prKey" }); },
//         });
//       });
//     },
//   );
//
// Typed data envelopes are LIFTED into the model (nano:shape + dataEnvelope
// zeebe:property), so the generated .bpmn is ejectable to model-first with its
// typed contracts intact.

import type {
  DeclarativeFlow,
  FlowContracts,
  FlowNode,
  JsonObject,
  NodeEnvelopes,
  StepContract,
  StepHandler,
  TimerStart,
} from "./types.js";
import type { Envelope, EnvelopeField } from "./envelope.js";
import { assertIdent, assertTimerCycle, assertTimerDate, assertTimerDuration, escapeXml, jobType, messageName } from "./xml.js";
import { eachNodeKind, requireNodeKind } from "./nodes/registry.js";
// Import the generated barrel purely for its registration side effects: every
// built-in (and slice-added) kind module registers its FlowNode variant, builder
// method, and walk/emit handlers at import time. MUST run before `makeBuilder`
// or the `Compiler` dispatch through the registry.
import "./nodes/index.js";

// --- Authoring surface -------------------------------------------------------

/** The TS payload type of a contract's input envelope (untyped fallback). */
export type InPayload<Ct> = Ct extends { in: Envelope } ? Ct["in"]["type"] & JsonObject : JsonObject;
/** The TS payload type of a contract's output envelope (untyped fallback). */
export type OutPayload<Ct> = Ct extends { out: Envelope } ? Ct["out"]["type"] & JsonObject : JsonObject;
/** The input payload type of step `K` under contracts `C`. */
export type VarsOf<C, K extends string> = K extends keyof C ? InPayload<C[K]> : JsonObject;
/** The output payload type of step `K` under contracts `C`. */
export type ResultOf<C, K extends string> = K extends keyof C ? OutPayload<C[K]> : JsonObject;

/** A typed handler for a `run` step: its job variables and result are resolved
 *  from the flow contracts by the step name. */
export type TypedHandler<V extends JsonObject, R extends JsonObject> = (job: {
  jobKey: string;
  processInstanceKey: string;
  elementId: string;
  type: string;
  variables: V;
}) => Promise<R | void> | R | void;

/** A block: the callback that populates a nested body (a case, arm, or loop). */
export type Block<C extends object = object> = (b: FlowBuilder<C>) => void;

/** The typed builder for a flow body.
 *
 * `C` is the flow's contracts map (step name → `{ in, out }` envelopes). The
 * default is `object`, NOT `Record<string, never>`: with a `never`-valued record
 * `keyof C` is `string`, so `VarsOf`/`ResultOf` route EVERY step name into
 * `InPayload<never>`/`OutPayload<never>`, which distribute over `never` to
 * `never` — typing an untyped flow's `job.variables` as `never` and forcing its
 * handler return to `void` (so no untyped flow that returns data compiles). With
 * `object`, `keyof C` is `never`, so every step falls back to the intended
 * `JsonObject`. The public `defineFlow<C extends FlowContracts>` overload keeps
 * the stricter contracts constraint; this is only the untyped-builder default. */
export interface FlowBuilder<C extends object = object> {
  /**
   * A durable activity served by a worker THIS program hosts (a BPMN service
   * task; the handler runs in the in-process `Worker`). If `name` is a key in
   * the flow's contracts, the handler's job variables and return value are typed
   * from that contract's `in`/`out` envelopes; otherwise they are `JsonObject`.
   */
  run<K extends string>(name: K, handler: TypedHandler<VarsOf<C, K>, ResultOf<C, K>>): FlowBuilder<C>;
  /**
   * A durable activity served by a worker OUTSIDE this program (a BPMN service
   * task, but no locally-hosted handler). Its job type defaults to the derived
   * `${flowId}:${name}`; pass `{ jobType }` to override it with an explicit
   * worker token (e.g. a `rank:capability` token like `senior:pr-review` that a
   * `c8ctl nano work` matrix subscribes to) so an existing pool of agents can
   * service it without renaming the flow. The step name stays the BPMN element
   * id; only the emitted `zeebe:taskDefinition` type changes. Use
   * `externalJobTypes(flow)` to list the (possibly overridden) types those
   * workers must poll. Its contract envelopes (if any) type the model, not a
   * local handler.
   */
  task<K extends string>(name: K, opts?: { jobType?: string }): FlowBuilder<C>;
  /**
   * A durable wait for an external/human event, correlated on a process
   * variable (a BPMN message intermediate catch event). Resume it with
   * `WorkflowClient.signal(flow, name, correlationKeyValue, vars)`. The message
   * payload envelope, if any, comes from the contract's `in`.
   */
  signal<K extends string>(name: K, opts: { correlationKey: string }): FlowBuilder<C>;
  /**
   * A durable wait for a point in time (a BPMN timer intermediate catch event).
   * Pass exactly one of `{ after }` — an ISO-8601 delay (`PT1M30S`, `P1DT6H`) or
   * FEEL `=`-expression measured from when the token arrives — or `{ at }` — an
   * absolute ISO-8601 instant (or FEEL expression). The engine holds the token
   * durably until the timer fires, then continues. Use it for in-flow delays and
   * scheduled continuations (e.g. "wait 24h, then re-poll").
   */
  timer<K extends string>(name: K, opts: { after: string } | { at: string }): FlowBuilder<C>;
  /**
   * Make this flow's start event a durable TIMER start rather than an explicit
   * `client.start(...)`. Must be the first statement, at the top level. Pass
   * exactly one of `{ cycle }` — a recurring ISO-8601 interval (`R/PT1H`,
   * `R5/PT30M`) the engine re-fires each period — `{ after }` — a one-shot delay
   * from deployment — or `{ at }` — a one-shot absolute instant. A `cycle` start
   * is the model-native, durable, single-fire-per-cluster replacement for an
   * app-side cron: the schedule lives in the deployable model, and the engine
   * (not each app replica) owns firing it exactly once.
   */
  startOn(spec: { cycle: string } | { after: string } | { at: string }): FlowBuilder<C>;
  /**
   * A multi-way exclusive choice (a BPMN exclusive gateway). `subject` is a FEEL
   * expression (usually a variable name); each case routes when `subject` equals
   * the case value. An optional `default` case is the unconditional fallback.
   */
  switch(subject: string, cases: Record<string, Block<C>> & { default?: Block<C> }): FlowBuilder<C>;
  /**
   * A two-way exclusive choice on a FEEL boolean `condition` (a BPMN exclusive
   * gateway). The `then` branch is guarded by the condition; the `else` branch
   * (the gateway default) runs otherwise. Omitting `else` skips to whatever
   * follows the branch when the condition is false.
   */
  branch(condition: string, arms: { then: Block<C>; else?: Block<C> }): FlowBuilder<C>;
  /**
   * A durable loop (a back-edge to the loop head). The body runs, then control
   * returns to the top of the loop unless a branch calls `break()`. Nodes after
   * the loop run once `break()` is reached.
   */
  loop(body: Block<C>): FlowBuilder<C>;
  /**
   * A static parallel fork/join (a pair of BPMN parallel gateways). Every block
   * runs concurrently on its own branch; control continues past `parallel` only
   * once ALL branches have reached the joining gateway (AND-join). Pass at least
   * two branch blocks. Unlike `switch`/`branch` (exclusive choice), no branch is
   * conditional — all of them run.
   */
  parallel(branches: Block<C>[]): FlowBuilder<C>;
  /**
   * A data-driven fan-out over a runtime collection (a BPMN parallel
   * multi-instance activity). `collection` is a FEEL expression (no leading `=`)
   * evaluating to a list; one child instance of `body` runs per item, with the
   * item bound to the `itemVar` variable in the child's scope. A single-activity
   * body attaches the multi-instance characteristics to that activity; a
   * multi-step body is wrapped in an embedded multi-instance sub-process. Options:
   *  - `sequential` — run children one at a time (a sequential MI) instead of all
   *    at once (the default: a parallel MI).
   *  - `outputCollection` / `outputElement` — collect each child's `outputElement`
   *    (a FEEL expression, no leading `=`) into the `outputCollection` list
   *    variable, in item order.
   *  - `completionCondition` — a FEEL boolean (no leading `=`); when it holds
   *    after a child completes, the remaining children are cancelled and the body
   *    completes early.
   */
  forEach(
    collection: string,
    itemVar: string,
    body: Block<C>,
    opts?: {
      sequential?: boolean;
      outputCollection?: string;
      outputElement?: string;
      completionCondition?: string;
    },
  ): FlowBuilder<C>;
  /** Exit the enclosing loop (routes to whatever follows it). Only valid inside
   *  a `loop`. */
  break(): FlowBuilder<C>;
  /** Jump straight back to the top of the enclosing loop, skipping the rest of
   *  the body. Only valid inside a `loop`. */
  continue(): FlowBuilder<C>;
}

interface BuilderCtx {
  contracts: FlowContracts;
  handlers: Record<string, StepHandler>;
  seen: Set<string>;
  loopDepth: number;
  /** Set by `startOn()` (root builder only); lifted onto the flow. */
  startTimer?: TimerStart;
}

/** Ids the emitter generates for structural nodes / flows / messages. A step
 *  name that collides with one of these would produce a duplicate BPMN id and an
 *  invalid model, so reject them at authoring time. */
const RESERVED_PREFIXES = /^(Gw_|Loop_|Sub_|Msg_|f_)/;
const TIMER_START_KEYS = ["cycle", "after", "at"] as const;

function timerStartValue(
  spec: { cycle: string } | { after: string } | { at: string },
  key: (typeof TIMER_START_KEYS)[number],
): string | undefined {
  switch (key) {
    case "cycle":
      return "cycle" in spec ? spec.cycle : undefined;
    case "after":
      return "after" in spec ? spec.after : undefined;
    case "at":
      return "at" in spec ? spec.at : undefined;
  }
}

function claimName(ctx: BuilderCtx, id: string, name: string): void {
  assertIdent("step name", name);
  if (name === "Start" || name === "End" || name === id) {
    throw new Error(`step name "${name}" is reserved (collides with a generated BPMN id) in flow "${id}"`);
  }
  if (RESERVED_PREFIXES.test(name)) {
    throw new Error(
      `step name "${name}" uses a reserved prefix (Gw_/Loop_/Sub_/Msg_/f_ are generated ids) in flow "${id}"`,
    );
  }
  if (ctx.seen.has(name)) throw new Error(`duplicate step name "${name}" in flow "${id}"`);
  ctx.seen.add(name);
}

/** Resolve a step's declared envelopes from the flow contracts. */
function contractEnvelopes(ctx: BuilderCtx, name: string): { in?: Envelope; out?: Envelope } | undefined {
  const c: StepContract | undefined = ctx.contracts[name];
  if (!c || (!c.in && !c.out)) return undefined;
  return { in: c.in, out: c.out };
}

/** A builder method as stored on the dynamically-assembled builder. Its precise,
 *  generic user-facing signature comes from the `FlowBuilder<C>` interface (a
 *  built-in method declared centrally, a slice method declaration-merged from
 *  its module); this loose shape is only what the registry stores/installs. */
export type BuilderMethod = (...args: never[]) => unknown;

/** The per-body authoring context a kind module's `build` factory closes over to
 *  implement its builder method. Everything a method needs to append its node —
 *  claim its step name, resolve contract envelopes, recurse into nested bodies,
 *  and return the builder for chaining — without reaching into `declarative.ts`
 *  internals or the shared `FlowNode` union. */
export interface BuildApi {
  /** The flow id (for error messages). */
  readonly id: string;
  /** Whether this is the root (top-level) builder — e.g. `startOn` is root-only. */
  readonly isRoot: boolean;
  /** The node list this builder appends to (`api.out.push(node)`). */
  readonly out: FlowNode[];
  /** The flow's typed I/O contracts, keyed by step name. */
  readonly contracts: FlowContracts;
  /** The flow's handler registry — a `run`-like kind registers its handler here. */
  readonly handlers: Record<string, StepHandler>;
  /** The current loop-nesting depth (0 outside any loop) — `break`/`continue`
   *  guard on it. */
  readonly loopDepth: number;
  /** The builder itself, for chaining (`return api.self()`). */
  self(): FlowBuilder;
  /** Populate a nested body block, returning its node list. `inLoop` deepens the
   *  loop nesting (a `loop` body); use it for bodies that can `break`/`continue`. */
  child(fn: (b: FlowBuilder) => void, inLoop: boolean): FlowNode[];
  /** Populate a nested body that runs in its OWN token scope (an embedded
   *  sub-process): `break`/`continue` cannot cross the boundary (loop depth 0). */
  childScoped(fn: (b: FlowBuilder) => void): FlowNode[];
  /** Claim a step name (rejects duplicates / reserved ids), as every leaf does. */
  claim(name: string): void;
  /** Resolve the declared envelopes for a step name from the contracts. */
  contractEnvelopes(name: string): { in?: Envelope; out?: Envelope } | undefined;
  /** Lift a durable timer start onto the flow (used only by `startOn`). */
  setStartTimer(t: TimerStart): void;
}

/** Build a FlowBuilder that appends its nodes to `out`, sharing the flow-wide
 *  `ctx` (contracts, handler registry, name set, loop nesting). Structural
 *  combinators recurse with a fresh `out` array for each nested body. */
function makeBuilder<C extends object>(
  id: string,
  out: FlowNode[],
  ctx: BuilderCtx,
  isRoot = false,
): FlowBuilder<C> {
  const child = (fn: (b: FlowBuilder) => void, inLoop: boolean): FlowNode[] => {
    const body: FlowNode[] = [];
    const depth = inLoop ? ctx.loopDepth + 1 : ctx.loopDepth;
    fn(makeBuilder(id, body, { ...ctx, loopDepth: depth }));
    return body;
  };
  // A body that runs in its OWN token scope (an embedded sub-process): the
  // enclosing loop is not reachable across the scope boundary, so `break`/
  // `continue` inside it are rejected (loopDepth resets to 0). A `loop` declared
  // INSIDE the body still works — it creates its own scope.
  const childScoped = (fn: (b: FlowBuilder) => void): FlowNode[] => {
    const body: FlowNode[] = [];
    fn(makeBuilder(id, body, { ...ctx, loopDepth: 0 }));
    return body;
  };
  const setStartTimer = (t: TimerStart): void => {
    if (!isRoot) {
      throw new Error(`startOn() is only valid at the top level of flow "${id}" (not inside switch/branch/loop)`);
    }
    if (out.length !== 0) throw new Error(`startOn() must be the first statement in flow "${id}"`);
    if (ctx.startTimer) throw new Error(`startOn() may be called only once in flow "${id}"`);
    ctx.startTimer = t;
  };

  let builderRef: FlowBuilder | undefined;
  const api: BuildApi = {
    id,
    isRoot,
    out,
    contracts: ctx.contracts,
    handlers: ctx.handlers,
    get loopDepth() {
      return ctx.loopDepth;
    },
    self() {
      if (!builderRef) throw new Error("internal: builder method invoked before assembly");
      return builderRef;
    },
    child,
    childScoped,
    claim(name) {
      claimName(ctx, id, name);
    },
    contractEnvelopes(name) {
      return contractEnvelopes(ctx, name);
    },
    setStartTimer,
  };

  // `startOn` is not a node KIND — it lifts a timer onto the start event and
  // emits no `FlowNode` — so it is installed centrally. Every actual node kind's
  // builder method is contributed by its own module through the registry.
  const methods: Record<string, BuilderMethod> = { startOn: startOnMethod(api) };
  for (const [kind, handlers] of eachNodeKind()) {
    if (!handlers.build) continue;
    const method = handlers.builderMethod ?? kind;
    if (method in methods) {
      throw new Error(`two flow-node kinds both contribute the builder method "${method}"`);
    }
    methods[method] = handlers.build(api);
  }

  if (!isFlowBuilder(methods)) {
    throw new Error("internal: assembled FlowBuilder is missing registered methods");
  }
  // `methods` is now the untyped `FlowBuilder` (object) stored for `api.self()`;
  // a chaining method's precise return type is the interface's, not this value's.
  builderRef = methods;
  if (!isFlowBuilder<C>(methods)) {
    throw new Error("internal: assembled FlowBuilder is missing registered methods");
  }
  return methods;
}

/** A dynamically-assembled builder satisfies `FlowBuilder<C>` once every
 *  registered kind has installed its method and `startOn` is present. The check
 *  is a runtime type guard (not an `as` cast): each own-property must be a
 *  function, and `startOn` — the one non-registry method — must be present. */
function isFlowBuilder<C extends object = object>(x: object): x is FlowBuilder<C> {
  if (typeof Reflect.get(x, "startOn") !== "function") return false;
  return Object.getOwnPropertyNames(x).every((k) => typeof Reflect.get(x, k) === "function");
}

/** The central `startOn` builder method (not a node kind). */
function startOnMethod(api: BuildApi): BuilderMethod {
  return (spec: { cycle: string } | { after: string } | { at: string }) => {
    const setCount = TIMER_START_KEYS.filter((key) => typeof timerStartValue(spec, key) === "string").length;
    if (setCount !== 1) {
      throw new Error(`startOn() needs exactly one of { cycle }, { after }, or { at } in flow "${api.id}"`);
    }
    if ("cycle" in spec) {
      const cycle = spec.cycle.trim();
      assertTimerCycle(`startOn cycle`, cycle);
      api.setStartTimer({ cycle });
    } else if ("after" in spec) {
      const after = spec.after.trim();
      assertTimerDuration(`startOn after`, after);
      api.setStartTimer({ after });
    } else {
      const at = spec.at.trim();
      assertTimerDate(`startOn at`, at);
      api.setStartTimer({ at });
    }
    return api.self();
  };
}

/**
 * Define a declarative flow. Pass a typed `contracts` map (keyed by step name)
 * to type each step's I/O and lift its data envelopes into the model; or omit it
 * for an untyped flow. `build(w)` declares a tree of nodes.
 */
export function defineFlow<C extends FlowContracts>(
  id: string,
  contracts: C,
  build: (w: FlowBuilder<C>) => void,
): DeclarativeFlow;
export function defineFlow(id: string, build: (w: FlowBuilder) => void): DeclarativeFlow;
export function defineFlow(
  id: string,
  second: FlowContracts | ((w: FlowBuilder) => void),
  third?: (w: FlowBuilder<FlowContracts>) => void,
): DeclarativeFlow {
  assertIdent("workflow id", id);
  if (typeof second !== "function" && (second === null || typeof second !== "object")) {
    throw new Error(`defineFlow("${id}"): the contracts argument must be an object`);
  }
  const contracts: FlowContracts = typeof second === "function" ? {} : second;
  if (typeof second !== "function" && typeof third !== "function") {
    throw new Error(`defineFlow("${id}"): a build callback (w) => {…} is required`);
  }
  const steps: FlowNode[] = [];
  const handlers: Record<string, StepHandler> = {};
  const ctx: BuilderCtx = { contracts, handlers, seen: new Set(), loopDepth: 0 };
  if (typeof second === "function") {
    second(makeBuilder(id, steps, ctx, true));
  } else {
    const build = third;
    if (typeof build !== "function") {
      throw new Error(`defineFlow("${id}"): a build callback (w) => {…} is required`);
    }
    build(makeBuilder<FlowContracts>(id, steps, ctx, true));
  }
  if (steps.length === 0) throw new Error(`flow "${id}" declared no steps`);
  const flow: DeclarativeFlow = { kind: "declarative", id, steps, handlers };
  if (ctx.startTimer) flow.startTimer = ctx.startTimer;
  return flow;
}

// --- Tree walkers ------------------------------------------------------------

/** Depth-first visit of every node in a flow tree. Recursion into a kind's
 *  nested bodies is DISPATCHED through the registry (each kind's `walk` handler),
 *  so a slice's structural combinator recurses without editing a central switch.
 *  Fails fast (via `requireNodeKind`) on an unregistered kind — matching the
 *  emitter — so a tree-shaken/missing registration surfaces as a clear error
 *  rather than silently skipping recursion into that node's nested bodies. A
 *  registered leaf kind with no `walk` handler is fine (nothing to recurse). */
export function walkNodes(nodes: FlowNode[], visit: (n: FlowNode) => void): void {
  for (const n of nodes) {
    visit(n);
    requireNodeKind(n.kind).walk?.(n, (body) => walkNodes(body, visit));
  }
}

/** The job types of a flow's external `task` steps (anywhere in the tree) — the
 *  contract workers outside this program must subscribe to. Each is the derived
 *  `<flowId>:<stepName>` unless the step overrode it via `w.task(name,
 *  { jobType })`. Deduplicated (preserving first-seen order) since several steps
 *  may intentionally share one override token. */
export function externalJobTypes(flow: DeclarativeFlow): string[] {
  const seen = new Set<string>();
  const types: string[] = [];
  walkNodes(flow.steps, (n) => {
    if (n.kind !== "task") return;
    const type = n.jobType ?? jobType(flow.id, n.name);
    if (seen.has(type)) return;
    seen.add(type);
    types.push(type);
  });
  return types;
}

function requireTimerAt(node: { at?: string }): string {
  if (node.at === undefined) throw new Error(`timer event is missing its { at } value`);
  return node.at;
}

function requireStartAt(timer: TimerStart): string {
  if (timer.at === undefined) throw new Error(`timer start is missing its { at } value`);
  return timer.at;
}

// --- Model emitter (two-phase graph compiler) --------------------------------

/** A renderable BPMN element the emitter has placed. A kind's `emit` handler
 *  adds one (or more) via `api.addNode(...)` (or a typed helper like
 *  `api.addServiceTask`). */
export interface RenderNode {
  id: string;
  render(incoming: string[], outgoing: string[]): string;
  /** For exclusive gateways: the flow id of the unconditional default edge. */
  defaultFlow?: string;
  /** Id of the embedded sub-process this node lives in, or undefined at the
   *  top level (the root process). */
  scope?: string;
}

/** A BPMN sequence flow being wired. A kind's `emit` handler creates danglers
 *  with `api.newEdge(from)` and resolves them with `api.connect(edges, toId)`. */
export interface Edge {
  id: string;
  from: string;
  to?: string;
  condition?: string;
  name?: string;
  /** The scope (sub-process id, or undefined = root process) this flow is
   *  nested in — so it renders inside the right container. */
  scope?: string;
}

/** The enclosing-loop context threaded through `emit`: `break`/`continue` route
 *  to `headId`, and `break` danglers collect in `breaks`. `null` outside a loop. */
export interface LoopCtx {
  headId: string;
  breaks: Edge[];
}

/** The emitter primitives a kind's `emit` handler uses to place its BPMN nodes
 *  and wire its sequence flows — WITHOUT reaching into `Compiler` internals or a
 *  central emit switch. Built-in kinds and slice-added kinds emit through this
 *  same surface. Node-render string helpers (`incomingOutgoing`, `escapeXml`, …)
 *  are exported alongside for building custom `RenderNode.render` closures. */
export interface EmitApi {
  /** The flow id (for error messages). */
  readonly flowId: string;
  /** Create a new (dangling) sequence flow from `from`; resolve its target with
   *  `connect`. */
  newEdge(from: string, opts?: { condition?: string; name?: string }): Edge;
  /** Point every one of `incoming` at `toId`. */
  connect(incoming: Edge[], toId: string): void;
  /** Record a referenced data envelope so it is lifted to a `nano:shape`. */
  recordEnvelope(env?: Envelope): void;
  /** Emit a sequence of nodes, threading danglers; used to emit nested bodies. */
  emitList(list: FlowNode[], incoming: Edge[], loop: LoopCtx | null): Edge[];
  /** Place a fully custom BPMN element (a slice's own render closure). */
  addNode(node: RenderNode): void;
  /** Place a `<bpmn:serviceTask>` with the standard taskDefinition/envelope
   *  extension elements (optionally with multi-instance characteristics). */
  addServiceTask(node: { name: string; envelopes?: NodeEnvelopes; jobType?: string }, mi?: string): void;
  /** Place a `<bpmn:intermediateCatchEvent>` with a message event definition. */
  addCatchEvent(node: { name: string }): void;
  /** Place a `<bpmn:intermediateCatchEvent>` with a timer event definition. */
  addTimerCatchEvent(node: { name: string; after?: string; at?: string }): void;
  /** Place a `<bpmn:exclusiveGateway>`, returning it so `defaultFlow` can be set. */
  addGateway(id: string, name?: string): RenderNode;
  /** Place a `<bpmn:parallelGateway>`. */
  addParallelGateway(id: string): RenderNode;
  /** Place an embedded `<bpmn:subProcess>` whose body renders in its own scope. */
  addSubProcess(id: string, mi: string): RenderNode;
  /** Place a plain none `<bpmn:startEvent>` (for an embedded sub-process). */
  addPlainStart(id: string): void;
  /** Place a plain `<bpmn:endEvent>` (for an embedded sub-process). */
  addPlainEnd(id: string): void;
  /** A fresh monotonic counter value for generated gateway/loop/sub ids. */
  nextGw(): number;
  /** The current scope (enclosing sub-process id, or undefined at the top level). */
  currentScope(): string | undefined;
  /** Open a sub-process scope (subsequent nodes/edges nest inside it). */
  pushScope(id: string): void;
  /** Close the current sub-process scope. */
  popScope(): void;
}

class Compiler {
  private readonly nodes: RenderNode[] = [];
  private readonly edges: Edge[] = [];
  /** envelope name → its fields, deduped for lifting to a single nano:shape. */
  private readonly envelopes = new Map<string, EnvelopeField[]>();
  /** The stack of open sub-process scopes; `.at(-1)` is the current scope (a
   *  node/edge created now nests inside it). Empty at the top level. */
  private readonly scopeStack: string[] = [];
  /** Edges with a resolved target, indexed in `compile()` before rendering so a
   *  sub-process can render its own nested scope. */
  private live: Edge[] = [];
  private seq = 0;
  private gw = 0;
  /** The emit surface handed to each kind's registered `emit` handler. */
  private readonly emitApi: EmitApi;

  constructor(private readonly flow: DeclarativeFlow) {
    this.emitApi = {
      flowId: flow.id,
      newEdge: (from, opts) => this.newEdge(from, opts),
      connect: (incoming, toId) => this.connect(incoming, toId),
      recordEnvelope: (env) => this.recordEnvelope(env),
      emitList: (list, incoming, loop) => this.emitList(list, incoming, loop),
      addNode: (node) => {
        this.nodes.push({ ...node, scope: node.scope ?? this.currentScope() });
      },
      addServiceTask: (node, mi) => this.addServiceTask(node, mi),
      addCatchEvent: (node) => this.addCatchEvent(node),
      addTimerCatchEvent: (node) => this.addTimerCatchEvent(node),
      addGateway: (id, name) => this.addGateway(id, name),
      addParallelGateway: (id) => this.addParallelGateway(id),
      addSubProcess: (id, mi) => this.addSubProcess(id, mi),
      addPlainStart: (id) => this.addPlainStart(id),
      addPlainEnd: (id) => this.addPlainEnd(id),
      nextGw: () => this.gw++,
      currentScope: () => this.currentScope(),
      pushScope: (id) => {
        this.scopeStack.push(id);
      },
      popScope: () => {
        this.scopeStack.pop();
      },
    };
  }

  private currentScope(): string | undefined {
    return this.scopeStack.length ? this.scopeStack[this.scopeStack.length - 1] : undefined;
  }

  private newEdge(from: string, opts: { condition?: string; name?: string } = {}): Edge {
    const e: Edge = {
      id: `f_${this.seq++}`,
      from,
      condition: opts.condition,
      name: opts.name,
      scope: this.currentScope(),
    };
    this.edges.push(e);
    return e;
  }

  private connect(incoming: Edge[], toId: string): void {
    for (const e of incoming) e.to = toId;
  }

  private recordEnvelope(env?: Envelope): void {
    if (!env) return;
    const prev = this.envelopes.get(env.name);
    if (prev) {
      if (JSON.stringify(prev) !== JSON.stringify(env.fields)) {
        throw new Error(
          `envelope "${env.name}" is declared with two different field sets in flow "${this.flow.id}"`,
        );
      }
      return;
    }
    this.envelopes.set(env.name, env.fields);
  }

  private addServiceTask(node: { name: string; envelopes?: NodeEnvelopes; jobType?: string }, mi = ""): void {
    const type = node.jobType ?? jobType(this.flow.id, node.name);
    this.recordEnvelope(node.envelopes?.in);
    this.recordEnvelope(node.envelopes?.out);
    const props: string[] = [];
    if (node.envelopes?.in) props.push(envelopeProp("in", node.envelopes.in.name));
    if (node.envelopes?.out) props.push(envelopeProp("out", node.envelopes.out.name));
    const ext =
      `      <bpmn:extensionElements>\n` +
      `        <zeebe:taskDefinition type="${escapeXml(type)}" />\n` +
      (props.length ? `        <zeebe:properties>\n${props.join("\n")}\n        </zeebe:properties>\n` : "") +
      `      </bpmn:extensionElements>`;
    const id = node.name;
    this.nodes.push({
      id,
      scope: this.currentScope(),
      render: (inc, outg) =>
        `    <bpmn:serviceTask id="${escapeXml(id)}" name="${escapeXml(id)}">\n` +
        ext +
        "\n" +
        incomingOutgoing(inc, outg) +
        mi +
        `    </bpmn:serviceTask>`,
    });
  }

  private addCatchEvent(node: { name: string }): void {
    const id = node.name;
    const msgId = `Msg_${id}`;
    this.nodes.push({
      id,
      scope: this.currentScope(),
      render: (inc, outg) =>
        `    <bpmn:intermediateCatchEvent id="${escapeXml(id)}" name="${escapeXml(id)}">\n` +
        incomingOutgoing(inc, outg) +
        `      <bpmn:messageEventDefinition messageRef="${msgId}" />\n` +
        `    </bpmn:intermediateCatchEvent>`,
    });
  }

  private addTimerCatchEvent(node: { name: string; after?: string; at?: string }): void {
    const id = node.name;
    const body =
      node.after !== undefined
        ? `        <bpmn:timeDuration>${escapeXml(node.after)}</bpmn:timeDuration>\n`
        : `        <bpmn:timeDate>${escapeXml(requireTimerAt(node))}</bpmn:timeDate>\n`;
    this.nodes.push({
      id,
      scope: this.currentScope(),
      render: (inc, outg) =>
        `    <bpmn:intermediateCatchEvent id="${escapeXml(id)}" name="${escapeXml(id)}">\n` +
        incomingOutgoing(inc, outg) +
        `      <bpmn:timerEventDefinition>\n` +
        body +
        `      </bpmn:timerEventDefinition>\n` +
        `    </bpmn:intermediateCatchEvent>`,
    });
  }

  private addGateway(id: string, name?: string): RenderNode {
    const gwNode: RenderNode = {
      id,
      scope: this.currentScope(),
      render: (inc, outg) => {
        const def = gwNode.defaultFlow ? ` default="${gwNode.defaultFlow}"` : "";
        const nm = name ? ` name="${escapeXml(name)}"` : "";
        return (
          `    <bpmn:exclusiveGateway id="${id}"${nm}${def}>\n` +
          incomingOutgoing(inc, outg) +
          `    </bpmn:exclusiveGateway>`
        );
      },
    };
    this.nodes.push(gwNode);
    return gwNode;
  }

  private addParallelGateway(id: string): RenderNode {
    const node: RenderNode = {
      id,
      scope: this.currentScope(),
      render: (inc, outg) =>
        `    <bpmn:parallelGateway id="${id}">\n` + incomingOutgoing(inc, outg) + `    </bpmn:parallelGateway>`,
    };
    this.nodes.push(node);
    return node;
  }

  private addPlainStart(id: string): void {
    this.nodes.push({
      id,
      scope: this.currentScope(),
      render: (_inc, outg) => `    <bpmn:startEvent id="${escapeXml(id)}">${outgoingOnly(outg)}</bpmn:startEvent>`,
    });
  }

  private addPlainEnd(id: string): void {
    this.nodes.push({
      id,
      scope: this.currentScope(),
      render: (inc) => `    <bpmn:endEvent id="${escapeXml(id)}">${incomingOnly(inc)}</bpmn:endEvent>`,
    });
  }

  /** An embedded sub-process whose body renders nested in its own scope, with the
   *  given multi-instance characteristics lifted onto it. */
  private addSubProcess(id: string, mi: string): RenderNode {
    const node: RenderNode = {
      id,
      scope: this.currentScope(),
      render: (inc, outg) =>
        `    <bpmn:subProcess id="${escapeXml(id)}">\n` +
        incomingOutgoing(inc, outg) +
        mi +
        this.renderScope(id) +
        `\n    </bpmn:subProcess>`,
    };
    this.nodes.push(node);
    return node;
  }

  private emitList(list: FlowNode[], incoming: Edge[], loop: LoopCtx | null): Edge[] {
    let cur = incoming;
    for (const node of list) cur = this.emitNode(node, cur, loop);
    return cur;
  }

  /** Emit one node by DISPATCHING to its registered `emit` handler — no central
   *  switch on `node.kind`. A slice's kind is emitted by its own module. */
  private emitNode(node: FlowNode, incoming: Edge[], loop: LoopCtx | null): Edge[] {
    return requireNodeKind(node.kind).emit(node, incoming, loop, this.emitApi);
  }

  /** Render every node + sequence flow that belongs to `scope` (undefined = the
   *  root process, a sub-process id otherwise). Called for the process body and,
   *  recursively, from each sub-process's render closure. */
  private renderScope(scope: string | undefined): string {
    const incomingOf = (id: string) => this.live.filter((e) => e.to === id).map((e) => e.id);
    const outgoingOf = (id: string) => this.live.filter((e) => e.from === id).map((e) => e.id);
    const nodeXml = this.nodes
      .filter((n) => n.scope === scope)
      .map((n) => n.render(incomingOf(n.id), outgoingOf(n.id)))
      .join("\n");
    const flowXml = this.live
      .filter((e) => e.scope === scope)
      .map((e) => sequenceFlow(e))
      .join("\n");
    return nodeXml + (nodeXml && flowXml ? "\n" : "") + flowXml;
  }

  /** Render the Start event — a plain none start, or a timer start when the
   *  flow declared `startOn(...)`. */
  private renderStart(outg: string[]): string {
    const t = this.flow.startTimer;
    if (!t) return `    <bpmn:startEvent id="Start">${outgoingOnly(outg)}</bpmn:startEvent>`;
    const body =
      t.cycle !== undefined
        ? `<bpmn:timeCycle>${escapeXml(t.cycle)}</bpmn:timeCycle>`
        : t.after !== undefined
          ? `<bpmn:timeDuration>${escapeXml(t.after)}</bpmn:timeDuration>`
          : `<bpmn:timeDate>${escapeXml(requireStartAt(t))}</bpmn:timeDate>`;
    return (
      `    <bpmn:startEvent id="Start">\n` +
      `      ${outgoingOnly(outg)}\n` +
      `      <bpmn:timerEventDefinition>\n` +
      `        ${body}\n` +
      `      </bpmn:timerEventDefinition>\n` +
      `    </bpmn:startEvent>`
    );
  }

  compile(): string {
    // Start → top-level sequence → End.
    this.nodes.push({
      id: "Start",
      render: (_inc, outg) => this.renderStart(outg),
    });
    const s0 = this.newEdge("Start");
    const finalDanglers = this.emitList(this.flow.steps, [s0], null);
    this.nodes.push({
      id: "End",
      render: (inc) => `    <bpmn:endEvent id="End">${incomingOnly(inc)}</bpmn:endEvent>`,
    });
    this.connect(finalDanglers, "End");

    // A sequence flow needs both ends; drop any edge that never got a target.
    this.live = this.edges.filter((e) => e.to !== undefined);

    const bodyXml = this.renderScope(undefined);
    const messageXml = this.emitMessages();
    const shapeXml = this.emitShapes();

    return (
      `<?xml version="1.0" encoding="UTF-8"?>\n` +
      `<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" ` +
      `xmlns:zeebe="http://camunda.org/schema/zeebe/1.0" ` +
      `xmlns:nano="https://nanobpm.io/schema/shapes/1.0" ` +
      `id="Definitions_${escapeXml(this.flow.id)}" targetNamespace="http://bpmn.io/schema/bpmn">\n` +
      `  <bpmn:process id="${escapeXml(this.flow.id)}" name="${escapeXml(this.flow.id)}" isExecutable="true">\n` +
      (shapeXml ? shapeXml + "\n" : "") +
      bodyXml +
      "\n" +
      `  </bpmn:process>\n` +
      messageXml +
      (messageXml ? "\n" : "") +
      `</bpmn:definitions>\n`
    );
  }

  /** Emit a `<bpmn:message>` per signal step, with its subscription and (when
   *  typed) its payload data envelope. */
  private emitMessages(): string {
    const msgs: string[] = [];
    walkNodes(this.flow.steps, (n) => {
      if (n.kind !== "signal") return;
      const msgId = `Msg_${n.name}`;
      const payloadProp = n.payload
        ? `\n      <zeebe:properties>\n${envelopeProp("in", n.payload.name)}\n      </zeebe:properties>`
        : "";
      msgs.push(
        `  <bpmn:message id="${msgId}" name="${escapeXml(messageName(this.flow.id, n.name))}">\n` +
          `    <bpmn:extensionElements>\n` +
          `      <zeebe:subscription correlationKey="=${escapeXml(n.correlationKey)}" />` +
          payloadProp +
          `\n    </bpmn:extensionElements>\n` +
          `  </bpmn:message>`,
      );
    });
    return msgs.join("\n");
  }

  /** Lift the referenced data envelopes into a `<nano:shapes>` container on the
   *  process extension elements, so the model carries the typed contracts and is
   *  ejectable to model-first. */
  private emitShapes(): string {
    if (this.envelopes.size === 0) return "";
    const shapes = [...this.envelopes.entries()].map(([name, fields]) => {
      const exts = fields.map((f) => {
        const opt = f.optional ? ` optional="true"` : "";
        const list = f.list ? ` list="true"` : "";
        return `        <nano:extend name="${escapeXml(f.name)}" type="${escapeXml(f.type)}"${opt}${list} />`;
      });
      return `      <nano:shape id="${escapeXml(name)}">\n${exts.join("\n")}\n      </nano:shape>`;
    });
    return (
      `    <bpmn:extensionElements>\n` +
      `      <nano:shapes>\n${shapes.join("\n")}\n      </nano:shapes>\n` +
      `    </bpmn:extensionElements>`
    );
  }
}

/** Derive an executable BPMN model from a declarative flow. */
export function declarativeToBpmn(flow: DeclarativeFlow): string {
  return new Compiler(flow).compile();
}

// --- small XML / FEEL helpers ------------------------------------------------

const envelopeProp = (dir: "in" | "out", value: string): string =>
  `          <zeebe:property name="io.nanobpm.dataEnvelope.${dir}" value="${escapeXml(value)}" />`;

/** Wrap a raw FEEL expression as a Zeebe condition body (leading `=`). Exported
 *  for slice-added combinators that emit conditional sequence flows. */
export const feel = (expr: string): string => `=${expr}`;

/** A FEEL equality test `subject = "value"`, with the value as a FEEL string.
 *  Exported for slice-added combinators that emit an XOR gateway. */
export const feelEquals = (subject: string, value: string): string =>
  `=${subject} = "${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;

/** Render the `<bpmn:incoming>`/`<bpmn:outgoing>` refs of a flow node. Exported
 *  for slice `RenderNode.render` closures. */
export function incomingOutgoing(inc: string[], outg: string[]): string {
  return (
    inc.map((f) => `      <bpmn:incoming>${f}</bpmn:incoming>\n`).join("") +
    outg.map((f) => `      <bpmn:outgoing>${f}</bpmn:outgoing>\n`).join("")
  );
}
/** Render only the `<bpmn:incoming>` refs (for end-like events). Exported. */
export const incomingOnly = (inc: string[]): string =>
  inc.map((f) => `<bpmn:incoming>${f}</bpmn:incoming>`).join("");
/** Render only the `<bpmn:outgoing>` refs (for start-like events). Exported. */
export const outgoingOnly = (outg: string[]): string =>
  outg.map((f) => `<bpmn:outgoing>${f}</bpmn:outgoing>`).join("");

function sequenceFlow(e: Edge): string {
  const nm = e.name ? ` name="${escapeXml(e.name)}"` : "";
  if (e.condition) {
    return (
      `    <bpmn:sequenceFlow id="${e.id}" sourceRef="${e.from}" targetRef="${e.to}"${nm}>\n` +
      `      <bpmn:conditionExpression>${escapeXml(e.condition)}</bpmn:conditionExpression>\n` +
      `    </bpmn:sequenceFlow>`
    );
  }
  return `    <bpmn:sequenceFlow id="${e.id}" sourceRef="${e.from}" targetRef="${e.to}"${nm} />`;
}
