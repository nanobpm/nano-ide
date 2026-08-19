// Built-in flow-node kind: `signal` — a durable wait for an external/human event
// correlated on a process variable (a BPMN message intermediate catch event).
// Contributed from this module through the extension seam (epic #314, S0/#315).

import type { Envelope } from "../envelope.js";
import { assertIdent } from "../xml.js";
import { registerNodeKind } from "./registry.js";

declare module "../types.js" {
  interface FlowNodeRegistry {
    signal: { kind: "signal"; name: string; correlationKey: string; payload?: Envelope };
  }
}

registerNodeKind("signal", {
  build: (api) => (name: string, opts: { correlationKey: string }) => {
    api.claim(name);
    if (!opts || typeof opts.correlationKey !== "string" || opts.correlationKey.trim() === "") {
      throw new Error(`signal("${name}") needs { correlationKey }`);
    }
    // Trim before validating/storing, in parity with the race() signal arm: a
    // value like " prKey " is usable after trimming, so it must not fail the
    // NCName check on stray whitespace. Name the node in the assertIdent context.
    const correlationKey = opts.correlationKey.trim();
    assertIdent(`signal("${name}") correlationKey`, correlationKey);
    api.out.push({ kind: "signal", name, correlationKey, payload: api.contracts[name]?.in });
    return api.self();
  },
  emit: (node, incoming, _loop, api) => {
    api.addCatchEvent(node);
    api.connect(incoming, node.name);
    api.recordEnvelope(node.payload);
    return [api.newEdge(node.name)];
  },
});
