// Built-in flow-node kind: `human` — a human-in-the-loop approval step (a BPMN
// `<bpmn:userTask>` with the Zeebe user-task marker). It carries a form binding
// and, optionally, an assignment (assignee / candidate groups) and an I/O
// mapping — the surface every nwf approval gate (answer escalation, plan review,
// trial-merge decision) is built from. Contributed from this module through the
// extension seam (epic #314, S3/#318) — no central union or dispatch is edited.

import { escapeXml } from "../xml.js";
import { incomingOutgoing } from "../declarative.js";
import { registerNodeKind } from "./registry.js";

/** A single Zeebe I/O mapping entry — a FEEL `source` copied to/from a process
 *  variable `target`. */
export interface HumanIoEntry {
  /** FEEL expression evaluated for the mapping (e.g. `=orderId`). */
  source: string;
  /** The process variable the value is written to. */
  target: string;
}

/** The `<zeebe:ioMapping>` for a user task: input mappings applied on activation
 *  and output mappings applied on completion. */
export interface HumanIoMapping {
  input?: HumanIoEntry[];
  output?: HumanIoEntry[];
}

/** Options for {@link FlowBuilder.human}. `form` is the `zeebe:formDefinition`
 *  form id; `assignee` / `candidateGroups` populate a `zeebe:assignmentDefinition`
 *  (supply either or both); `io` populates a `zeebe:ioMapping`. */
export interface HumanOptions {
  /** The `zeebe:formDefinition` form id bound to this task. */
  form: string;
  /** A single assignee (a static user id or a FEEL expression like
   *  `=escalationAssignee`). */
  assignee?: string;
  /** The candidate groups allowed to claim the task (a static group id or a FEEL
   *  expression). */
  candidateGroups?: string;
  /** Input/output variable mappings. */
  io?: HumanIoMapping;
}

/** The `human` node shape (its `FlowNode` variant). */
interface HumanNode {
  kind: "human";
  name: string;
  form: string;
  assignee?: string;
  candidateGroups?: string;
  io?: HumanIoMapping;
}

declare module "../types.js" {
  interface FlowNodeRegistry {
    human: HumanNode;
  }
}

declare module "../declarative.js" {
  interface FlowBuilder<C extends object> {
    /**
     * A human-in-the-loop approval step (a BPMN `<bpmn:userTask>` with the Zeebe
     * user-task marker). `opts.form` binds a `zeebe:formDefinition`; the optional
     * `assignee` / `candidateGroups` populate a `zeebe:assignmentDefinition`
     * (either or both), and `io` populates a `zeebe:ioMapping`. Resume it from a
     * task list / the Zeebe user-task API; the token waits durably until the task
     * is completed.
     */
    human<K extends string>(name: K, opts: HumanOptions): FlowBuilder<C>;
  }
}

function isEntry(e: unknown): e is HumanIoEntry {
  if (e === null || typeof e !== "object") return false;
  if (!("source" in e) || !("target" in e)) return false;
  const { source, target } = e;
  return typeof source === "string" && typeof target === "string";
}

function validateEntries(name: string, dir: "input" | "output", entries: HumanIoEntry[] | undefined): void {
  if (entries === undefined) return;
  if (!Array.isArray(entries)) throw new Error(`human("${name}") io.${dir} must be an array of { source, target }`);
  for (const e of entries) {
    if (!isEntry(e)) throw new Error(`human("${name}") io.${dir} entries must be { source: string, target: string }`);
  }
}

function renderAssignment(node: HumanNode): string {
  if (node.assignee === undefined && node.candidateGroups === undefined) return "";
  const attrs = [
    node.assignee !== undefined ? ` assignee="${escapeXml(node.assignee)}"` : "",
    node.candidateGroups !== undefined ? ` candidateGroups="${escapeXml(node.candidateGroups)}"` : "",
  ].join("");
  return `        <zeebe:assignmentDefinition${attrs} />\n`;
}

function renderMappings(entries: HumanIoEntry[] | undefined, tag: "input" | "output"): string {
  if (!entries || entries.length === 0) return "";
  return entries
    .map((e) => `          <zeebe:${tag} source="${escapeXml(e.source)}" target="${escapeXml(e.target)}" />\n`)
    .join("");
}

function renderIoMapping(node: HumanNode): string {
  const io = node.io;
  if (!io || ((io.input?.length ?? 0) === 0 && (io.output?.length ?? 0) === 0)) return "";
  return (
    `        <zeebe:ioMapping>\n` +
    renderMappings(io.input, "input") +
    renderMappings(io.output, "output") +
    `        </zeebe:ioMapping>\n`
  );
}

function renderUserTask(node: HumanNode, inc: string[], outg: string[]): string {
  const id = node.name;
  const ext =
    `      <bpmn:extensionElements>\n` +
    `        <zeebe:formDefinition formId="${escapeXml(node.form)}" />\n` +
    `        <zeebe:userTask />\n` +
    renderAssignment(node) +
    renderIoMapping(node) +
    `      </bpmn:extensionElements>`;
  return (
    `    <bpmn:userTask id="${escapeXml(id)}" name="${escapeXml(id)}">\n` +
    ext +
    "\n" +
    incomingOutgoing(inc, outg) +
    `    </bpmn:userTask>`
  );
}

registerNodeKind("human", {
  build: (api) => (name: string, opts: HumanOptions) => {
    api.claim(name);
    if (opts === null || typeof opts !== "object") {
      throw new Error(`human("${name}") needs an options object { form, … }`);
    }
    if (typeof opts.form !== "string" || opts.form.trim() === "") {
      throw new Error(`human("${name}") needs a non-empty { form } (the zeebe:formDefinition form id)`);
    }
    if (opts.assignee !== undefined && typeof opts.assignee !== "string") {
      throw new Error(`human("${name}") { assignee } must be a string`);
    }
    if (opts.candidateGroups !== undefined && typeof opts.candidateGroups !== "string") {
      throw new Error(`human("${name}") { candidateGroups } must be a string`);
    }
    validateEntries(name, "input", opts.io?.input);
    validateEntries(name, "output", opts.io?.output);
    api.out.push({
      kind: "human",
      name,
      form: opts.form,
      assignee: opts.assignee,
      candidateGroups: opts.candidateGroups,
      io: opts.io,
    });
    return api.self();
  },
  emit: (node, incoming, _loop, api) => {
    api.addNode({ id: node.name, render: (inc, outg) => renderUserTask(node, inc, outg) });
    api.connect(incoming, node.name);
    return [api.newEdge(node.name)];
  },
});
