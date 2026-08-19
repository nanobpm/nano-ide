// Flow-node kind: `race` — a first-of event race (a BPMN event-based gateway).
// The gateway forks to one intermediate catch event per arm — a MESSAGE catch for
// a `signal` arm (correlated on a process variable) or a TIMER catch for a `timer`
// arm — and the engine arms them all at once. The FIRST event to fire wins: its
// arm's `do` body runs and the losing catch events are cancelled; each arm's body
// then converges on whatever follows the race.
//
// Contributed entirely from this module through the wave-0 extension seam (epic
// #314, S1/#316): its `FlowNode` variant (declaration-merged into the augmentable
// `FlowNodeRegistry`), its `w.race(...)` builder method (merged into
// `FlowBuilder<C>`), and its `walk`/`emit` handlers — with NO edit to the shared
// `FlowNode` union, the `walkNodes`/`emitNode` dispatch, or the generated barrel.
//
// The catch arms are modelled as nested `signal`/`timer` `FlowNode`s so the whole
// machine reuses the built-ins: `walk` recurses into them (so the shared message
// emitter lifts each `signal` arm's `<bpmn:message>` + correlation subscription
// automatically, and `WorkflowClient.signal` can correlate to it), and `emit`
// dispatches each arm's catch through its own registered handler (so a race's
// catch is byte-identical to a standalone `w.signal`/`w.timer`). Only the
// event-based gateway itself is placed here.

import type { FlowNode } from "../types.js";
import type { Block, Edge, RenderNode } from "../declarative.js";
import { incomingOutgoing } from "../declarative.js";
import { assertIdent, assertTimerDate, assertTimerDuration, escapeXml } from "../xml.js";
import { registerNodeKind, requireNodeKind } from "./registry.js";

/** One arm of a {@link FlowBuilder.race}: exactly one waited-for event — a
 *  `signal` (a message catch correlated on a process variable) OR a `timer` (a
 *  delay `{ after }` or an instant `{ at }`) — plus the `do` body that runs when
 *  that event wins the race. */
export type RaceArm = ({ signal: { correlationKey: string } } | { timer: { after: string } | { at: string } }) & {
  do: Block;
};

/** A compiled race arm: its catch event (a `signal` or `timer` `FlowNode`, reused
 *  from the built-ins) and the body that runs when it wins. */
interface CompiledArm {
  event: FlowNode;
  body: FlowNode[];
}

declare module "../types.js" {
  interface FlowNodeRegistry {
    race: { kind: "race"; arms: CompiledArm[] };
  }
}

declare module "../declarative.js" {
  interface FlowBuilder<C extends object> {
    /**
     * A first-of event race — a BPMN event-based gateway. Each named arm waits on
     * exactly one event: a `signal` (a durable message catch correlated on a
     * process variable) or a `timer` (`{ after }` a delay, or `{ at }` an
     * instant). The engine arms every catch at once; the FIRST to fire wins, its
     * arm's `do` body runs, and the losing catch events are cancelled. Every arm's
     * body converges on whatever follows the race.
     *
     * ```ts
     * w.race({
     *   "review-ready":   { signal: { correlationKey: "prKey" }, do: (b) => b.run("re-review", reReview) },
     *   "review-timeout": { timer:  { after: "=reviewWaitTimeout" }, do: (b) => b.run("escalate", escalate) },
     * });
     * ```
     */
    race(arms: Record<string, RaceArm>): FlowBuilder<C>;
  }
}

function hasSignal(spec: RaceArm): spec is { signal: { correlationKey: string } } & { do: Block } {
  return "signal" in spec && spec.signal !== null && typeof spec.signal === "object";
}

function hasTimer(spec: RaceArm): spec is { timer: { after: string } | { at: string } } & { do: Block } {
  return "timer" in spec && spec.timer !== null && typeof spec.timer === "object";
}

registerNodeKind("race", {
  build: (api) => (arms: Record<string, RaceArm>) => {
    if (arms === null || typeof arms !== "object") {
      throw new Error(`race() needs an arms object { "<name>": { signal | timer, do } }`);
    }
    const entries = Object.entries(arms);
    if (entries.length < 2) {
      throw new Error(
        `race() needs at least two arms (an event-based gateway with fewer than two events is degenerate)`,
      );
    }
    const compiled: CompiledArm[] = [];
    for (const [name, spec] of entries) {
      if (spec === null || typeof spec !== "object") {
        throw new Error(`race() arm "${name}" must be an object { signal | timer, do }`);
      }
      const isSignal = hasSignal(spec);
      const isTimer = hasTimer(spec);
      if (isSignal === isTimer) {
        throw new Error(
          `race() arm "${name}" needs exactly one of { signal: { correlationKey } } or { timer: { after | at } }`,
        );
      }
      if (typeof spec.do !== "function") {
        throw new Error(`race() arm "${name}" needs a do block (b) => {…}`);
      }
      api.claim(name);
      let event: FlowNode;
      if (isSignal) {
        const correlationKey = spec.signal.correlationKey;
        if (typeof correlationKey !== "string" || correlationKey.trim() === "") {
          throw new Error(`race() arm "${name}" signal needs a non-empty { correlationKey }`);
        }
        assertIdent("correlationKey", correlationKey);
        event = { kind: "signal", name, correlationKey, payload: api.contracts[name]?.in };
      } else {
        const timer = spec.timer;
        const hasAfter = "after" in timer && typeof timer.after === "string";
        const hasAt = "at" in timer && typeof timer.at === "string";
        if (hasAfter === hasAt) {
          throw new Error(`race() arm "${name}" timer needs exactly one of { after } (a delay) or { at } (an instant)`);
        }
        if ("after" in timer) {
          const after = timer.after.trim();
          assertTimerDuration(`race() arm "${name}" timer after`, after);
          event = { kind: "timer", name, after };
        } else {
          const at = timer.at.trim();
          assertTimerDate(`race() arm "${name}" timer at`, at);
          event = { kind: "timer", name, at };
        }
      }
      compiled.push({ event, body: api.child(spec.do, false) });
    }
    api.out.push({ kind: "race", arms: compiled });
    return api.self();
  },
  walk: (node, recurse) => {
    // Recurse into each arm's catch event AND its body: the catch `signal` nodes
    // must be visited so the shared message emitter lifts their `<bpmn:message>`
    // + correlation subscription, and body `task` nodes so their external job
    // types are discovered — exactly as a standalone `signal`/`task` would be.
    for (const arm of node.arms) recurse([arm.event, ...arm.body]);
  },
  emit: (node, incoming, loop, api) => {
    const gwId = `Gw_${api.nextGw()}`;
    api.addNode(eventBasedGateway(gwId, api.currentScope()));
    api.connect(incoming, gwId);
    const out: Edge[] = [];
    for (const arm of node.arms) {
      // Fork the gateway straight to the arm's catch event (BPMN requires an
      // event-based gateway's targets to be intermediate catch events), reusing
      // the arm kind's own registered emit so the catch is identical to a
      // standalone `w.signal`/`w.timer`; then wire its `do` body onward.
      const fork = api.newEdge(gwId);
      const afterCatch = requireNodeKind(arm.event.kind).emit(arm.event, [fork], loop, api);
      out.push(...api.emitList(arm.body, afterCatch, loop));
    }
    return out;
  },
});

/** A `<bpmn:eventBasedGateway>` render node (no typed `EmitApi` primitive exists —
 *  built as a custom {@link RenderNode} from the exported string helpers). */
function eventBasedGateway(id: string, scope: string | undefined): RenderNode {
  return {
    id,
    scope,
    render: (inc: string[], outg: string[]) =>
      `    <bpmn:eventBasedGateway id="${escapeXml(id)}">\n` + incomingOutgoing(inc, outg) + `    </bpmn:eventBasedGateway>`,
  };
}
