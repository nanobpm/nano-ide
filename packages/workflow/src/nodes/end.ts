// Built-in flow-node kind: `end` — end this path here (a BPMN none end event), or,
// with `{ terminate: true }`, end the whole instance at once (a BPMN terminate end
// event). Lets a branch finish the flow early from inside a `switch`/`branch`/`race`/
// `loop`/`boundary` body without threading a flag back to the top level.
// Contributed through the extension seam.

import { escapeXml } from "../xml.js";
import { registerNodeKind } from "./registry.js";

declare module "../types.js" {
  interface FlowNodeRegistry {
    /** `name` is the element id when given; otherwise one is generated at emit. */
    end: { kind: "end"; name?: string; terminate: boolean };
  }
}

/** Options for {@link FlowBuilder.end}. */
export interface EndOptions {
  /** End the WHOLE instance, cancelling every other active path (parallel
   *  branches, waits, jobs), not just this one — a BPMN terminate end event.
   *  Inside a `forEach` body it ends that item's child only. Default `false`. */
  terminate?: boolean;
}

declare module "../declarative.js" {
  interface FlowBuilder<C extends object> {
    /**
     * End this path here (a BPMN end event). Nothing may follow it in the same
     * block. Without `terminate`, only this token ends: other active paths keep
     * running and the instance completes when the last one ends. With
     * `{ terminate: true }`, the whole instance ends at once and every other
     * active path is cancelled. `name` is the element id (optional; a generated
     * `End_<n>` otherwise).
     * ```ts
     * w.switch("decision", {
     *   abandon: (b) => b.run("close-pr", closePr).end("abandoned", { terminate: true }),
     *   default: (b) => b.run("merge", merge),
     * });
     * ```
     * A plain `end()` inside a `parallel` branch is rejected: the AND-join would
     * wait for that branch forever. Use `{ terminate: true }` there.
     */
    end(name?: string, opts?: EndOptions): FlowBuilder<C>;
    /** `w.end({ terminate: true })` — an unnamed end with options. */
    end(opts: EndOptions): FlowBuilder<C>;
  }
}

registerNodeKind("end", {
  build: (api) => (name?: string | EndOptions, opts?: EndOptions) => {
    // `w.end({ terminate: true })` — options without a name.
    if (name !== undefined && typeof name === "object") {
      opts = name;
      name = undefined;
    }
    if (opts !== undefined && (opts === null || typeof opts !== "object")) {
      throw new Error(`end() options must be an object like { terminate: true }`);
    }
    // Default only an omitted (`undefined`) value: an explicit `null` is a
    // supplied value and must fail the boolean check, not silently coerce to
    // `false` and emit a normal end event.
    const terminate = opts?.terminate === undefined ? false : opts.terminate;
    if (typeof terminate !== "boolean") throw new Error(`end() { terminate } must be true or false`);
    if (name !== undefined) {
      if (typeof name !== "string") throw new Error(`end() name must be a string`);
      api.claim(name);
      api.out.push({ kind: "end", name, terminate });
    } else {
      api.out.push({ kind: "end", terminate });
    }
    return api.self();
  },
  emit: (node, incoming, _loop, api) => {
    // A generated id must not collide with the process id (a flow may be named `End_0`).
    let id = node.name ?? `End_${api.nextGw()}`;
    while (node.name === undefined && id === api.flowId) id = `End_${api.nextGw()}`;
    api.addNode({
      id,
      render: (inc) =>
        node.terminate
          ? `    <bpmn:endEvent id="${escapeXml(id)}">\n` +
            inc.map((f) => `      <bpmn:incoming>${escapeXml(f)}</bpmn:incoming>\n`).join("") +
            `      <bpmn:terminateEventDefinition />\n` +
            `    </bpmn:endEvent>`
          : `    <bpmn:endEvent id="${escapeXml(id)}">` +
            inc.map((f) => `<bpmn:incoming>${escapeXml(f)}</bpmn:incoming>`).join("") +
            `</bpmn:endEvent>`,
    });
    api.connect(incoming, id);
    // The path stops here: nothing dangles for a continuation to attach to.
    return [];
  },
});
