// Built-in flow-node kind: `loop` — a durable loop (a back-edge to the loop
// head): the body runs, then control returns to the top unless a branch calls
// `break()`. Contributed through the extension seam (epic #314, S0/#315).

import type { FlowNode } from "../types.js";
import type { Block, LoopCtx } from "../declarative.js";
import { registerNodeKind } from "./registry.js";

declare module "../types.js" {
  interface FlowNodeRegistry {
    loop: { kind: "loop"; body: FlowNode[] };
  }
}

registerNodeKind("loop", {
  build: (api) => (body: Block) => {
    if (typeof body !== "function") throw new Error(`loop() needs a body function`);
    api.out.push({ kind: "loop", body: api.child(body, true) });
    return api.self();
  },
  walk: (node, recurse) => recurse(node.body),
  emit: (node, incoming, _loop, api) => {
    const headId = `Loop_${api.nextGw()}`;
    api.addGateway(headId);
    api.connect(incoming, headId);
    const ctx: LoopCtx = { headId, breaks: [] };
    const headOut = api.newEdge(headId);
    const bodyOut = api.emitList(node.body, [headOut], ctx);
    // Normal fall-through of the body loops back to the head (continue).
    api.connect(bodyOut, headId);
    // The loop exits only via break edges.
    return ctx.breaks;
  },
});
