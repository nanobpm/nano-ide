// Built-in flow-node kind: `switch` — a multi-way exclusive choice (a BPMN
// exclusive gateway); each case routes when `subject` equals the case value, with
// an optional unconditional `default`. Contributed through the extension seam.

import type { FlowNode, SwitchCase } from "../types.js";
import type { Block, Edge } from "../declarative.js";
import { feelEquals } from "../declarative.js";
import { registerNodeKind } from "./registry.js";

declare module "../types.js" {
  interface FlowNodeRegistry {
    switch: { kind: "switch"; subject: string; cases: SwitchCase[]; default?: FlowNode[] };
  }
}

registerNodeKind("switch", {
  build: (api) => (subject: string, cases: Record<string, Block> & { default?: Block }) => {
    if (typeof subject !== "string" || subject.trim() === "") {
      throw new Error(`switch() needs a non-empty subject expression`);
    }
    if (cases === null || typeof cases !== "object") {
      throw new Error(`switch("${subject}") needs a cases object { value: (b) => {…} }`);
    }
    const caseNodes: SwitchCase[] = [];
    for (const [value, fn] of Object.entries(cases)) {
      if (value === "default") continue;
      if (typeof fn !== "function") throw new Error(`switch("${subject}") cases must be blocks (b) => {…}`);
      caseNodes.push({ value, body: api.child(fn, false) });
    }
    if (caseNodes.length === 0) throw new Error(`switch("${subject}") needs at least one case`);
    if (cases.default !== undefined && typeof cases.default !== "function") {
      throw new Error(`switch("${subject}") default must be a block (b) => {…}`);
    }
    const def = cases.default ? api.child(cases.default, false) : undefined;
    api.out.push({ kind: "switch", subject, cases: caseNodes, default: def });
    return api.self();
  },
  walk: (node, recurse) => {
    for (const c of node.cases) recurse(c.body);
    if (node.default) recurse(node.default);
  },
  emit: (node, incoming, loop, api) => {
    const id = `Gw_${api.nextGw()}`;
    const gw = api.addGateway(id, node.subject);
    api.connect(incoming, id);
    const out: Edge[] = [];
    for (const c of node.cases) {
      const e = api.newEdge(id, { condition: feelEquals(node.subject, c.value), name: c.value });
      out.push(...api.emitList(c.body, [e], loop));
    }
    const de = api.newEdge(id, { name: "default" });
    gw.defaultFlow = de.id;
    out.push(...api.emitList(node.default ?? [], [de], loop));
    return out;
  },
});
