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
  SwitchCase,
  TimerStart,
} from "./types.js";
import type { Envelope, EnvelopeField } from "./envelope.js";
import { assertIdent, assertJobType, assertTimerCycle, assertTimerDate, assertTimerDuration, escapeXml, jobType, messageName } from "./xml.js";

// --- Authoring surface -------------------------------------------------------

/** The TS payload type of a contract's input envelope (untyped fallback). */
type InPayload<Ct> = Ct extends { in: Envelope } ? Ct["in"]["type"] & JsonObject : JsonObject;
/** The TS payload type of a contract's output envelope (untyped fallback). */
type OutPayload<Ct> = Ct extends { out: Envelope } ? Ct["out"]["type"] & JsonObject : JsonObject;
/** The input payload type of step `K` under contracts `C`. */
type VarsOf<C, K extends string> = K extends keyof C ? InPayload<C[K]> : JsonObject;
/** The output payload type of step `K` under contracts `C`. */
type ResultOf<C, K extends string> = K extends keyof C ? OutPayload<C[K]> : JsonObject;

/** A typed handler for a `run` step: its job variables and result are resolved
 *  from the flow contracts by the step name. */
type TypedHandler<V extends JsonObject, R extends JsonObject> = (job: {
  jobKey: string;
  processInstanceKey: string;
  elementId: string;
  type: string;
  variables: V;
}) => Promise<R | void> | R | void;

/** A block: the callback that populates a nested body (a case, arm, or loop). */
type Block<C extends object> = (b: FlowBuilder<C>) => void;

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

/** Build a FlowBuilder that appends its nodes to `out`, sharing the flow-wide
 *  `ctx` (contracts, handler registry, name set, loop nesting). Structural
 *  combinators recurse with a fresh `out` array for each nested body. */
function makeBuilder<C extends object>(
  id: string,
  out: FlowNode[],
  ctx: BuilderCtx,
  isRoot = false,
): FlowBuilder<C> {
  const child = (fn: Block<C>, inLoop: boolean): FlowNode[] => {
    const body: FlowNode[] = [];
    const depth = inLoop ? ctx.loopDepth + 1 : ctx.loopDepth;
    fn(makeBuilder<C>(id, body, { ...ctx, loopDepth: depth }));
    return body;
  };
  // A body that runs in its OWN token scope (an embedded sub-process): the
  // enclosing loop is not reachable across the scope boundary, so `break`/
  // `continue` inside it are rejected (loopDepth resets to 0). A `loop` declared
  // INSIDE the body still works — it creates its own scope.
  const childScoped = (fn: Block<C>): FlowNode[] => {
    const body: FlowNode[] = [];
    fn(makeBuilder<C>(id, body, { ...ctx, loopDepth: 0 }));
    return body;
  };
  const b: FlowBuilder<C> = {
    run<K extends string>(
      name: K,
      handler: TypedHandler<VarsOf<C, K>, ResultOf<C, K>>,
    ): FlowBuilder<C> {
      claimName(ctx, id, name);
      if (typeof handler !== "function") throw new Error(`run("${name}") needs a handler function`);
      ctx.handlers[name] = handler;
      out.push({ kind: "run", name, envelopes: contractEnvelopes(ctx, name) });
      return b;
    },
    task(name: string, opts?: { jobType?: string }): FlowBuilder<C> {
      claimName(ctx, id, name);
      const override = opts?.jobType;
      if (override !== undefined) assertJobType("task jobType", override);
      out.push({ kind: "task", name, envelopes: contractEnvelopes(ctx, name), jobType: override });
      return b;
    },
    signal(name: string, opts: { correlationKey: string }): FlowBuilder<C> {
      claimName(ctx, id, name);
      if (!opts || !opts.correlationKey) throw new Error(`signal("${name}") needs { correlationKey }`);
      assertIdent("correlationKey", opts.correlationKey);
      out.push({ kind: "signal", name, correlationKey: opts.correlationKey, payload: ctx.contracts[name]?.in });
      return b;
    },
    timer(name: string, opts: { after: string } | { at: string }): FlowBuilder<C> {
      claimName(ctx, id, name);
      const hasAfter = "after" in opts && typeof opts.after === "string";
      const hasAt = "at" in opts && typeof opts.at === "string";
      if (hasAfter === hasAt) {
        throw new Error(`timer("${name}") needs exactly one of { after } (a delay) or { at } (an instant)`);
      }
      if ("after" in opts) {
        const after = opts.after.trim();
        assertTimerDuration(`timer("${name}") after`, after);
        out.push({ kind: "timer", name, after });
      } else {
        const at = opts.at.trim();
        assertTimerDate(`timer("${name}") at`, at);
        out.push({ kind: "timer", name, at });
      }
      return b;
    },
    startOn(spec: { cycle: string } | { after: string } | { at: string }): FlowBuilder<C> {
      if (!isRoot) {
        throw new Error(`startOn() is only valid at the top level of flow "${id}" (not inside switch/branch/loop)`);
      }
      if (out.length !== 0) throw new Error(`startOn() must be the first statement in flow "${id}"`);
      if (ctx.startTimer) throw new Error(`startOn() may be called only once in flow "${id}"`);
      const setCount = TIMER_START_KEYS.filter((key) => typeof timerStartValue(spec, key) === "string").length;
      if (setCount !== 1) {
        throw new Error(`startOn() needs exactly one of { cycle }, { after }, or { at } in flow "${id}"`);
      }
      if ("cycle" in spec) {
        const cycle = spec.cycle.trim();
        assertTimerCycle(`startOn cycle`, cycle);
        ctx.startTimer = { cycle };
      } else if ("after" in spec) {
        const after = spec.after.trim();
        assertTimerDuration(`startOn after`, after);
        ctx.startTimer = { after };
      } else {
        const at = spec.at.trim();
        assertTimerDate(`startOn at`, at);
        ctx.startTimer = { at };
      }
      return b;
    },
    switch(subject: string, cases: Record<string, Block<C>> & { default?: Block<C> }): FlowBuilder<C> {
      if (typeof subject !== "string" || subject.trim() === "") {
        throw new Error(`switch() needs a non-empty subject expression`);
      }
      const caseNodes: SwitchCase[] = [];
      for (const [value, fn] of Object.entries(cases)) {
        if (value === "default") continue;
        if (typeof fn !== "function") throw new Error(`switch("${subject}") cases must be blocks (b) => {…}`);
        caseNodes.push({ value, body: child(fn, false) });
      }
      if (caseNodes.length === 0) throw new Error(`switch("${subject}") needs at least one case`);
      const def = cases.default ? child(cases.default, false) : undefined;
      out.push({ kind: "switch", subject, cases: caseNodes, default: def });
      return b;
    },
    branch(condition: string, arms: { then: Block<C>; else?: Block<C> }): FlowBuilder<C> {
      if (typeof condition !== "string" || condition.trim() === "") {
        throw new Error(`branch() needs a non-empty FEEL condition`);
      }
      if (!arms || typeof arms.then !== "function") throw new Error(`branch("${condition}") needs a then arm`);
      out.push({
        kind: "branch",
        condition,
        then: child(arms.then, false),
        else: arms.else ? child(arms.else, false) : undefined,
      });
      return b;
    },
    loop(body: Block<C>): FlowBuilder<C> {
      if (typeof body !== "function") throw new Error(`loop() needs a body function`);
      out.push({ kind: "loop", body: child(body, true) });
      return b;
    },
    parallel(branches: Block<C>[]): FlowBuilder<C> {
      if (!Array.isArray(branches) || branches.length < 2) {
        throw new Error(`parallel() needs at least two branch blocks`);
      }
      for (const fn of branches) {
        if (typeof fn !== "function") throw new Error(`parallel() branches must all be blocks (b) => {…}`);
      }
      // Each branch runs in its own token scope up to the AND-join, so a
      // `break`/`continue` must not escape the fork/join into an enclosing
      // loop. Scope branches (loopDepth resets to 0) so cross-boundary
      // break/continue is rejected at build time, matching forEach.
      out.push({ kind: "parallel", branches: branches.map((fn) => childScoped(fn)) });
      return b;
    },
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
    ): FlowBuilder<C> {
      if (typeof collection !== "string" || collection.trim() === "") {
        throw new Error(`forEach() needs a non-empty FEEL collection expression`);
      }
      // Authors may paste a leading "=" (common in Zeebe FEEL examples). Strip
      // it so the emitter's own "=" prefix never produces an invalid "==...".
      const collExpr = collection.trim().replace(/^=/, "").trim();
      if (collExpr === "") {
        throw new Error(`forEach() collection expression is empty after stripping the leading "="`);
      }
      assertIdent("forEach itemVar", itemVar);
      if (typeof body !== "function") throw new Error(`forEach("${itemVar}") needs a body function`);
      const nodes = childScoped(body);
      if (nodes.length === 0) throw new Error(`forEach("${itemVar}") body declared no steps`);
      const node: Extract<FlowNode, { kind: "forEach" }> = {
        kind: "forEach",
        collection: collExpr,
        itemVar,
        body: nodes,
      };
      if (opts?.sequential) node.sequential = true;
      if (opts?.outputCollection !== undefined) {
        assertIdent("forEach outputCollection", opts.outputCollection);
        node.outputCollection = opts.outputCollection;
      }
      if (opts?.outputElement !== undefined) {
        if (typeof opts.outputElement !== "string" || opts.outputElement.trim() === "") {
          throw new Error(`forEach("${itemVar}") outputElement must be a non-empty FEEL expression`);
        }
        const outEl = opts.outputElement.trim().replace(/^=/, "").trim();
        if (outEl === "") {
          throw new Error(`forEach("${itemVar}") outputElement is empty after stripping the leading "="`);
        }
        node.outputElement = outEl;
      }
      if (opts?.completionCondition !== undefined) {
        if (typeof opts.completionCondition !== "string" || opts.completionCondition.trim() === "") {
          throw new Error(`forEach("${itemVar}") completionCondition must be a non-empty FEEL expression`);
        }
        const compCond = opts.completionCondition.trim().replace(/^=/, "").trim();
        if (compCond === "") {
          throw new Error(`forEach("${itemVar}") completionCondition is empty after stripping the leading "="`);
        }
        node.completionCondition = compCond;
      }
      if (node.outputElement && !node.outputCollection) {
        throw new Error(`forEach("${itemVar}") outputElement needs an outputCollection to collect into`);
      }
      out.push(node);
      return b;
    },
    break(): FlowBuilder<C> {
      if (ctx.loopDepth === 0) throw new Error(`break() is only valid inside a loop`);
      out.push({ kind: "break" });
      return b;
    },
    continue(): FlowBuilder<C> {
      if (ctx.loopDepth === 0) throw new Error(`continue() is only valid inside a loop`);
      out.push({ kind: "continue" });
      return b;
    },
  };
  return b;
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

/** Depth-first visit of every node in a flow tree (structural combinators
 *  recurse into their bodies). */
export function walkNodes(nodes: FlowNode[], visit: (n: FlowNode) => void): void {
  for (const n of nodes) {
    visit(n);
    switch (n.kind) {
      case "switch":
        for (const c of n.cases) walkNodes(c.body, visit);
        if (n.default) walkNodes(n.default, visit);
        break;
      case "branch":
        walkNodes(n.then, visit);
        if (n.else) walkNodes(n.else, visit);
        break;
      case "loop":
        walkNodes(n.body, visit);
        break;
      case "parallel":
        for (const branch of n.branches) walkNodes(branch, visit);
        break;
      case "forEach":
        walkNodes(n.body, visit);
        break;
      default:
        break;
    }
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

interface RenderNode {
  id: string;
  render(incoming: string[], outgoing: string[]): string;
  /** For exclusive gateways: the flow id of the unconditional default edge. */
  defaultFlow?: string;
  /** Id of the embedded sub-process this node lives in, or undefined at the
   *  top level (the root process). */
  scope?: string;
}

interface Edge {
  id: string;
  from: string;
  to?: string;
  condition?: string;
  name?: string;
  /** The scope (sub-process id, or undefined = root process) this flow is
   *  nested in — so it renders inside the right container. */
  scope?: string;
}

interface LoopCtx {
  headId: string;
  breaks: Edge[];
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

  private readonly flow: DeclarativeFlow;

  constructor(flow: DeclarativeFlow) {
    this.flow = flow;
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

  /** The `<bpmn:multiInstanceLoopCharacteristics>` block for a `forEach` node —
   *  the same shape whether lifted onto a leaf service task or a sub-process. */
  private miCharacteristics(node: Extract<FlowNode, { kind: "forEach" }>): string {
    const seq = node.sequential ? "true" : "false";
    const attrs = [
      `inputCollection="${escapeXml(`=${node.collection}`)}"`,
      `inputElement="${escapeXml(node.itemVar)}"`,
    ];
    if (node.outputCollection) attrs.push(`outputCollection="${escapeXml(node.outputCollection)}"`);
    if (node.outputElement) attrs.push(`outputElement="${escapeXml(`=${node.outputElement}`)}"`);
    const completion = node.completionCondition
      ? `      <bpmn:completionCondition>${escapeXml(`=${node.completionCondition}`)}</bpmn:completionCondition>\n`
      : "";
    return (
      `      <bpmn:multiInstanceLoopCharacteristics isSequential="${seq}">\n` +
      `        <bpmn:extensionElements>\n` +
      `          <zeebe:loopCharacteristics ${attrs.join(" ")} />\n` +
      `        </bpmn:extensionElements>\n` +
      completion +
      `      </bpmn:multiInstanceLoopCharacteristics>\n`
    );
  }

  private emitList(list: FlowNode[], incoming: Edge[], loop: LoopCtx | null): Edge[] {
    let cur = incoming;
    for (const node of list) cur = this.emitNode(node, cur, loop);
    return cur;
  }

  private emitNode(node: FlowNode, incoming: Edge[], loop: LoopCtx | null): Edge[] {
    switch (node.kind) {
      case "run":
      case "task": {
        this.addServiceTask(node);
        this.connect(incoming, node.name);
        return [this.newEdge(node.name)];
      }
      case "signal": {
        this.addCatchEvent(node);
        this.connect(incoming, node.name);
        this.recordEnvelope(node.payload);
        return [this.newEdge(node.name)];
      }
      case "timer": {
        this.addTimerCatchEvent(node);
        this.connect(incoming, node.name);
        return [this.newEdge(node.name)];
      }
      case "switch": {
        const id = `Gw_${this.gw++}`;
        const gw = this.addGateway(id, node.subject);
        this.connect(incoming, id);
        const out: Edge[] = [];
        for (const c of node.cases) {
          const e = this.newEdge(id, { condition: feelEquals(node.subject, c.value), name: c.value });
          out.push(...this.emitList(c.body, [e], loop));
        }
        // The default (or a synthesised fall-through) is the unconditional edge.
        const de = this.newEdge(id, { name: "default" });
        gw.defaultFlow = de.id;
        out.push(...this.emitList(node.default ?? [], [de], loop));
        return out;
      }
      case "branch": {
        const id = `Gw_${this.gw++}`;
        const gw = this.addGateway(id);
        this.connect(incoming, id);
        const te = this.newEdge(id, { condition: feel(node.condition), name: "then" });
        const out = this.emitList(node.then, [te], loop);
        const ee = this.newEdge(id, { name: "else" });
        gw.defaultFlow = ee.id;
        out.push(...this.emitList(node.else ?? [], [ee], loop));
        return out;
      }
      case "loop": {
        const headId = `Loop_${this.gw++}`;
        this.addGateway(headId);
        this.connect(incoming, headId);
        const ctx: LoopCtx = { headId, breaks: [] };
        const headOut = this.newEdge(headId);
        const bodyOut = this.emitList(node.body, [headOut], ctx);
        // Normal fall-through of the body loops back to the head (continue).
        this.connect(bodyOut, headId);
        // The loop exits only via break edges.
        return ctx.breaks;
      }
      case "break": {
        if (!loop) throw new Error(`break outside a loop in flow "${this.flow.id}"`);
        // The incoming edges (from the previous node) become the loop's exit
        // danglers; this path does not fall through.
        loop.breaks.push(...incoming);
        return [];
      }
      case "continue": {
        if (!loop) throw new Error(`continue outside a loop in flow "${this.flow.id}"`);
        this.connect(incoming, loop.headId);
        return [];
      }
      case "parallel": {
        // A diverging parallel gateway forks a token onto every branch; a
        // converging one joins them (AND-join) into a single continuation.
        const splitId = `Gw_${this.gw++}`;
        this.addParallelGateway(splitId);
        this.connect(incoming, splitId);
        const joinId = `Gw_${this.gw++}`;
        this.addParallelGateway(joinId);
        for (const branch of node.branches) {
          const e = this.newEdge(splitId);
          const branchOut = this.emitList(branch, [e], loop);
          this.connect(branchOut, joinId);
        }
        return [this.newEdge(joinId)];
      }
      case "forEach": {
        const mi = this.miCharacteristics(node);
        const only = node.body.length === 1 ? node.body[0] : undefined;
        // A single service-task body carries the MI characteristics directly; a
        // multi-step body is wrapped in an embedded MI sub-process (its own token
        // scope, with its own start/end).
        if (only && (only.kind === "run" || only.kind === "task")) {
          this.addServiceTask(only, mi);
          this.connect(incoming, only.name);
          return [this.newEdge(only.name)];
        }
        const subId = `Sub_${this.gw++}`;
        this.addSubProcess(subId, mi);
        this.connect(incoming, subId);
        this.scopeStack.push(subId);
        const startId = `${subId}_start`;
        this.addPlainStart(startId);
        const innerOut = this.emitList(node.body, [this.newEdge(startId)], null);
        const endId = `${subId}_end`;
        this.addPlainEnd(endId);
        this.connect(innerOut, endId);
        this.scopeStack.pop();
        return [this.newEdge(subId)];
      }
    }
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

/** Wrap a raw FEEL expression as a Zeebe condition body (leading `=`). */
const feel = (expr: string): string => `=${expr}`;

/** A FEEL equality test `subject = "value"`, with the value as a FEEL string. */
const feelEquals = (subject: string, value: string): string =>
  `=${subject} = "${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;

function incomingOutgoing(inc: string[], outg: string[]): string {
  return (
    inc.map((f) => `      <bpmn:incoming>${f}</bpmn:incoming>\n`).join("") +
    outg.map((f) => `      <bpmn:outgoing>${f}</bpmn:outgoing>\n`).join("")
  );
}
const incomingOnly = (inc: string[]): string => inc.map((f) => `<bpmn:incoming>${f}</bpmn:incoming>`).join("");
const outgoingOnly = (outg: string[]): string => outg.map((f) => `<bpmn:outgoing>${f}</bpmn:outgoing>`).join("");

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
