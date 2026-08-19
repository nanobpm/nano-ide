// Built-in flow-node kind: `branch` — a two-way exclusive choice on a FEEL
// boolean condition (a BPMN exclusive gateway); the `then` arm is guarded, the
// `else` arm is the gateway default. Contributed through the extension seam.

import type { FlowNode } from "../types.js";
import type { Block } from "../declarative.js";
import { feel } from "../declarative.js";
import { registerNodeKind } from "./registry.js";

declare module "../types.js" {
  interface FlowNodeRegistry {
    branch: { kind: "branch"; condition: string; then: FlowNode[]; else?: FlowNode[] };
  }
}

registerNodeKind("branch", {
  build: (api) => (condition: string, arms: { then: Block; else?: Block }) => {
    if (typeof condition !== "string" || condition.trim() === "") {
      throw new Error(`branch() needs a non-empty FEEL condition`);
    }
    if (!arms || typeof arms.then !== "function") throw new Error(`branch("${condition}") needs a then arm`);
    if (arms.else !== undefined && typeof arms.else !== "function") {
      throw new Error(`branch("${condition}") else arm must be a block (b) => {…}`);
    }
    api.out.push({
      kind: "branch",
      condition,
      then: api.child(arms.then, false),
      else: arms.else ? api.child(arms.else, false) : undefined,
    });
    return api.self();
  },
  walk: (node, recurse) => {
    recurse(node.then);
    if (node.else) recurse(node.else);
  },
  emit: (node, incoming, loop, api) => {
    const id = `Gw_${api.nextGw()}`;
    const gw = api.addGateway(id);
    api.connect(incoming, id);
    const te = api.newEdge(id, { condition: feel(node.condition), name: "then" });
    const out = api.emitList(node.then, [te], loop);
    const ee = api.newEdge(id, { name: "else" });
    gw.defaultFlow = ee.id;
    out.push(...api.emitList(node.else ?? [], [ee], loop));
    return out;
  },
});
