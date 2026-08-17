// Deriver: BPMN models + manifest → `system-brief.md` / `system-brief.json`, the app's
// *institutional-memory* brief (ADR 0060). Where `worker-io.ts` emits worker *types* and
// `meta.ts` emits a *typed accessor*, this deriver folds the SAME scanned structure into
// agent- and human-readable **system context**: the app's processes, its service-task call
// graph, the decisions it encodes, and the ownership / "why" carried on
// the model as reserved `nano:meta` keys. It reuses the sibling scanners (single parse rule
// per vocabulary) and is pure (models in, artifacts out) so `urban gen --check` keeps it
// honest — the brief can never rot the way a hand-written README does (ADR 0060 §1).
//
// SKETCH (ADR 0060 spike): the shape, scanners, fold, and both emitters are real and tested;
// wiring into gen.ts and the runtime `/app/agent` route land in the implementation PR.

import type { DerivedArtifact, Deriver } from "../artifact.ts";
import { GENERATED_DIR } from "../artifact.ts";
import { byModelPath, type ModelSource, scanModelWorkers, type WorkerIo } from "./worker-io.ts";
import { scanModelMeta } from "./meta.ts";

/** Basenames of the two emitted artifacts. */
export const SYSTEM_BRIEF_MD = "system-brief.md";
export const SYSTEM_BRIEF_JSON = "system-brief.json";

/** Reserved `nano:meta` keys the brief recognises as ownership / provenance context (ADR 0060
 * §1). All optional and additive — absence degrades the brief to structure-only. `adr` may be
 * declared more than once (repeated `nano:meta`, matching the existing scan) to reference
 * multiple ADRs; the scan collects them into `adrs[]`. */
export interface Ownership {
  owner?: string;
  team?: string;
  slack?: string;
  runbook?: string;
  since?: string;
  adrs: string[];
}

/** One decision the app encodes: a `businessRuleTask` with a `zeebe:calledDecision`. */
export interface DecisionRef {
  process?: string;
  elementId?: string;
  decisionId: string;
}

/** The derived, machine-readable system model — the payload of `system-brief.json` and the
 * input the runtime injects as session context / the retro plane consumes (ADR 0060 §3). */
export interface SystemBrief {
  /** App id/name from the manifest, if provided. */
  app?: string;
  /** Every process id the models declare, in scan order. */
  processes: string[];
  /** Service-task call graph: each worker binding (task type + in/out envelope + process). The
   * dependency edges are implicit — a process depends on the task types its service tasks invoke. */
  workers: WorkerIo[];
  /** Decisions (`businessRuleTask` → DMN) the models encode. */
  decisions: DecisionRef[];
  /** Ownership / provenance folded from reserved `nano:meta` keys. */
  ownership: Ownership;
}

function attr(tag: string, name: string): string | undefined {
  const m = tag.match(new RegExp(`\\b${name}\\s*=\\s*"([^"]*)"`));
  return m ? m[1] : undefined;
}

function processId(xml: string): string | undefined {
  const m = xml.match(/<bpmn:process\b[^>]*>/);
  return m ? attr(m[0], "id") : undefined;
}

/** Scan one BPMN document for `businessRuleTask` → `zeebe:calledDecision` decision refs, in
 * document order, tagged with the enclosing process (mirrors `scanModelWorkers`' shape). */
export function scanModelDecisions(xml: string): DecisionRef[] {
  const proc = processId(xml);
  const out: DecisionRef[] = [];
  const blockRe = /<bpmn:businessRuleTask\b([^>]*)>([\s\S]*?)<\/bpmn:businessRuleTask>/g;
  let m: RegExpExecArray | null;
  while ((m = blockRe.exec(xml)) !== null) {
    const elementId = attr(`<x ${m[1]}>`, "id");
    const cd = m[2].match(/<zeebe:calledDecision\b[^>]*>/);
    if (!cd) continue;
    const decisionId = attr(cd[0], "decisionId");
    if (!decisionId) continue;
    out.push({ process: proc, elementId, decisionId });
  }
  return out;
}

/** Reserved single-valued ownership keys → their `Ownership` field. */
const OWNERSHIP_KEYS: Record<string, Exclude<keyof Ownership, "adrs">> = {
  owner: "owner",
  team: "team",
  slack: "slack",
  runbook: "runbook",
  since: "since",
};

/** Fold the models' reserved `nano:meta` entries into `Ownership`. Single-valued keys take the
 * last (scan-order) write, matching `foldMeta`; `adr` is multi-valued and accumulates. */
export function foldOwnership(models: ModelSource[]): Ownership {
  const own: Ownership = { adrs: [] };
  for (const model of [...models].sort(byModelPath)) {
    for (const { key, value } of scanModelMeta(model.xml)) {
      const k = key.trim().toLowerCase();
      if (k === "adr") {
        if (value && !own.adrs.includes(value)) own.adrs.push(value);
      } else if (Object.hasOwn(OWNERSHIP_KEYS, k)) {
        own[OWNERSHIP_KEYS[k]] = value ?? "";
      }
    }
  }
  return own;
}

/** Fold all models + manifest into the machine-readable `SystemBrief`. Deterministic: models
 * are scanned in path order. */
export function buildSystemBrief(models: ModelSource[], app?: string): SystemBrief {
  const sorted = [...models].sort(byModelPath);
  const workers: WorkerIo[] = [];
  const decisions: DecisionRef[] = [];
  const processes: string[] = [];
  for (const model of sorted) {
    const proc = processId(model.xml);
    if (proc && !processes.includes(proc)) processes.push(proc);
    workers.push(...scanModelWorkers(model.xml));
    decisions.push(...scanModelDecisions(model.xml));
  }
  return { app, processes, workers, decisions, ownership: foldOwnership(models) };
}

/** Escape a Markdown table cell: neutralise `|` and newlines, which would otherwise break the
 * table. Ownership values come from model-authored `nano:meta`, so this both keeps rendering
 * honest and blunts Markdown/prompt injection into the agent-facing brief. Backticks are left
 * intact — the emitter deliberately wraps ids in code spans. */
function mdCell(s: string): string {
  return s.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

function mdTable(headers: string[], rows: string[][]): string {
  if (rows.length === 0) return "_none_\n";
  const head = `| ${headers.join(" | ")} |\n| ${headers.map(() => "---").join(" | ")} |\n`;
  return head + rows.map((r) => `| ${r.map((c) => mdCell(c || "")).join(" | ")} |`).join("\n") + "\n";
}

/** Emit the agent- and human-readable `system-brief.md` from the machine model. Compact by
 * design (call graph + owners, not model XML) to keep the per-session prompt budget small
 * (ADR 0060 §3 / open question 1). */
export function emitSystemBriefMd(b: SystemBrief): string {
  const o = b.ownership;
  let m = `# ${b.app ?? "App"} — system brief\n\n`;
  m += "_Auto-derived from the process models (ADR 0060). Do not edit — regenerated by " +
    "`urban gen`; drift fails `urban gen --check`._\n\n";

  m += "## Ownership\n\n";
  const ownRows = [
    ["Owner", o.owner ?? ""],
    ["Team", o.team ?? ""],
    ["Slack", o.slack ?? ""],
    ["Runbook", o.runbook ?? ""],
    ["Since", o.since ?? ""],
    ["ADRs", o.adrs.join(", ")],
  ].filter((r) => r[1]);
  m += ownRows.length ? mdTable(["Field", "Value"], ownRows) : "_No ownership metadata declared " +
    "(add reserved `nano:meta` keys: owner, team, slack, runbook, adr, since)._\n";
  m += "\n";

  m += "## Processes\n\n";
  m += b.processes.length ? b.processes.map((p) => `- \`${p}\``).join("\n") + "\n" : "_none_\n";
  m += "\n";

  m += "## Service-task call graph (dependency edges)\n\n";
  m += mdTable(
    ["Process", "Task type (dependency)", "In", "Out"],
    b.workers.map((w) => [
      w.process ? `\`${w.process}\`` : "",
      `\`${w.taskType}\``,
      w.in ? `\`${w.in}\`` : "",
      w.out ? `\`${w.out}\`` : "",
    ]),
  );
  m += "\n";

  m += "## Decisions (DMN)\n\n";
  m += mdTable(
    ["Process", "Element", "Decision"],
    b.decisions.map((d) => [
      d.process ? `\`${d.process}\`` : "",
      d.elementId ? `\`${d.elementId}\`` : "",
      `\`${d.decisionId}\``,
    ]),
  );
  return m;
}

/**
 * Derive `nano-generated/system-brief.md` + `system-brief.json` from BPMN models (ADR 0060 §1).
 * Pure and deterministic (path-ordered scan), so it is a drop-in drift-checkable artifact like
 * its sibling derivers.
 */
export function deriveSystemBrief(models: ModelSource[], app?: string): DerivedArtifact[] {
  const brief = buildSystemBrief(models, app);
  return [
    { path: `${GENERATED_DIR}/${SYSTEM_BRIEF_MD}`, content: emitSystemBriefMd(brief) },
    { path: `${GENERATED_DIR}/${SYSTEM_BRIEF_JSON}`, content: JSON.stringify(brief, null, 2) + "\n" },
  ];
}

/** The `Deriver` binding, peer to `worker-io` / `meta`, for wiring into `gen.ts`. */
export const systemBriefDeriver: Deriver<{ models: ModelSource[]; app?: string }> = {
  id: "system-brief",
  describe: "App institutional-memory brief (processes, call graph, decisions, ownership) — ADR 0060",
  derive: ({ models, app }) => deriveSystemBrief(models, app),
};
