// Flow-node kind: `boundary` — an activity-level attached timer boundary event
// (an SLA). Chained onto the activity it guards, it attaches a
// `<bpmn:boundaryEvent … attachedToRef=… ><bpmn:timerEventDefinition>` to that
// activity: when the timer elapses the boundary fires and the token routes to
// the `onTimeout` escalation body (and, for an interrupting boundary — the
// default — the host activity is cancelled; a non-interrupting boundary leaves
// it running). By default the escalation body then converges with
// the activity's normal continuation — OR, with `fireAndForget: true`, ends in a
// `<bpmn:endEvent>` without converging (a non-converging escape path). Contributed
// entirely from this module through the extension seam (epic #314, S2/#317) — NO
// edit to the shared `FlowNode` union, the `walkNodes`/`emitNode` dispatch, or the
// generated barrel.

import type { FlowNode } from "../types.js";
import type { Block, Edge } from "../declarative.js";
import { outgoingOnly } from "../declarative.js";
import { assertTimerDuration, escapeXml } from "../xml.js";
import { registerNodeKind } from "./registry.js";

/** Options for `.boundary(...)`: an attached timer SLA on the preceding activity.
 *  - `timer` — the timeout: an ISO-8601 duration (`PT24H`, `P1DT6H`) or a FEEL
 *    `=`-expression (`=escalationSlaTimeout`); the duration need not be a literal.
 *  - `onTimeout` — the escalation body run when the timer elapses. By default its
 *    danglers converge with the activity's normal continuation; with
 *    `fireAndForget: true` the body is capped by an end event instead (see below).
 *  - `interrupting` — whether firing cancels the host activity. Defaults to
 *    `true` (an interrupting boundary; `cancelActivity` omitted, the BPMN default).
 *    Pass `false` for a non-interrupting boundary (`cancelActivity="false"`).
 *  - `fireAndForget` — when `true`, the `onTimeout` escalation body is a
 *    NON-CONVERGING escape path: its danglers terminate in a `<bpmn:endEvent>`
 *    rather than merging back into the host activity's continuation. This is the
 *    correct model for a non-interrupting reviewer nudge (an SLA side-effect that
 *    ends its own token and must NOT re-enter the reviewed activity). Defaults to
 *    `false` (the converging boundary). Typically paired with
 *    `interrupting: false`.
 *  - `name` — an optional label for the boundary event. */
export interface BoundaryOptions<C extends object = object> {
  timer: string;
  onTimeout: Block<C>;
  interrupting?: boolean;
  fireAndForget?: boolean;
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
      /** When true, the escalation body is capped by an end event and does NOT
       *  converge with the host activity's continuation (fire-and-forget). */
      fireAndForget: boolean;
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
     * activity (a `run`/`task`). When `timer` elapses, the activity is
     * cancelled (for an interrupting boundary) and the token routes to the
     * `onTimeout` escalation body; that body then converges with the activity's
     * normal continuation. `timer` is an ISO-8601 duration or a FEEL
     * `=`-expression. Chains as `w.run(...).boundary({ timer, onTimeout })`.
     *
     * Pass `fireAndForget: true` for a NON-CONVERGING escape path: the
     * `onTimeout` body is capped by a `<bpmn:endEvent>` and contributes no
     * danglers to the host continuation — the correct model for a
     * non-interrupting reviewer nudge (typically with `interrupting: false`).
     */
    boundary(opts: BoundaryOptions<C>): FlowBuilder<C>;
  }
}

/** The flow-node kinds a boundary event may attach to. BPMN restricts boundary
 *  events to ACTIVITIES, so this is the set of activity kinds (the ones that
 *  render as a `<bpmn:serviceTask>`) — NOT merely "any node with a `name`", which
 *  would also admit catch events like `signal`/`timer` and produce invalid BPMN. */
const BOUNDARY_HOST_KINDS = new Set(["run", "task"]);

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
    if (opts.fireAndForget !== undefined && typeof opts.fireAndForget !== "boolean") {
      throw new Error(`boundary(...) { fireAndForget } must be a boolean`);
    }
    if (opts.name !== undefined && typeof opts.name !== "string") {
      throw new Error(`boundary(...) { name } must be a string`);
    }
    const host = api.out[api.out.length - 1];
    if (!host) {
      throw new Error(`boundary(...) must follow the activity it attaches to (e.g. w.run(...).boundary(...))`);
    }
    if (!BOUNDARY_HOST_KINDS.has(host.kind) || !("name" in host) || typeof host.name !== "string") {
      throw new Error(`boundary(...) can only attach to a named activity (run/task), not a "${host.kind}"`);
    }
    const onTimeout = api.child(opts.onTimeout, false);
    if (onTimeout.length === 0) {
      throw new Error(`boundary(...) needs a non-empty { onTimeout } escalation body (its outgoing flow has nowhere to go)`);
    }
    api.out.push({
      kind: "boundary",
      attachedTo: host.name,
      timer: duration,
      interrupting: opts.interrupting ?? true,
      fireAndForget: opts.fireAndForget ?? false,
      onTimeout,
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
    // then either converge or fire-and-forget (see below).
    const beId = `Be_${api.nextGw()}`;
    api.addNode({
      id: beId,
      render: (_inc, outg) => renderBoundary(beId, node, outg),
    });
    const escalation: Edge = api.newEdge(beId);
    const escOut = api.emitList(node.onTimeout, [escalation], loop);
    if (node.fireAndForget) {
      // Fire-and-forget: cap the escalation body with a plain `<bpmn:endEvent>` so
      // its token ENDS instead of converging into the host activity's
      // continuation. Return only `incoming` (the host's own danglers), so the
      // escape path contributes nothing to whatever follows the activity — no
      // spurious second incoming on the reviewed task / downstream gateway.
      if (escOut.length > 0) {
        const endId = `${beId}_End`;
        api.addPlainEnd(endId);
        api.connect(escOut, endId);
      }
      return [...incoming];
    }
    // Converging boundary: return the host's normal continuation (`incoming`)
    // PLUS the escalation danglers, so both converge on whatever follows.
    return [...incoming, ...escOut];
  },
});
