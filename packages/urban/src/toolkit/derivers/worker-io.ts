// Deriver: BPMN models → `worker-io.d.ts`, the worker type map (ADR 0033 §3). Scans each
// process for service tasks and extracts the Zeebe task type plus the data-envelope in/out
// contract (io.nanobpm.dataEnvelope.in / .out, carried as zeebe:property). It emits the SAME
// `worker-io.d.ts` the console generates (a faithful port of `emitWorkerBindings` in the
// server's domain_types.ts), so the toolkit is a drop-in for the IDE's codegen (ADR 0053).

import type { DerivedArtifact, Deriver } from "../artifact.ts";
import { GENERATED_DIR } from "../artifact.ts";
import type { DomainFieldDef, DomainTypeRegistry } from "./domain.ts";

export interface ModelSource {
  /** Path (used only for diagnostics/ordering). */
  path: string;
  xml: string;
}

/** Deterministic comparator for ordering `ModelSource` lists by path. Returns 0 on equal
 * paths so it satisfies the JS sort contract (a comparator that reports both `a>b` and
 * `b>a` can reorder equal elements unpredictably) — keeping the derivers' cross-model
 * fold order stable even if a manifest pattern yields duplicate paths. Shared by every
 * model-scanning deriver so there is one canonical ordering. */
export function byModelPath(a: { path: string }, b: { path: string }): number {
  return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
}

export interface WorkerIo {
  taskType: string;
  elementId?: string;
  process?: string;
  /** Data-envelope input type id (io.nanobpm.dataEnvelope.in). */
  in?: string;
  /** Data-envelope output type id (io.nanobpm.dataEnvelope.out). */
  out?: string;
}

/** Filename the console uses; kept identical so the artifact is a drop-in. */
export const WORKER_BINDINGS_DTS = "worker-io.d.ts";
/** The generated typed-`defineWorker` wrapper's basename — re-exports the worker SDK and overrides
 * `defineWorker` with a taskType-keyed typed signature. */
export const WORKER_BINDINGS_TS = "workers.ts";
/** The domain type declarations `worker-io.d.ts` imports from (console: domain-rows.d.ts). */
export const DOMAIN_DTS = "domain-rows.d.ts";

const ENVELOPE_IN = "io.nanobpm.dataEnvelope.in";
const ENVELOPE_OUT = "io.nanobpm.dataEnvelope.out";

function attr(tag: string, name: string): string | undefined {
  const m = tag.match(new RegExp(`\\b${name}\\s*=\\s*"([^"]*)"`));
  return m ? m[1] : undefined;
}

function processId(xml: string): string | undefined {
  const m = xml.match(/<bpmn:process\b[^>]*>/);
  return m ? attr(m[0], "id") : undefined;
}

/** Scan one BPMN document for service-task worker I/O. */
export function scanModelWorkers(xml: string): WorkerIo[] {
  const proc = processId(xml);
  const out: WorkerIo[] = [];
  const blockRe = /<bpmn:serviceTask\b([^>]*)>([\s\S]*?)<\/bpmn:serviceTask>/g;
  let m: RegExpExecArray | null;
  while ((m = blockRe.exec(xml)) !== null) {
    const openAttrs = m[1];
    const body = m[2];
    const elementId = attr(`<x ${openAttrs}>`, "id");
    const tdMatch = body.match(/<zeebe:taskDefinition\b[^>]*>/);
    if (!tdMatch) continue;
    const taskType = attr(tdMatch[0], "type");
    if (!taskType) continue;

    const io: WorkerIo = { taskType, elementId, process: proc };
    const propRe = /<zeebe:property\b[^>]*>/g;
    let p: RegExpExecArray | null;
    while ((p = propRe.exec(body)) !== null) {
      const pname = attr(p[0], "name");
      const pvalue = attr(p[0], "value");
      if (pname === ENVELOPE_IN && pvalue) io.in = pvalue;
      else if (pname === ENVELOPE_OUT && pvalue) io.out = pvalue;
    }
    out.push(io);
  }
  return out;
}

// --- Faithful port of the console's emitWorkerBindings (domain_types.ts) so the emitted
//     worker-io.d.ts is byte-compatible with the IDE's own codegen. ---

/** A `DomainTypes[...]` ref for a declared type id (else undefined). The one canonical
 * ref helper shared by the worker- and message-IO emitters (matches the console's single
 * `typeRefFor` in domain_types.ts), so both stay identical to the host codegen. */
export function typeRefFor(id: string | undefined, declared: Set<string>): string | undefined {
  return id != null && declared.has(id) ? `DomainTypes[${JSON.stringify(id)}]` : undefined;
}

export interface WorkerBindingDecl {
  taskType?: string;
  inputType?: string;
  outputType?: string;
  /** The `zeebe:header` keys declared on the task; reified into a typed `job.customHeaders` shape
   * (known keys, `string` values — headers are strings on the wire). Empty/absent leaves
   * `customHeaders` the untyped fallback. */
  headerKeys?: string[];
}

/** The TS type expression for a worker's declared custom-header keys: an object type mapping each
 * declared key to `string` (Zeebe headers are strings on the wire) plus a `string` index signature
 * so undeclared headers stay accessible with the same honest wire type. Returns `undefined` when no
 * keys are declared (the caller omits the entry so the taskType falls back to `WorkerHdrs`). */
function headerRefFor(keys: string[] | undefined): string | undefined {
  const clean = [
    ...new Set(
      (keys ?? [])
        .filter((k) => typeof k === "string")
        .map((k) => k.trim())
        .filter((k) => k.length > 0),
    ),
  ];
  if (clean.length === 0) return undefined;
  const fields = clean.map((k) => `${JSON.stringify(k)}: string`).join("; ");
  return `{ ${fields}; [key: string]: string }`;
}

/** Emit `worker-io.d.ts` from worker bindings + the set of declared domain type ids. */
export function emitWorkerBindings(
  workers: WorkerBindingDecl[],
  declaredTypeIds: Iterable<string>,
): string {
  const declared = new Set(declaredTypeIds);
  const propKey = (t: string) => JSON.stringify(t);
  const taskTypes = [
    ...new Set(
      workers
        .map((w) => w?.taskType)
        .filter((t): t is string => typeof t === "string" && t.length > 0),
    ),
  ];
  const taskTypeUnion = taskTypes.length > 0
    ? taskTypes.map((t) => JSON.stringify(t)).join(" | ")
    : "string";
  // A `taskType` may be serviced by more than one model element (a worker reused across processes,
  // or the same job on several boundaries), each declaring its own data envelope. The interface is
  // keyed by `taskType`, so a single member must cover every caller. We UNION the distinct declared
  // envelope ids: `DomainTypes["A"] | DomainTypes["B"]`. A union is exactly the right contract for a
  // shared handler — it reads the safe common surface (a field is accessible only where it is
  // present-and-compatibly-typed in *every* variant, so an optional/absent-in-one field is not
  // guaranteed), which is the "required iff required in all callers" rule. A single variant collapses
  // to a plain `DomainTypes["A"]`. Genuine field-type conflicts across variants are reported out of
  // band (see `detectEnvelopeConflicts`), where the resolved field types are in hand.
  const inIds = new Map<string, string[]>();
  const outIds = new Map<string, string[]>();
  const hdrKeys = new Map<string, string[]>();
  const pushDistinct = (m: Map<string, string[]>, key: string, val: string) => {
    const list = m.get(key) ?? [];
    if (!list.includes(val)) list.push(val);
    m.set(key, list);
  };
  for (const w of workers) {
    if (typeof w?.taskType !== "string" || w.taskType.length === 0) continue;
    if (w.inputType && declared.has(w.inputType)) pushDistinct(inIds, w.taskType, w.inputType);
    if (w.outputType && declared.has(w.outputType)) pushDistinct(outIds, w.taskType, w.outputType);
    for (const k of w.headerKeys ?? []) {
      if (typeof k === "string" && k.trim().length > 0) pushDistinct(hdrKeys, w.taskType, k.trim());
    }
  }
  const unionRef = (ids: string[]): string =>
    ids.map((id) => typeRefFor(id, declared)).filter((r): r is string => !!r).join(" | ");
  const inputs = [...inIds.entries()]
    .filter(([, ids]) => ids.length > 0)
    .map(([t, ids]) => `  ${propKey(t)}: ${unionRef(ids)};`);
  const outputs = [...outIds.entries()]
    .filter(([, ids]) => ids.length > 0)
    .map(([t, ids]) => `  ${propKey(t)}: ${unionRef(ids)};`);
  const headers: string[] = [];
  for (const [t, keys] of hdrKeys.entries()) {
    const hdrRef = headerRefFor(keys);
    if (hdrRef) headers.push(`  ${propKey(t)}: ${hdrRef};`);
  }

  const header =
    "// AUTO-GENERATED by nanobpmn from the App manifest (ADR 0033 §3).\n" +
    "// The bridge from the process model to the worker type system: each declared\n" +
    "// worker's `taskType` maps to the TS type of its input payload (`job.variables`)\n" +
    "// and result, so the typed `defineWorker` types a handler by its job type. Do\n" +
    "// not edit — regenerated from the manifest. Erased to plain JS at compile.\n";

  const needsRegistry = inputs.length > 0 || outputs.length > 0;
  const importTypes = needsRegistry
    ? `import type { DomainTypes } from "./${DOMAIN_DTS}";\n`
    : "";

  const inputsIface = inputs.length > 0
    ? `export interface WorkerInputs {\n${inputs.join("\n")}\n}\n`
    : `export type WorkerInputs = Record<string, never>;\n`;
  const outputsIface = outputs.length > 0
    ? `export interface WorkerOutputs {\n${outputs.join("\n")}\n}\n`
    : `export type WorkerOutputs = Record<string, never>;\n`;
  const headersIface = headers.length > 0
    ? `export interface WorkerHeaders {\n${headers.join("\n")}\n}\n`
    : `export type WorkerHeaders = Record<string, never>;\n`;

  return `${header}\n` +
    importTypes +
    `\n/** Untyped fallback for a job whose worker declares no input/output type. */\n` +
    `export type WorkerVars = Record<string, unknown>;\n\n` +
    `/** Untyped fallback for a job whose worker declares no custom headers. */\n` +
    `export type WorkerHdrs = Record<string, unknown>;\n\n` +
    `/** Every declared worker \`taskType\` (ADR 0033 §3): the model-derived set the\n` +
    ` * typed \`defineWorker\` accepts, so \`type\` autocompletes and rejects unknown jobs. */\n` +
    `export type WorkerTaskType = ${taskTypeUnion};\n\n` +
    `/** Input payload (\`job.variables\`) per declared worker, keyed by \`taskType\`. */\n` +
    inputsIface +
    `\n/** Output payload (worker result) per declared worker, keyed by \`taskType\`. */\n` +
    outputsIface +
    `\n/** Custom headers (\`job.customHeaders\`) per declared worker, keyed by \`taskType\`.\n` +
    ` * Header values are strings on the wire, so each declared key maps to \`string\`;\n` +
    ` * the extra index signature keeps undeclared headers accessible (non-breaking). */\n` +
    headersIface;
}

/**
 * Derive `nano-generated/worker-io.d.ts` from BPMN models. `declaredTypeIds` is the set of
 * domain type ids declared in the manifest `types` — an envelope in/out only becomes a typed
 * ref when it names a declared type (matches the console's typeRefFor).
 */
export function deriveWorkerBindings(
  models: ModelSource[],
  declaredTypeIds: Iterable<string> = [],
): DerivedArtifact[] {
  const workers: WorkerBindingDecl[] = [];
  for (const model of [...models].sort(byModelPath)) {
    for (const w of scanModelWorkers(model.xml)) {
      workers.push({ taskType: w.taskType, inputType: w.in, outputType: w.out });
    }
  }
  const content = emitWorkerBindings(workers, declaredTypeIds);
  return [{ path: `${GENERATED_DIR}/${WORKER_BINDINGS_DTS}`, content }];
}

export const workerIoDeriver: Deriver<{ models: ModelSource[]; declaredTypeIds: Iterable<string> }> = {
  id: "model->worker-io",
  describe: "Derive worker-io.d.ts (task type + data-envelope in/out) from BPMN models.",
  derive: ({ models, declaredTypeIds }) => deriveWorkerBindings(models, declaredTypeIds),
};

/** A data-envelope conflict: one `taskType` bound to variants that disagree on a field's *type*. */
export interface EnvelopeConflict {
  taskType: string;
  /** `"in"` (job.variables) or `"out"` (result). */
  slot: "in" | "out";
  field: string;
  /** The distinct resolved type expressions seen for `field`, one per conflicting variant. */
  types: string[];
  /** The envelope ids that carry the conflicting field, in scan order. */
  envelopes: string[];
}

function fieldSig(f: DomainFieldDef): string {
  return `${f.type}${f.list ? "[]" : ""}`;
}

/**
 * Report data-envelope conflicts: a `taskType` serviced by more than one *distinct* envelope whose
 * variants disagree on the resolved TYPE of a shared field. A single handler is keyed by `taskType`,
 * so its input/output is the UNION of every variant (see `emitWorkerBindings`). A union is sound as
 * long as a shared field means the same thing everywhere; differing presence or optionality is fine
 * (that is the normal subset/superset relationship the union already narrows). But a field declared
 * `string` in one variant and `number` in another is a genuine contract conflict the author must
 * resolve (split the job type or unify the envelope) — this surfaces it instead of silently
 * emitting `string | number`. Compatible variants (nwf's escalation subset) produce no diagnostic.
 */
export function detectEnvelopeConflicts(
  workers: WorkerBindingDecl[],
  types: DomainTypeRegistry,
): EnvelopeConflict[] {
  const collect = (pick: (w: WorkerBindingDecl) => string | undefined, slot: "in" | "out") => {
    const byType = new Map<string, string[]>();
    for (const w of workers) {
      const id = pick(w);
      if (typeof w?.taskType !== "string" || !w.taskType || !id || !Object.hasOwn(types, id)) continue;
      const list = byType.get(w.taskType) ?? [];
      if (!list.includes(id)) list.push(id);
      byType.set(w.taskType, list);
    }
    const conflicts: EnvelopeConflict[] = [];
    for (const [taskType, ids] of byType.entries()) {
      if (ids.length < 2) continue;
      const fieldNames = new Set<string>();
      for (const id of ids) for (const name of Object.keys(types[id].fields)) fieldNames.add(name);
      for (const field of fieldNames) {
        const seen = new Map<string, string[]>(); // signature -> envelope ids carrying it
        for (const id of ids) {
          if (!Object.hasOwn(types[id].fields, field)) continue; // absent in this variant — a presence difference, not a type conflict
          const f = types[id].fields[field];
          const sig = fieldSig(f);
          const carriers = seen.get(sig) ?? [];
          carriers.push(id);
          seen.set(sig, carriers);
        }
        if (seen.size > 1) {
          conflicts.push({
            taskType,
            slot,
            field,
            types: [...seen.keys()],
            envelopes: ids.filter((id) => Object.hasOwn(types[id].fields, field)),
          });
        }
      }
    }
    return conflicts;
  };
  return [...collect((w) => w.inputType, "in"), ...collect((w) => w.outputType, "out")];
}

/** Human-readable warning for one envelope conflict, for the gen warning stream. */
export function formatEnvelopeConflict(c: EnvelopeConflict): string {
  return (
    `data-envelope conflict on worker "${c.taskType}" (${c.slot}): field "${c.field}" is ` +
    `${c.types.join(" vs ")} across envelopes ${c.envelopes.map((e) => `"${e}"`).join(", ")}. ` +
    `The taskType's ${c.slot === "in" ? "input" : "output"} is the union of its envelopes; a ` +
    `field must have one type across all of them. Unify the envelope or split the job type.`
  );
}

/**
 * Overlay the model-derived worker-IO map onto the manifest `workers[]`. The model is authoritative
 * for the envelope (`inputType`/`outputType`), so every scanned `taskType` takes its I/O from
 * `derived` (clearing a stale manifest value when the model carries none); manifest entries the scan
 * did not cover (e.g. a worker declared only for an `llm` binding, with no service task) are
 * preserved. New `taskType`s seen only in the model are appended. A byte-faithful port of the
 * console's `overlayDerivedWorkerIo` (server `data_cli.ts`).
 */
export function overlayDerivedWorkerIo(
  manifest: WorkerBindingDecl[],
  derived: WorkerBindingDecl[],
): WorkerBindingDecl[] {
  const byType = new Map<string, WorkerBindingDecl>();
  for (const w of manifest) {
    if (typeof w.taskType === "string") byType.set(w.taskType, { ...w });
  }
  for (const d of derived) {
    if (typeof d.taskType !== "string") continue;
    const existing = byType.get(d.taskType);
    const merged: WorkerBindingDecl = existing
      ? { ...existing, taskType: d.taskType }
      : { taskType: d.taskType };
    if (d.inputType) merged.inputType = d.inputType;
    else delete merged.inputType;
    if (d.outputType) merged.outputType = d.outputType;
    else delete merged.outputType;
    // Header keys are authored on the model, so the derived set is authoritative: replace (not
    // union) the manifest's, and clear when the model declares none.
    if (d.headerKeys && d.headerKeys.length > 0) merged.headerKeys = [...d.headerKeys];
    else delete merged.headerKeys;
    byType.set(d.taskType, merged);
  }
  return [...byType.values()];
}

/**
 * The static typed-`defineWorker` wrapper (`workers.ts`). It re-exports the whole worker SDK and
 * overrides `defineWorker` with a signature that keys off the `type:` string literal: when a job
 * type is present in the generated `WorkerInputs`/`WorkerOutputs` (ADR 0033 §3), the handler's
 * `job.variables` and result are typed from the declared domain type; otherwise they fall back to
 * `WorkerVars`. The body is a pass-through — the wire stays untyped JSON (ADR 0029 §3). This file
 * never changes with the schema, so it is written verbatim (unlike the regenerated
 * `worker-io.d.ts`). A byte-faithful port of the console's `emitWorkerBindingsRuntime`.
 */
export function emitWorkerBindingsRuntime(): string {
  return "// AUTO-GENERATED by nanobpmn (ADR 0033 §3): the typed `defineWorker`.\n" +
    "// Re-exports the worker SDK and overrides `defineWorker` with a taskType-keyed\n" +
    "// typed signature (job.variables, job.customHeaders + result typed from the\n" +
    "// worker's declared input/output/header contract). Erased to a pass-through at\n" +
    "// runtime. Do not edit.\n\n" +
    `import { defineWorker as defineWorkerRaw } from "./worker-sdk.ts";\n` +
    `import type { WorkerOptions } from "./worker-sdk.ts";\n` +
    `import type { WorkerInputs, WorkerOutputs, WorkerHeaders, WorkerTaskType, WorkerVars, WorkerHdrs } from "./${WORKER_BINDINGS_DTS}";\n\n` +
    `export * from "./worker-sdk.ts";\n\n` +
    `type InFor<K extends WorkerTaskType> = K extends keyof WorkerInputs ? WorkerInputs[K] : WorkerVars;\n` +
    `type OutFor<K extends WorkerTaskType> = K extends keyof WorkerOutputs ? WorkerOutputs[K] : WorkerVars;\n` +
    `type HdrFor<K extends WorkerTaskType> = K extends keyof WorkerHeaders ? WorkerHeaders[K] : WorkerHdrs;\n\n` +
    `/**\n` +
    ` * Typed \`defineWorker\`: \`type\` is constrained to the model's declared job types\n` +
    ` * (\`WorkerTaskType\`, ADR 0033 §3) so it autocompletes and rejects unknown jobs,\n` +
    ` * and the handler's \`job.variables\`, \`job.customHeaders\` + result are typed from\n` +
    ` * the worker's declared \`inputType\`/\`outputType\`/header keys. A declared job type\n` +
    ` * with no declared type falls back to WorkerVars / WorkerHdrs.\n` +
    ` */\n` +
    `export function defineWorker<K extends WorkerTaskType>(\n` +
    `  opts: { type: K } & WorkerOptions<InFor<K> & object, OutFor<K> & object, HdrFor<K> & object>,\n` +
    `): void {\n` +
    `  defineWorkerRaw(opts as unknown as WorkerOptions);\n` +
    `}\n`;
}
