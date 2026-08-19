// Built-in flow-node kind: `timer` — a durable wait for a point in time (a BPMN
// timer intermediate catch event): exactly one of `{ after }` (a delay) or
// `{ at }` (an instant). Contributed through the extension seam (epic #314).

import type { TimerAt } from "../types.js";
import { assertTimerDate, assertTimerDuration } from "../xml.js";
import { registerNodeKind } from "./registry.js";

declare module "../types.js" {
  interface FlowNodeRegistry {
    timer: { kind: "timer"; name: string } & TimerAt;
  }
}

registerNodeKind("timer", {
  build: (api) => (name: string, opts: { after: string } | { at: string }) => {
    api.claim(name);
    const hasAfter = "after" in opts && typeof opts.after === "string";
    const hasAt = "at" in opts && typeof opts.at === "string";
    if (hasAfter === hasAt) {
      throw new Error(`timer("${name}") needs exactly one of { after } (a delay) or { at } (an instant)`);
    }
    if ("after" in opts) {
      const after = opts.after.trim();
      assertTimerDuration(`timer("${name}") after`, after);
      api.out.push({ kind: "timer", name, after });
    } else {
      const at = opts.at.trim();
      assertTimerDate(`timer("${name}") at`, at);
      api.out.push({ kind: "timer", name, at });
    }
    return api.self();
  },
  emit: (node, incoming, _loop, api) => {
    api.addTimerCatchEvent(node);
    api.connect(incoming, node.name);
    return [api.newEdge(node.name)];
  },
});
