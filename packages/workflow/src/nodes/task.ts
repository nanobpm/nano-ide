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
import { assertJobType, escapeXml } from "../xml.js";
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
 *  `bindingType` default. Emitted string fields are trimmed before storing (in
 *  parity with how `timer` normalizes `{ after }`/`{ at }`), so a value like
 *  `resourceId: " retro.md "` passes validation AND is emitted without stray
 *  surrounding whitespace. Returns a fully-resolved binding stored on the node. */
function resolvePrompt(name: string, prompt: PromptBinding): PromptBinding {
  if (typeof prompt !== "object" || prompt === null) {
    throw new Error(`task("${name}") prompt must be an object with a non-empty resourceId`);
  }
  const resourceId = prompt.resourceId;
  if (typeof resourceId !== "string" || resourceId.trim() === "") {
    throw new Error(`task("${name}") prompt.resourceId must be a non-empty string`);
  }
  const bindingType = prompt.bindingType ?? "latest";
  if (typeof bindingType !== "string" || bindingType.trim() === "") {
    throw new Error(`task("${name}") prompt.bindingType must be a non-empty string`);
  }
  const resolved: PromptBinding = { resourceId: resourceId.trim(), bindingType: bindingType.trim() };
  if (prompt.append !== undefined) {
    if (typeof prompt.append !== "string" || prompt.append.trim() === "") {
      throw new Error(`task("${name}") prompt.append must be a non-empty string when provided`);
    }
    resolved.append = prompt.append.trim();
  }
  return resolved;
}

/** Build the prompt-specific `<bpmn:extensionElements>` delta appended to the
 *  shared service-task emission: the `zeebe:linkedResources` prompt binding and
 *  (optionally) a `zeebe:ioMapping` `appendPrompt` input. The task shell
 *  (taskDefinition + envelope properties) is rendered by the built-in
 *  `EmitApi.addServiceTask`, so this variant only contributes its delta and the
 *  envelope serialization can never drift from the plain service task. */
function promptExtensions(prompt: PromptBinding): string {
  const { resourceId, bindingType, append } = prompt;
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
  return linked + io;
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
    // Prompt binding present → the shared `addServiceTask` renders the task
    // shell (taskDefinition + envelope properties, recording envelopes); we only
    // supply the `zeebe:linkedResource` (and optional `appendPrompt` ioMapping)
    // delta, so the envelope/taskDefinition serialization has a single source.
    const prompt = node.prompt;
    api.addServiceTask(node, { extraExt: promptExtensions(prompt) });
    api.connect(incoming, node.name);
    return [api.newEdge(node.name)];
  },
});
