// The single source of truth for a Zeebe `<zeebe:ioMapping>` — its shape, its
// authoring-time validation, and its BPMN emission — shared by EVERY node kind
// that carries variable mappings (`human` user tasks, `task`/`run` service
// tasks). Derivation over duplication (AGENTS.md): one interface, one validator,
// one renderer, so the ioMapping surface can never drift between node kinds.

import { escapeXml } from "./xml.js";

/** A single Zeebe I/O mapping entry — a FEEL `source` copied to/from a process
 *  variable `target`. */
export interface HumanIoEntry {
  /** FEEL expression evaluated for the mapping (e.g. `=orderId`). */
  source: string;
  /** The process variable the value is written to. */
  target: string;
}

/** A `<zeebe:ioMapping>`: input mappings applied on activation and output
 *  mappings applied on completion. */
export interface HumanIoMapping {
  input?: HumanIoEntry[];
  output?: HumanIoEntry[];
}

/** A present, non-empty, non-whitespace-only string — the shape every id /
 *  assignment / mapping-expression field must have. A blank value would emit a
 *  meaningless BPMN attribute (an empty ioMapping source/target, formId,
 *  assignee, …) that fails or misbehaves at deploy/run time, so we fail fast at
 *  build. Non-blank values are kept verbatim — FEEL expressions are never
 *  trimmed or normalized. */
export function isNonBlankString(v: unknown): v is string {
  return typeof v === "string" && v.trim() !== "";
}

function isEntry(e: unknown): e is HumanIoEntry {
  if (e === null || typeof e !== "object") return false;
  if (!("source" in e) || !("target" in e)) return false;
  const { source, target } = e;
  return isNonBlankString(source) && isNonBlankString(target);
}

function validateEntries(label: string, dir: "input" | "output", entries: HumanIoEntry[] | undefined): void {
  if (entries === undefined) return;
  if (!Array.isArray(entries)) throw new Error(`${label} io.${dir} must be an array of { source, target }`);
  for (const e of entries) {
    if (!isEntry(e)) {
      throw new Error(`${label} io.${dir} entries must be { source: non-empty string, target: non-empty string }`);
    }
  }
}

/** Validate an optional io mapping at authoring time. `label` is the node's
 *  self-description (e.g. `human("decide")` or `task("record")`) so the thrown
 *  message names the offending step. An `undefined` mapping is allowed (no
 *  ioMapping is emitted); a non-object / array value, or a malformed entry, fails
 *  fast. */
export function assertIoMapping(label: string, io: HumanIoMapping | undefined): void {
  if (io === undefined) return;
  if (io === null || typeof io !== "object" || Array.isArray(io)) {
    throw new Error(`${label} { io } must be an object { input?, output? }`);
  }
  validateEntries(label, "input", io.input);
  validateEntries(label, "output", io.output);
}

function renderMappings(entries: HumanIoEntry[] | undefined, tag: "input" | "output"): string {
  if (!entries || entries.length === 0) return "";
  return entries
    .map((e) => `          <zeebe:${tag} source="${escapeXml(e.source)}" target="${escapeXml(e.target)}" />\n`)
    .join("");
}

/** Emit a single `<zeebe:ioMapping>` (inputs then outputs) for the mapping, or
 *  the empty string when it has no entries. The 8-space element / 10-space entry
 *  indentation matches both the user-task and service-task emission, so a caller
 *  can splice the result straight into either `<bpmn:extensionElements>`. */
export function renderIoMapping(io: HumanIoMapping | undefined): string {
  if (!io || ((io.input?.length ?? 0) === 0 && (io.output?.length ?? 0) === 0)) return "";
  return (
    `        <zeebe:ioMapping>\n` +
    renderMappings(io.input, "input") +
    renderMappings(io.output, "output") +
    `        </zeebe:ioMapping>\n`
  );
}
