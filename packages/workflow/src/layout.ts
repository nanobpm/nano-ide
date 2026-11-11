// Optional diagram-interchange (DI) generation for the code-first surfaces.
//
// The authoring surfaces emit *semantic* BPMN — process, flow nodes, sequence
// flows, messages — with no `bpmndi:` diagram: the engine runs the semantic model
// and DI is an authoring-time concern only (a derived flow has no diagram of its
// own). This module layers bpmn-io's `bpmn-auto-layout` on top so a derived model
// opens with a rendered, auto-laid-out diagram in a modeller/viewer, which makes
// code-first flows visually inspectable, reviewable, and round-trippable.
//
// `bpmn-auto-layout` is an *optional peer dependency*: the runtime client stays
// dependency-free and the layout engine is loaded lazily, only when you ask for a
// diagram. Install it alongside this package (`npm i bpmn-auto-layout`) to use
// these helpers.
//
// DI is best-effort and *regenerable* — the semantic model (`declarativeToBpmn`)
// stays authoritative. Re-run layout whenever the flow changes rather than
// hand-editing the generated diagram.

import type { DeclarativeFlow } from "./types.js";
import { declarativeToBpmn } from "./declarative.js";

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Generate BPMN diagram interchange (DI) for a BPMN XML string using bpmn-io's
 * `bpmn-auto-layout`, returning the same model with an auto-laid-out diagram
 * (`bpmndi:BPMNDiagram`). Works on DI-less *or* already-laid-out input, and
 * preserves `zeebe:` extension elements (task definitions, message
 * subscriptions) through the round-trip.
 *
 * Requires the optional peer dependency `bpmn-auto-layout` to be installed; a
 * clear error is thrown if it is missing.
 */
export async function layoutBpmn(bpmnXml: string): Promise<string> {
  let layoutProcess: typeof import("bpmn-auto-layout").layoutProcess;
  try {
    ({ layoutProcess } = await import("bpmn-auto-layout"));
  } catch (cause) {
    // Only substitute the friendly "not installed" message when the module
    // genuinely cannot be resolved. A different failure (the package is present
    // but fails to load — syntax, a broken transitive dep, a runtime throw at
    // import time) must surface as-is so it isn't masked as a missing dependency.
    if (!isRecord(cause) || cause.code !== "ERR_MODULE_NOT_FOUND") {
      throw cause;
    }
    throw new Error(
      'layoutBpmn requires the optional peer dependency "bpmn-auto-layout". ' +
        "Install it to generate diagram layout: npm i bpmn-auto-layout",
      { cause },
    );
  }
  const result = await layoutProcess(seedExpandedSubProcesses(bpmnXml));
  // Version-shape normalization: bpmn-auto-layout 2.x (and >= 1.4) resolves to
  // `{ xml, warnings }`; 1.3.x resolved to the laid-out XML string directly. We
  // pin >= 2.0.0-alpha.2 but normalize both so the SDK tolerates the whole range.
  return typeof result === "string" ? result : result.xml;
}

const DI_NS = {
  bpmndi: "http://www.omg.org/spec/BPMN/20100524/DI",
  dc: "http://www.omg.org/spec/DD/20100524/DC",
};

/**
 * Value of attribute `name` in an opening tag, in either quote style. Whitespace
 * around `=` is deliberately NOT accepted: the layouter's XML parser (saxen)
 * drops such an attribute, so seeding a shape for an id it cannot see would
 * leave a dangling `bpmnElement` and crash the layout.
 */
function xmlAttr(tag: string, name: string): string | undefined {
  const m = new RegExp(`\\s${name}=(?:"([^"]*)"|'([^']*)')`).exec(tag);
  const v = m?.[1] ?? m?.[2];
  return v === undefined || v === "" ? undefined : v;
}

/**
 * bpmn-auto-layout 2 draws a sub-process EXPANDED (its steps inline, on the
 * main diagram) only when the input's own DI says `isExpanded="true"`; otherwise
 * it collapses it onto a drill-down plane, which hides the steps — e.g. a
 * multi-step `forEach` body — from anyone reading the diagram. A code-first
 * model has no DI, so seed a minimal diagram that marks each embedded
 * sub-process expanded (one plane per process). Input that already has a
 * diagram is returned untouched: its expanded/collapsed choices are the author's.
 * Only the `bpmn:` prefix our emitters write is recognised; other input passes
 * through and lays out as before. Exported for tests only (not re-exported
 * from the package index).
 */
export function seedExpandedSubProcesses(bpmnXml: string): string {
  if (/<(?:\w+:)?BPMNDiagram\b/.test(bpmnXml)) return bpmnXml;
  const planes: string[] = [];
  for (const proc of bpmnXml.matchAll(/<bpmn:process\b[^>]*>[\s\S]*?<\/bpmn:process>/g)) {
    const procId = xmlAttr(proc[0].slice(0, proc[0].indexOf(">") + 1), "id");
    if (procId === undefined) continue;
    // Event sub-processes (`triggeredByEvent="true"`) are excluded: they are not
    // forEach bodies and keep the layouter's default treatment.
    const subs = [...proc[0].matchAll(/<bpmn:subProcess\b[^>]*>/g)]
      .filter((m) => !/\btriggeredByEvent\s*=\s*["']true["']/.test(m[0]))
      .map((m) => xmlAttr(m[0], "id"))
      .filter((id): id is string => id !== undefined);
    if (subs.length === 0) continue;
    const shapes = subs.map(
      (id, i) =>
        `<bpmndi:BPMNShape id="Seed_${i}_${id}_di" bpmnElement="${id}" isExpanded="true">` +
        `<dc:Bounds x="0" y="0" width="100" height="80"/></bpmndi:BPMNShape>`,
    );
    planes.push(
      `<bpmndi:BPMNDiagram id="Seed_${procId}_diagram"><bpmndi:BPMNPlane id="Seed_${procId}_plane" bpmnElement="${procId}">` +
        shapes.join("") +
        `</bpmndi:BPMNPlane></bpmndi:BPMNDiagram>`,
    );
  }
  if (planes.length === 0) return bpmnXml;
  let xml = bpmnXml.replace(/<\/bpmn:definitions>\s*$/, `${planes.join("")}</bpmn:definitions>`);
  // Only declarations on the definitions element are in scope for the appended
  // diagram; one declared on a child element does not bind the prefix there.
  const defsTag = /<bpmn:definitions\b[^>]*>/.exec(xml)?.[0] ?? "";
  for (const [prefix, uri] of Object.entries(DI_NS)) {
    if (!new RegExp(`\\bxmlns:${prefix}\\s*=`).test(defsTag)) {
      xml = xml.replace(/<bpmn:definitions\b/, `<bpmn:definitions xmlns:${prefix}="${uri}"`);
    }
  }
  return xml;
}

/**
 * Derive an executable BPMN model from a declarative flow AND auto-generate its
 * diagram (DI), so the model opens rendered in a modeller/viewer. Convenience
 * over `layoutBpmn(declarativeToBpmn(flow))`; async because layout is async. The
 * semantic model stays authoritative — see `declarativeToBpmn` for the DI-less
 * model the engine actually runs.
 *
 * Requires the optional peer dependency `bpmn-auto-layout` to be installed.
 */
export function declarativeToLayoutedBpmn(flow: DeclarativeFlow): Promise<string> {
  return layoutBpmn(declarativeToBpmn(flow));
}
