// Built-in flow-node kind: `continue` — jump straight back to the top of the
// enclosing loop, skipping the rest of the body. Only valid inside a `loop`.
// Contributed through the extension seam (epic #314, S0/#315).

import { registerNodeKind } from "./registry.js";

declare module "../types.js" {
  interface FlowNodeRegistry {
    continue: { kind: "continue" };
  }
}

registerNodeKind("continue", {
  build: (api) => () => {
    if (api.loopDepth === 0) throw new Error(`continue() is only valid inside a loop`);
    api.out.push({ kind: "continue" });
    return api.self();
  },
  emit: (_node, incoming, loop, api) => {
    if (!loop) throw new Error(`continue outside a loop in flow "${api.flowId}"`);
    api.connect(incoming, loop.headId);
    return [];
  },
});
