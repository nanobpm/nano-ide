// Built-in flow-node kind: `forEach` — a data-driven fan-out over a runtime
// collection (a BPMN parallel/sequential multi-instance activity). A single
// service-task body lifts the MI characteristics directly; a multi-step body is
// wrapped in an embedded MI sub-process. Contributed through the extension seam.

import type { FlowNode } from "../types.js";
import type { Block } from "../declarative.js";
import { assertIdent, escapeXml } from "../xml.js";
import { registerNodeKind } from "./registry.js";

/** The `forEach` node shape (its `FlowNode` variant). */
interface ForEachNode {
  kind: "forEach";
  /** FEEL expression evaluating to the list to fan out over. */
  collection: string;
  /** Variable each item is bound to in the child's scope (`inputElement`). */
  itemVar: string;
  body: FlowNode[];
  /** Run children one at a time (sequential MI) instead of all at once. */
  sequential?: boolean;
  /** List variable that each child's `outputElement` is collected into. */
  outputCollection?: string;
  /** FEEL expression producing each child's contribution to `outputCollection`. */
  outputElement?: string;
  /** FEEL boolean that, once true, completes the body early. */
  completionCondition?: string;
}

declare module "../types.js" {
  interface FlowNodeRegistry {
    forEach: ForEachNode;
  }
}

interface ForEachOpts {
  sequential?: boolean;
  outputCollection?: string;
  outputElement?: string;
  completionCondition?: string;
}

/** The `<bpmn:multiInstanceLoopCharacteristics>` block for a `forEach` node — the
 *  same shape whether lifted onto a leaf service task or a sub-process. */
function miCharacteristics(node: ForEachNode): string {
  const seq = node.sequential ? "true" : "false";
  const attrs = [
    `inputCollection="${escapeXml(`=${node.collection}`)}"`,
    `inputElement="${escapeXml(node.itemVar)}"`,
  ];
  if (node.outputCollection) attrs.push(`outputCollection="${escapeXml(node.outputCollection)}"`);
  if (node.outputElement) attrs.push(`outputElement="${escapeXml(`=${node.outputElement}`)}"`);
  const completion = node.completionCondition
    ? `      <bpmn:completionCondition>${escapeXml(`=${node.completionCondition}`)}</bpmn:completionCondition>\n`
    : "";
  return (
    `      <bpmn:multiInstanceLoopCharacteristics isSequential="${seq}">\n` +
    `        <bpmn:extensionElements>\n` +
    `          <zeebe:loopCharacteristics ${attrs.join(" ")} />\n` +
    `        </bpmn:extensionElements>\n` +
    completion +
    `      </bpmn:multiInstanceLoopCharacteristics>\n`
  );
}

registerNodeKind("forEach", {
  build: (api) => (collection: string, itemVar: string, body: Block, opts?: ForEachOpts) => {
    if (typeof collection !== "string" || collection.trim() === "") {
      throw new Error(`forEach() needs a non-empty FEEL collection expression`);
    }
    // Authors may paste a leading "=" (common in Zeebe FEEL examples). Strip it
    // so the emitter's own "=" prefix never produces an invalid "==...".
    const collExpr = collection.trim().replace(/^=/, "").trim();
    if (collExpr === "") {
      throw new Error(`forEach() collection expression is empty after stripping the leading "="`);
    }
    assertIdent("forEach itemVar", itemVar);
    if (typeof body !== "function") throw new Error(`forEach("${itemVar}") needs a body function`);
    const nodes = api.childScoped(body);
    if (nodes.length === 0) throw new Error(`forEach("${itemVar}") body declared no steps`);
    const node: ForEachNode = { kind: "forEach", collection: collExpr, itemVar, body: nodes };
    if (opts?.sequential) node.sequential = true;
    if (opts?.outputCollection !== undefined) {
      assertIdent("forEach outputCollection", opts.outputCollection);
      node.outputCollection = opts.outputCollection;
    }
    if (opts?.outputElement !== undefined) {
      if (typeof opts.outputElement !== "string" || opts.outputElement.trim() === "") {
        throw new Error(`forEach("${itemVar}") outputElement must be a non-empty FEEL expression`);
      }
      const outEl = opts.outputElement.trim().replace(/^=/, "").trim();
      if (outEl === "") {
        throw new Error(`forEach("${itemVar}") outputElement is empty after stripping the leading "="`);
      }
      node.outputElement = outEl;
    }
    if (opts?.completionCondition !== undefined) {
      if (typeof opts.completionCondition !== "string" || opts.completionCondition.trim() === "") {
        throw new Error(`forEach("${itemVar}") completionCondition must be a non-empty FEEL expression`);
      }
      const compCond = opts.completionCondition.trim().replace(/^=/, "").trim();
      if (compCond === "") {
        throw new Error(`forEach("${itemVar}") completionCondition is empty after stripping the leading "="`);
      }
      node.completionCondition = compCond;
    }
    if (node.outputElement && !node.outputCollection) {
      throw new Error(`forEach("${itemVar}") outputElement needs an outputCollection to collect into`);
    }
    api.out.push(node);
    return api.self();
  },
  walk: (node, recurse) => recurse(node.body),
  emit: (node, incoming, _loop, api) => {
    const mi = miCharacteristics(node);
    const only = node.body.length === 1 ? node.body[0] : undefined;
    // A single service-task body carries the MI characteristics directly; a
    // multi-step body is wrapped in an embedded MI sub-process (its own token
    // scope, with its own start/end). A prompt-carrying `task` is deliberately
    // EXCLUDED from this fast path: computing its `zeebe:linkedResources`/
    // `appendPrompt` delta lives in the `task` kind's own emitter, so lifting it
    // here would silently drop that binding. It falls through to the sub-process
    // path, where the `task` emitter renders the agent service task (prompt
    // intact) inside the MI scope.
    if (only && (only.kind === "run" || (only.kind === "task" && only.prompt === undefined))) {
      api.addServiceTask(only, { mi });
      api.connect(incoming, only.name);
      return [api.newEdge(only.name)];
    }
    const subId = `Sub_${api.nextGw()}`;
    api.addSubProcess(subId, mi);
    api.connect(incoming, subId);
    api.pushScope(subId);
    const startId = `${subId}_start`;
    api.addPlainStart(startId);
    const innerOut = api.emitList(node.body, [api.newEdge(startId)], null);
    const endId = `${subId}_end`;
    api.addPlainEnd(endId);
    api.connect(innerOut, endId);
    api.popScope();
    return [api.newEdge(subId)];
  },
});
