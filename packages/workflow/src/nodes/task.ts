// Built-in flow-node kind: `task` — a durable service task served by a worker
// OUTSIDE this program (no locally-hosted handler). Its job type defaults to the
// derived `${flowId}:${name}` unless overridden with `{ jobType }`. Contributed
// from this module through the extension seam (epic #314, S0/#315).

import type { NodeEnvelopes } from "../types.js";
import { assertJobType } from "../xml.js";
import { registerNodeKind } from "./registry.js";

declare module "../types.js" {
  interface FlowNodeRegistry {
    task: { kind: "task"; name: string; envelopes?: NodeEnvelopes; jobType?: string };
  }
}

registerNodeKind("task", {
  build: (api) => (name: string, opts?: { jobType?: string }) => {
    api.claim(name);
    const override = opts?.jobType;
    if (override !== undefined) assertJobType("task jobType", override);
    api.out.push({ kind: "task", name, envelopes: api.contractEnvelopes(name), jobType: override });
    return api.self();
  },
  emit: (node, incoming, _loop, api) => {
    api.addServiceTask(node);
    api.connect(incoming, node.name);
    return [api.newEdge(node.name)];
  },
});
