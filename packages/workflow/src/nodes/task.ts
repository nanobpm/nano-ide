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
import { assertIoMapping, renderIoMapping } from "../io-mapping.js";
import type { HumanIoEntry, HumanIoMapping } from "../io-mapping.js";
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
      /** An explicit `<zeebe:ioMapping>` on the service task — arbitrary input
       *  (and output) variable mappings, using the shared ioMapping shape. When a
       *  `prompt.append` is ALSO present it is folded into this single mapping as
       *  an extra `appendPrompt` input (no duplicate `ioMapping` element). */
      io?: HumanIoMapping;
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
     * worker through a `zeebe:ioMapping` `appendPrompt` input. `io` (optional)
     * adds arbitrary input/output variable mappings to the SAME `zeebe:ioMapping`.
     */
    task<K extends string>(
      name: K,
      opts: { jobType?: string; prompt: PromptBinding; io?: HumanIoMapping },
    ): FlowBuilder<C>;
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
  // Only an ABSENT bindingType defaults to "latest"; `??` would also swallow an
  // explicit `null`, masking an authoring mistake. Distinguish `undefined` (use
  // the default) from any other non-string (reject), in parity with how `append`
  // below treats `!== undefined` as "provided, so validate strictly".
  const bindingType = prompt.bindingType === undefined ? "latest" : prompt.bindingType;
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

/** Build the `<bpmn:extensionElements>` delta appended to the shared
 *  service-task emission: the optional `zeebe:linkedResources` prompt binding
 *  followed by a single, correctly-ordered `zeebe:ioMapping`. The task shell
 *  (taskDefinition + envelope properties) is rendered by the built-in
 *  `EmitApi.addServiceTask`, so this variant only contributes its delta and the
 *  envelope serialization can never drift from the plain service task.
 *
 *  The `ioMapping` is the SINGLE source for all variable mappings on the task:
 *  the explicit `io.input`/`io.output` plus — when `prompt.append` is present —
 *  the `appendPrompt` input, folded in as one more input entry so a task with
 *  both a `prompt.append` and an explicit `io.input` emits exactly one
 *  `<zeebe:ioMapping>` (never two). Element order matches the golden:
 *  `linkedResources` (when any) then `ioMapping` (when any), the latter after
 *  `taskDefinition`/`properties`. */
function taskExtensions(prompt: PromptBinding | undefined, io: HumanIoMapping | undefined): string {
  const linked =
    prompt !== undefined
      ? `        <zeebe:linkedResources>\n` +
        `          <zeebe:linkedResource resourceId="${escapeXml(prompt.resourceId)}" ` +
        `bindingType="${escapeXml(prompt.bindingType ?? "latest")}" resourceType="GenericScript" linkName="prompt" />\n` +
        `        </zeebe:linkedResources>\n`
      : "";
  // Merge the explicit io mapping and the prompt's `appendPrompt` input into one
  // mapping. The append input trails the explicit inputs — it appends runtime
  // context to the bound prompt, so it reads naturally after the task's own
  // inputs — and outputs follow, matching `renderIoMapping`'s input-then-output
  // ordering.
  const inputs: HumanIoEntry[] = [...(io?.input ?? [])];
  if (prompt?.append !== undefined) inputs.push({ source: prompt.append, target: "appendPrompt" });
  const merged: HumanIoMapping = { input: inputs, output: io?.output ?? [] };
  return linked + renderIoMapping(merged);
}

registerNodeKind("task", {
  build: (api) => (name: string, opts?: { jobType?: string; prompt?: PromptBinding; io?: HumanIoMapping }) => {
    api.claim(name);
    const override = opts?.jobType;
    if (override !== undefined) assertJobType("task jobType", override);
    const prompt = opts?.prompt !== undefined ? resolvePrompt(name, opts.prompt) : undefined;
    assertIoMapping(`task("${name}")`, opts?.io);
    api.out.push({
      kind: "task",
      name,
      envelopes: api.contractEnvelopes(name),
      jobType: override,
      prompt,
      io: opts?.io,
    });
    return api.self();
  },
  emit: (node, incoming, _loop, api) => {
    // Neither a prompt binding nor an explicit io mapping → the standard
    // service-task emission is preserved unchanged (no `linkedResources`, no
    // `ioMapping`).
    if (node.prompt === undefined && node.io === undefined) {
      api.addServiceTask(node);
      api.connect(incoming, node.name);
      return [api.newEdge(node.name)];
    }
    // A prompt binding and/or an explicit io mapping present → the shared
    // `addServiceTask` renders the task shell (taskDefinition + envelope
    // properties, recording envelopes); we only supply the `linkedResource`
    // and/or `ioMapping` delta, so the envelope/taskDefinition serialization has
    // a single source.
    api.addServiceTask(node, { extraExt: taskExtensions(node.prompt, node.io) });
    api.connect(incoming, node.name);
    return [api.newEdge(node.name)];
  },
});
