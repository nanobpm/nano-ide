// Built-in flow-node kind: `task` — a durable service task served by a worker
// OUTSIDE this program (no locally-hosted handler). Its job type defaults to the
// derived `${flowId}:${name}` unless overridden with `{ jobType }`. Contributed
// from this module through the extension seam (epic #314, S0/#315).
//
// This module also owns the AGENT PROMPT BINDING (epic #314, S4/#319): an
// optional `{ prompt }` option binds an LLM prompt resource to the worker via a
// `<zeebe:linkedResource … resourceType="GenericScript" linkName="prompt">`,
// mirroring the nano-workforce agent service tasks. The extension is contributed
// entirely from this module — the `task` node's own registered emit handler and
// its option type — WITHOUT re-opening the shared `FlowNode` union, the central
// `walkNodes`/`emitNode` dispatch, or the generated barrel.

import type { NodeEnvelopes } from "../types.js";
import { incomingOutgoing } from "../declarative.js";
import { assertJobType, escapeXml, jobType } from "../xml.js";
import { registerNodeKind } from "./registry.js";

/** Binds an LLM prompt resource to an agent service task. Emits, alongside the
 *  task's `zeebe:taskDefinition` capability token, a
 *  `<zeebe:linkedResources><zeebe:linkedResource resourceId=… bindingType=…
 *  resourceType="GenericScript" linkName="prompt"/></zeebe:linkedResources>`
 *  extension — the shape the nano-workforce agent tasks use to attach a prompt
 *  script to the worker that services the job. */
export interface PromptBinding {
  /** The `GenericScript` resource id bound as the prompt (the linkedResource
   *  `resourceId`, e.g. `"retro.md"`). Required and non-empty. */
  resourceId: string;
  /** The linkedResource `bindingType` — how the engine resolves the resource
   *  version at deploy time. Defaults to `"latest"`. */
  bindingType?: string;
  /** Optional prompt addendum: a FEEL expression (or literal) fed to the worker
   *  through a `<zeebe:ioMapping><zeebe:input source=… target="appendPrompt"/>`
   *  input, the convention the agent tasks use to append runtime context to the
   *  bound prompt. Omitted → no `ioMapping` is emitted. */
  append?: string;
}

declare module "../types.js" {
  interface FlowNodeRegistry {
    task: {
      kind: "task";
      name: string;
      envelopes?: NodeEnvelopes;
      jobType?: string;
      /** The agent prompt binding, when the task is an LLM-agent service task. */
      prompt?: PromptBinding;
    };
  }
}

declare module "../declarative.js" {
  interface FlowBuilder<C extends object> {
    /**
     * An AGENT external service task: as `task`, but additionally binds an LLM
     * `prompt` resource to the worker via a `zeebe:linkedResource`
     * (`resourceType="GenericScript" linkName="prompt"`). Pair it with a
     * `{ jobType }` capability token (e.g. `senior:retro`) so an agent pool
     * services it. `prompt.append` (optional) feeds a FEEL expression to the
     * worker through a `zeebe:ioMapping` `appendPrompt` input.
     */
    task<K extends string>(name: K, opts: { jobType?: string; prompt: PromptBinding }): FlowBuilder<C>;
  }
}

/** Normalize + validate a prompt binding at authoring time, applying the
 *  `bindingType` default. Returns a fully-resolved binding stored on the node. */
function resolvePrompt(name: string, prompt: PromptBinding): PromptBinding {
  const resourceId = prompt.resourceId;
  if (typeof resourceId !== "string" || resourceId.trim() === "") {
    throw new Error(`task("${name}") prompt.resourceId must be a non-empty string`);
  }
  const bindingType = prompt.bindingType ?? "latest";
  if (typeof bindingType !== "string" || bindingType.trim() === "") {
    throw new Error(`task("${name}") prompt.bindingType must be a non-empty string`);
  }
  const resolved: PromptBinding = { resourceId, bindingType };
  if (prompt.append !== undefined) {
    if (typeof prompt.append !== "string" || prompt.append === "") {
      throw new Error(`task("${name}") prompt.append must be a non-empty string when provided`);
    }
    resolved.append = prompt.append;
  }
  return resolved;
}

/** A `<zeebe:property>` line lifting a data envelope reference (kept in sync with
 *  the built-in service-task emitter's envelope properties, so a prompt task's
 *  envelopes serialize identically). */
const envelopeProp = (dir: "in" | "out", value: string): string =>
  `          <zeebe:property name="io.nanobpm.dataEnvelope.${dir}" value="${escapeXml(value)}" />`;

/** Render a prompt-carrying `<bpmn:serviceTask>`: the standard task-definition
 *  and envelope properties, PLUS the `zeebe:linkedResources` prompt binding and
 *  (optionally) a `zeebe:ioMapping` `appendPrompt` input. */
function renderPromptTask(
  flowId: string,
  node: { name: string; envelopes?: NodeEnvelopes; jobType?: string; prompt: PromptBinding },
  inc: string[],
  outg: string[],
): string {
  const id = node.name;
  const type = node.jobType ?? jobType(flowId, node.name);
  const props: string[] = [];
  if (node.envelopes?.in) props.push(envelopeProp("in", node.envelopes.in.name));
  if (node.envelopes?.out) props.push(envelopeProp("out", node.envelopes.out.name));
  const { resourceId, bindingType, append } = node.prompt;
  const linked =
    `        <zeebe:linkedResources>\n` +
    `          <zeebe:linkedResource resourceId="${escapeXml(resourceId)}" ` +
    `bindingType="${escapeXml(bindingType ?? "latest")}" resourceType="GenericScript" linkName="prompt" />\n` +
    `        </zeebe:linkedResources>\n`;
  const io =
    append !== undefined
      ? `        <zeebe:ioMapping>\n` +
        `          <zeebe:input source="${escapeXml(append)}" target="appendPrompt" />\n` +
        `        </zeebe:ioMapping>\n`
      : "";
  const ext =
    `      <bpmn:extensionElements>\n` +
    `        <zeebe:taskDefinition type="${escapeXml(type)}" />\n` +
    (props.length ? `        <zeebe:properties>\n${props.join("\n")}\n        </zeebe:properties>\n` : "") +
    linked +
    io +
    `      </bpmn:extensionElements>`;
  return (
    `    <bpmn:serviceTask id="${escapeXml(id)}" name="${escapeXml(id)}">\n` +
    ext +
    "\n" +
    incomingOutgoing(inc, outg) +
    `    </bpmn:serviceTask>`
  );
}

registerNodeKind("task", {
  build: (api) => (name: string, opts?: { jobType?: string; prompt?: PromptBinding }) => {
    api.claim(name);
    const override = opts?.jobType;
    if (override !== undefined) assertJobType("task jobType", override);
    const prompt = opts?.prompt !== undefined ? resolvePrompt(name, opts.prompt) : undefined;
    api.out.push({
      kind: "task",
      name,
      envelopes: api.contractEnvelopes(name),
      jobType: override,
      prompt,
    });
    return api.self();
  },
  emit: (node, incoming, _loop, api) => {
    // No prompt → the standard service-task emission is preserved unchanged (no
    // `linkedResources` are emitted).
    if (node.prompt === undefined) {
      api.addServiceTask(node);
      api.connect(incoming, node.name);
      return [api.newEdge(node.name)];
    }
    // Prompt binding present → render the agent service task with its
    // `zeebe:linkedResource` (and optional `appendPrompt` ioMapping input).
    api.recordEnvelope(node.envelopes?.in);
    api.recordEnvelope(node.envelopes?.out);
    const prompt = node.prompt;
    api.addNode({
      id: node.name,
      render: (inc, outg) => renderPromptTask(api.flowId, { ...node, prompt }, inc, outg),
    });
    api.connect(incoming, node.name);
    return [api.newEdge(node.name)];
  },
});
