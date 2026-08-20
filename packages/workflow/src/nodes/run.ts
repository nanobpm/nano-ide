// Built-in flow-node kind: `run` — a durable service task served by a worker
// THIS program hosts (its handler runs in the in-process `Worker`). Contributed
// entirely from this module through the extension seam (epic #314, S0/#315):
// its `FlowNode` variant, its `w.run(...)` builder method, and its walk/emit
// handlers — with NO edit to the shared union or a central dispatch switch.

import type { NodeEnvelopes, StepHandler } from "../types.js";
import { assertIoMapping, renderIoMapping } from "../io-mapping.js";
import type { HumanIoMapping } from "../io-mapping.js";
import { registerNodeKind } from "./registry.js";

declare module "../types.js" {
  interface FlowNodeRegistry {
    run: { kind: "run"; name: string; envelopes?: NodeEnvelopes; io?: HumanIoMapping };
  }
}

registerNodeKind("run", {
  build: (api) => (name: string, handler: StepHandler, opts?: { io?: HumanIoMapping }) => {
    api.claim(name);
    if (typeof handler !== "function") throw new Error(`run("${name}") needs a handler function`);
    assertIoMapping(`run("${name}")`, opts?.io);
    api.handlers[name] = handler;
    api.out.push({ kind: "run", name, envelopes: api.contractEnvelopes(name), io: opts?.io });
    return api.self();
  },
  emit: (node, incoming, _loop, api) => {
    api.addServiceTask(node, node.io !== undefined ? { extraExt: renderIoMapping(node.io) } : {});
    api.connect(incoming, node.name);
    return [api.newEdge(node.name)];
  },
});
