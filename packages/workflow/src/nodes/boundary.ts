// Flow-node kind: `boundary` — an activity-level attached interrupting timer
// boundary event (an SLA). Chained onto the activity it guards, it attaches a
// `<bpmn:boundaryEvent … attachedToRef=… ><bpmn:timerEventDefinition>` to that
// activity: when the timer elapses the activity is cancelled (interrupting) and
// the token routes to the `onTimeout` escalation body, which then converges with
// the activity's normal continuation. Contributed entirely from this module
// through the extension seam (epic #314, S2/#317) — NO edit to the shared
// `FlowNode` union, the `walkNodes`/`emitNode` dispatch, or the generated barrel.

import type { FlowNode } from "../types.js";
import type { Block, Edge } from "../declarative.js";
import { outgoingOnly } from "../declarative.js";
import { assertTimerDuration, escapeXml } from "../xml.js";
import { registerNodeKind } from "./registry.js";

/** Options for `.boundary(...)`: an attached timer SLA on the preceding activity.
 *  - `timer` — the timeout: an ISO-8601 duration (`PT24H`, `P1DT6H`) or a FEEL
 *    `=`-expression (`=escalationSlaTimeout`); the duration need not be a literal.
 *  - `onTimeout` — the escalation body run when the timer elapses (its danglers
 *    converge with the activity's normal continuation).
 *  - `interrupting` — whether firing cancels the host activity. Defaults to
 *    `true` (an interrupting boundary; `cancelActivity` omitted, the BPMN default).
 *    Pass `false` for a non-interrupting boundary (`cancelActivity="false"`).
 *  - `name` — an optional label for the boundary event. */
export interface BoundaryOptions<C extends object = object> {
  timer: string;
  onTimeout: Block<C>;
  interrupting?: boolean;
  name?: string;
}

declare module "../types.js" {
  interface FlowNodeRegistry {
    boundary: {
      kind: "boundary";
      /** The derived element id of the activity this boundary attaches to. */
      attachedTo: string;
      /** The timeout — an ISO-8601 duration or a FEEL `=`-expression. */
      timer: string;
      /** Whether firing cancels the host (interrupting). */
      interrupting: boolean;
      /** The escalation body wired from the boundary event's outgoing flow. */
      onTimeout: FlowNode[];
      /** Optional boundary-event label. */
      label?: string;
    };
  }
}

declare module "../declarative.js" {
  interface FlowBuilder<C extends object> {
    /**
     * Attach an interrupting timer boundary event (an SLA) to the PRECEDING
     * activity (a `run`/`task`/`human`). When `timer` elapses, the activity is
     * cancelled (for an interrupting boundary) and the token routes to the
     * `onTimeout` escalation body; that body then converges with the activity's
     * normal continuation. `timer` is an ISO-8601 duration or a FEEL
     * `=`-expression. Chains as `w.run(...).boundary({ timer, onTimeout })`.
     */
    boundary(opts: BoundaryOptions<C>): FlowBuilder<C>;
  }
}

/** True for a FEEL expression body (a leading `=`), which renders with an
 *  `xsi:type="bpmn:tFormalExpression"` marker on the `timeDuration`. */
function isFeel(value: string): boolean {
  return value.startsWith("=");
}

function renderBoundary(id: string, node: Extract<FlowNode, { kind: "boundary" }>, outg: string[]): string {
  const nameAttr = node.label ? ` name="${escapeXml(node.label)}"` : "";
  // An interrupting boundary omits `cancelActivity` (its BPMN default is true),
  // matching the hand-authored nwf goldens; a non-interrupting one is explicit.
  const cancelAttr = node.interrupting ? "" : ` cancelActivity="false"`;
  const durType = isFeel(node.timer) ? ` xsi:type="bpmn:tFormalExpression"` : "";
  return (
    `    <bpmn:boundaryEvent id="${id}"${nameAttr} attachedToRef="${escapeXml(node.attachedTo)}"${cancelAttr}>\n` +
    `      ${outgoingOnly(outg)}\n` +
    `      <bpmn:timerEventDefinition>\n` +
    `        <bpmn:timeDuration${durType}>${escapeXml(node.timer)}</bpmn:timeDuration>\n` +
    `      </bpmn:timerEventDefinition>\n` +
    `    </bpmn:boundaryEvent>`
  );
}

registerNodeKind("boundary", {
  build: (api) => (opts: BoundaryOptions) => {
    if (!opts || typeof opts !== "object") {
      throw new Error(`boundary(...) needs { timer, onTimeout }`);
    }
    if (typeof opts.timer !== "string" || opts.timer.trim() === "") {
      throw new Error(`boundary(...) needs a { timer } duration (an ISO-8601 duration or a FEEL =expression)`);
    }
    const duration = opts.timer.trim();
    assertTimerDuration("boundary(...) timer", duration);
    if (typeof opts.onTimeout !== "function") {
      throw new Error(`boundary(...) needs an { onTimeout } escalation body (b) => {…}`);
    }
    if (opts.interrupting !== undefined && typeof opts.interrupting !== "boolean") {
      throw new Error(`boundary(...) { interrupting } must be a boolean`);
    }
    if (opts.name !== undefined && typeof opts.name !== "string") {
      throw new Error(`boundary(...) { name } must be a string`);
    }
    const host = api.out[api.out.length - 1];
    if (!host) {
      throw new Error(`boundary(...) must follow the activity it attaches to (e.g. w.run(...).boundary(...))`);
    }
    if (!("name" in host) || typeof host.name !== "string") {
      throw new Error(`boundary(...) can only attach to a named activity (run/task/human), not a "${host.kind}"`);
    }
    api.out.push({
      kind: "boundary",
      attachedTo: host.name,
      timer: duration,
      interrupting: opts.interrupting ?? true,
      onTimeout: api.child(opts.onTimeout, false),
      label: opts.name,
    });
    return api.self();
  },
  walk: (node, recurse) => {
    recurse(node.onTimeout);
  },
  emit: (node, incoming, loop, api) => {
    // A boundary event has NO incoming sequence flow — it attaches to its host
    // via `attachedToRef`. Place it, wire its outgoing to the escalation body,
    // and return the host's normal continuation (`incoming`, passed through)
    // PLUS the escalation danglers, so both converge on whatever follows.
    const beId = `Be_${api.nextGw()}`;
    api.addNode({
      id: beId,
      render: (_inc, outg) => renderBoundary(beId, node, outg),
    });
    const escalation: Edge = api.newEdge(beId);
    const escOut = api.emitList(node.onTimeout, [escalation], loop);
    return [...incoming, ...escOut];
  },
});
