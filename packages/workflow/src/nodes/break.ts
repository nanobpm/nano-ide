// Built-in flow-node kind: `break` — exit the enclosing loop (routes to whatever
// follows it). Only valid inside a `loop`. Contributed through the extension seam.

import { registerNodeKind } from "./registry.js";

declare module "../types.js" {
  interface FlowNodeRegistry {
    break: { kind: "break" };
  }
}

registerNodeKind("break", {
  build: (api) => () => {
    if (api.loopDepth === 0) throw new Error(`break() is only valid inside a loop`);
    api.out.push({ kind: "break" });
    return api.self();
  },
  emit: (_node, incoming, loop, api) => {
    if (!loop) throw new Error(`break outside a loop in flow "${api.flowId}"`);
    // The incoming edges (from the previous node) become the loop's exit
    // danglers; this path does not fall through.
    loop.breaks.push(...incoming);
    return [];
  },
});
