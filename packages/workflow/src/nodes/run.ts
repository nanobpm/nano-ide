// Built-in flow-node kind: `run` — a durable service task served by a worker
// THIS program hosts (its handler runs in the in-process `Worker`). Contributed
// entirely from this module through the extension seam (epic #314, S0/#315):
// its `FlowNode` variant, its `w.run(...)` builder method, and its walk/emit
// handlers — with NO edit to the shared union or a central dispatch switch.

import type { NodeEnvelopes, StepHandler } from "../types.js";
import { registerNodeKind } from "./registry.js";

declare module "../types.js" {
  interface FlowNodeRegistry {
    run: { kind: "run"; name: string; envelopes?: NodeEnvelopes };
  }
}

registerNodeKind("run", {
  build: (api) => (name: string, handler: StepHandler) => {
    api.claim(name);
    if (typeof handler !== "function") throw new Error(`run("${name}") needs a handler function`);
    api.handlers[name] = handler;
    api.out.push({ kind: "run", name, envelopes: api.contractEnvelopes(name) });
    return api.self();
  },
  emit: (node, incoming, _loop, api) => {
    api.addServiceTask(node);
    api.connect(incoming, node.name);
    return [api.newEdge(node.name)];
  },
});
