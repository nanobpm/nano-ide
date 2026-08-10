// Pure planner for the write-once worker-stub scaffolder (ADR 0056). Given the app's models,
// its manifest workers, and the set of declared domain type ids, it plans one typed handler
// stub per un-wired service task — the ONE part of an Urban app that cannot be derived from
// the model (the handler *body* is human logic). Everything here is pure and testable like a
// deriver; the impure write-if-absent edge lives in `../scaffold.ts`.
//
// scaffold ≠ derive: stubs are human-owned files under `workers/<slug>/worker.ts`, so they are
// planned once and never overwritten — unlike the derived `nano-generated/` tree.

import { scanModelWorkers, type ModelSource } from "../derivers/worker-io.ts";

/** A worker to plan against: the manifest's already-wired workers. */
export interface ScaffoldWorker {
  taskType: string;
  handler?: string;
  llm?: string;
}

/** The `workers[]` manifest entry a stub is wired in as. */
export interface StubManifestEntry {
  taskType: string;
  handler: string;
}

/** One planned handler stub. */
export interface WorkerStubPlan {
  taskType: string;
  process?: string;
  elementId?: string;
  /** Directory slug under `workers/` (unique across the plan). */
  slug: string;
  /** App-relative handler path: `workers/<slug>/worker.ts`. */
  handlerPath: string;
  /** True when the data-envelope `in`/`out` names a declared domain type (so it is typed). */
  typedIn: boolean;
  typedOut: boolean;
  /** The stub file contents. */
  stub: string;
  manifestEntry: StubManifestEntry;
}

export type SkipReason = "already-wired" | "orchestrator" | "duplicate";

export interface SkippedWorker {
  taskType: string;
  reason: SkipReason;
}

export interface WorkerScaffoldPlan {
  plans: WorkerStubPlan[];
  skipped: SkippedWorker[];
}

/** Suffix the imperative orchestrator task type carries (ADR 0054 / defineWorkflow). */
const ORCHESTRATOR_SUFFIX = ":__orchestrate";

/** Relative import from `workers/<slug>/worker.ts` to the generated worker-io types. */
const GENERATED_IMPORT = "../../nano-generated/worker-io.d.ts";

/** Turn a task type into a filesystem-safe directory slug. */
export function slugifyTaskType(taskType: string): string {
  const s = taskType
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return s.length > 0 ? s : "worker";
}

/** Render a stub matching a real hand-authored worker (default-exported AppJobHandler). */
export function renderWorkerStub(
  taskType: string,
  typedIn: boolean,
  typedOut: boolean,
): string {
  const key = JSON.stringify(taskType); // e.g. "pr.finalize" — matches the deriver's property keys
  const syms: string[] = [];
  if (typedIn) syms.push("WorkerInputs");
  if (typedOut) syms.push("WorkerOutputs");

  const generatedImport = syms.length > 0
    ? `import type { ${syms.join(", ")} } from ${JSON.stringify(GENERATED_IMPORT)};\n`
    : "";

  let generic = "";
  if (typedIn && typedOut) generic = `<WorkerInputs[${key}], WorkerOutputs[${key}]>`;
  else if (typedIn) generic = `<WorkerInputs[${key}]>`;
  else if (typedOut) generic = `<Record<string, unknown>, WorkerOutputs[${key}]>`;

  const varsNote = typedIn
    ? `  // \`job.variables\` is typed as WorkerInputs[${key}].`
    : `  // \`job.variables\` is an open Record<string, unknown> (no declared input type).`;

  return (
    `// Handler stub for the \`${taskType}\` service task, scaffolded from the model (ADR 0056).\n` +
    `// This file is yours to edit — \`urban gen\` will never overwrite it. Implement the body\n` +
    `// below (use \`app.data.table(...)\` for state) and delete the throw.\n` +
    `import type { AppJobHandler } from "@nanobpm/urban/worker";\n` +
    generatedImport +
    `\n` +
    `const handler: AppJobHandler${generic} = async (job, app) => {\n` +
    varsNote +
    `\n` +
    `  // Reach app state and services through the injected \`app\` API.\n` +
    `  throw new Error(${JSON.stringify(`worker not implemented: ${taskType}`)});\n` +
    `};\n` +
    `\n` +
    `export default handler;\n`
  );
}

/**
 * Plan write-once handler stubs from the models. A stub is planned for each service-task
 * `taskType` that is NOT already wired in the manifest, NOT the imperative orchestrator, and
 * not a duplicate of one already planned. `declaredTypeIds` are the manifest `types` ids — an
 * envelope `in`/`out` is typed only when it names one (matching the worker-io deriver).
 */
export function planWorkerScaffold(
  models: ModelSource[],
  workers: ScaffoldWorker[] = [],
  declaredTypeIds: Iterable<string> = [],
): WorkerScaffoldPlan {
  const wired = new Set(
    workers
      .map((w) => w?.taskType)
      .filter((t): t is string => typeof t === "string" && t.length > 0),
  );
  const declared = new Set(declaredTypeIds);

  const plans: WorkerStubPlan[] = [];
  const skipped: SkippedWorker[] = [];
  const seenTaskTypes = new Set<string>();
  const usedSlugs = new Set<string>();

  for (const model of [...models].sort((a, b) => a.path.localeCompare(b.path))) {
    for (const io of scanModelWorkers(model.xml)) {
      const taskType = io.taskType;
      if (taskType.endsWith(ORCHESTRATOR_SUFFIX)) {
        skipped.push({ taskType, reason: "orchestrator" });
        continue;
      }
      if (wired.has(taskType)) {
        skipped.push({ taskType, reason: "already-wired" });
        continue;
      }
      if (seenTaskTypes.has(taskType)) {
        skipped.push({ taskType, reason: "duplicate" });
        continue;
      }
      seenTaskTypes.add(taskType);

      let slug = slugifyTaskType(taskType);
      if (usedSlugs.has(slug)) {
        let n = 2;
        while (usedSlugs.has(`${slug}-${n}`)) n++;
        slug = `${slug}-${n}`;
      }
      usedSlugs.add(slug);

      const typedIn = io.in != null && declared.has(io.in);
      const typedOut = io.out != null && declared.has(io.out);
      const handlerPath = `workers/${slug}/worker.ts`;

      plans.push({
        taskType,
        process: io.process,
        elementId: io.elementId,
        slug,
        handlerPath,
        typedIn,
        typedOut,
        stub: renderWorkerStub(taskType, typedIn, typedOut),
        manifestEntry: { taskType, handler: handlerPath },
      });
    }
  }

  return { plans, skipped };
}
