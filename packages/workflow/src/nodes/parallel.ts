// Built-in flow-node kind: `parallel` — a static parallel fork/join (a pair of
// BPMN parallel gateways): every block runs concurrently on its own branch, and
// control continues only once ALL branches reach the AND-join. Contributed
// through the extension seam (epic #314, S0/#315).

import type { FlowNode } from "../types.js";
import type { Block } from "../declarative.js";
import { registerNodeKind, requireNodeKind } from "./registry.js";

/** Whether this subtree has a plain (non-terminate) `end()` that would end a
 *  parallel branch's token — not looking inside a `forEach` body, whose own
 *  sub-process scope such an `end()` ends instead. */
function hasPlainEnd(list: FlowNode[]): boolean {
  let found = false;
  const visit = (nodes: FlowNode[]) => {
    for (const n of nodes) {
      if (found) return;
      if (n.kind === "end" && !n.terminate) found = true;
      else if (n.kind !== "forEach") requireNodeKind(n.kind).walk?.(n, visit);
    }
  };
  visit(list);
  return found;
}

declare module "../types.js" {
  interface FlowNodeRegistry {
    parallel: { kind: "parallel"; branches: FlowNode[][] };
  }
}

registerNodeKind("parallel", {
  build: (api) => (branches: Block[]) => {
    if (!Array.isArray(branches) || branches.length < 2) {
      throw new Error(`parallel() needs at least two branch blocks`);
    }
    for (const fn of branches) {
      if (typeof fn !== "function") throw new Error(`parallel() branches must all be blocks (b) => {…}`);
    }
    // Each branch runs in its own token scope up to the AND-join, so a
    // `break`/`continue` must not escape into an enclosing loop. Scope branches
    // (loopDepth resets to 0) so cross-boundary break/continue is rejected.
    const bodies = branches.map((fn) => api.childScoped(fn));
    if (bodies.some(hasPlainEnd)) {
      throw new Error(
        `parallel(): a branch can't end() on its own — the join would wait for it forever. ` +
          `Use end({ terminate: true }) to end the whole instance, or let the branch reach the join`,
      );
    }
    api.out.push({ kind: "parallel", branches: bodies });
    return api.self();
  },
  walk: (node, recurse) => {
    for (const branch of node.branches) recurse(branch);
  },
  emit: (node, incoming, loop, api) => {
    // A diverging parallel gateway forks a token onto every branch; a converging
    // one joins them (AND-join) into a single continuation.
    const splitId = `Gw_${api.nextGw()}`;
    api.addParallelGateway(splitId);
    api.connect(incoming, splitId);
    const joinId = `Gw_${api.nextGw()}`;
    api.addParallelGateway(joinId);
    for (const branch of node.branches) {
      const e = api.newEdge(splitId);
      const branchOut = api.emitList(branch, [e], loop);
      api.connect(branchOut, joinId);
    }
    return [api.newEdge(joinId)];
  },
});
