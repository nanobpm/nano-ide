/**
 * Parse `taskDefinition` leaves out of a deployed BPMN model.
 *
 * The demand side of the demand×supply model (S4) is the set of routing tokens
 * the deployed processes ask for. In a Nano/Camunda-8 model each demand is a
 * service task's `<zeebe:taskDefinition type="…">` — the job type the engine
 * matches 1:1 against a worker's routing token. This scanner reads those leaves
 * out of the raw BPMN XML so the model can bucket them by network prefix and
 * diff them against live supply.
 *
 * It is deliberately a small, dependency-free regex scan over the same surface
 * the Urban toolkit's worker-io deriver reads, so it stays app-tier and never
 * touches the engine internals — the XML arrives from the C8 REST API
 * ({@link ./c8-rest.ts}).
 */

/** One deployed `taskDefinition` leaf: a job type demanded by a model element. */
export interface TaskDefinitionLeaf {
  /** The `zeebe:taskDefinition` `type` — the routing token the engine matches. */
  readonly taskType: string;
  /** The `bpmn:process` id the leaf was declared in (best-effort, may be empty). */
  readonly process: string;
  /** The service-task element id carrying the leaf (best-effort, may be empty). */
  readonly elementId: string;
}

function attr(tag: string, name: string): string {
  const match = tag.match(new RegExp(`\\b${name}\\s*=\\s*"([^"]*)"`));
  return match ? match[1] : "";
}

function processId(xml: string): string {
  const match = xml.match(/<bpmn:process\b[^>]*\bid\s*=\s*"([^"]*)"/);
  return match ? match[1] : "";
}

/**
 * Scan one BPMN document for its service-task `taskDefinition` leaves.
 *
 * Every `<bpmn:serviceTask>` carrying a `<zeebe:taskDefinition type="…">` with a
 * non-empty type yields a leaf; tasks without a task definition (or with an empty
 * type) are skipped. The scan is order-preserving and tolerant of attribute
 * ordering and self-closing task-definition tags.
 */
export function scanTaskDefinitions(xml: string): TaskDefinitionLeaf[] {
  const proc = processId(xml);
  const out: TaskDefinitionLeaf[] = [];
  const blockRe = /<bpmn:serviceTask\b([^>]*)>([\s\S]*?)<\/bpmn:serviceTask>/g;
  let block: RegExpExecArray | null;
  while ((block = blockRe.exec(xml)) !== null) {
    const openAttrs = block[1];
    const body = block[2];
    const elementId = attr(`<x ${openAttrs}>`, "id");
    const tdMatch = body.match(/<zeebe:taskDefinition\b[^>]*>/);
    if (!tdMatch) continue;
    const taskType = attr(tdMatch[0], "type");
    if (!taskType) continue;
    out.push({ taskType, elementId, process: proc });
  }
  return out;
}

/**
 * Scan many BPMN documents and return the distinct demanded job types, in first
 * occurrence order. The demand×supply model only needs the distinct set of
 * routing tokens; {@link scanTaskDefinitions} keeps the full leaves for callers
 * that want element provenance.
 */
export function distinctTaskTypes(leaves: readonly TaskDefinitionLeaf[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const leaf of leaves) {
    if (seen.has(leaf.taskType)) continue;
    seen.add(leaf.taskType);
    out.push(leaf.taskType);
  }
  return out;
}
