// @nanobpm/workflow — code-first durable workflows for nanobpmn (ADR 0044/0045).
//
// THE code-first surface is the declarative flow builder — a list of steps the
// engine runs and shows you one at a time, because each compiles to a real,
// engine-visible BPMN node:
//
//   defineFlow(id, (w) => {
//     w.run("fetchDiff", async (job) => ({ diff: await gh.diff(job.variables.prId) }));
//     w.signal("humanApproval", { correlationKey: "prId" }); // durable human wait
//     w.task("signPdf");                                      // served by an EXTERNAL worker
//     w.run("merge", async (job) => ({ merged: await gh.merge(job.variables.prId) }));
//   });
//
// The SDK derives the BPMN model, the job types (`${flowId}:${step}`), and the
// message/correlation wiring; the Worker hosts your `run` steps; the
// WorkflowClient deploys, starts, and signals. `w.task` steps are served by a
// worker outside this program (see `externalJobTypes`).
//
// `defineWorkflow` (imperative, Temporal-style replay) is EXPERIMENTAL and kept
// for advanced durable-orchestration use only; prefer `defineFlow`. Its steps
// are not engine-visible (a single looping orchestrator) and it requires
// determinism discipline. It is not the recommended authoring surface.
//
// Quickstart:
//
//   import { defineFlow, WorkflowClient, Worker } from "@nanobpm/workflow";
//
//   const prReview = defineFlow("pr-review", (w) => {
//     w.run("fetchDiff", async (job) => ({ files: 3 }));
//     w.run("merge", async (job) => ({ merged: true }));
//   });
//
//   const client = new WorkflowClient({ baseUrl: "http://localhost:8080" });
//   await client.deploy(prReview);
//   const worker = new Worker({ baseUrl: "http://localhost:8080", workflows: [prReview] });
//   worker.start();
//   await client.start(prReview, { prId: "PR-1234" });

// EXPERIMENTAL — imperative (Temporal-style replay) surface. Not the recommended
// code-first surface (steps are not engine-visible; requires determinism
// discipline). Retained for advanced durable-orchestration use only.
export { defineWorkflow, imperativeToBpmn, replayOnce } from "./imperative.js";
export type { Journal, ReplayStep } from "./imperative.js";
export { defineFlow, declarativeToBpmn, externalJobTypes, walkNodes } from "./declarative.js";
export type { FlowBuilder } from "./declarative.js";
// The `.boundary(...)` option type (its builder method augments FlowBuilder from
// the boundary kind module — S2/#317).
export type { BoundaryOptions } from "./nodes/boundary.js";
export { layoutBpmn, declarativeToLayoutedBpmn } from "./layout.js";
export { envelope } from "./envelope.js";
export type {
  Envelope,
  EnvelopeType,
  EnvelopeField,
  FieldSpec,
  ScalarType,
  ScalarTs,
  FieldTs,
} from "./envelope.js";
export { WorkflowClient, WorkflowError, toBpmn, toDeployableBpmn } from "./client.js";
export type {
  WorkflowClientOptions,
  NanoSdkClient,
  NanoJobWorker,
  JobWorkerConfig,
  ActivatedJob,
} from "./client.js";
export { Worker } from "./worker.js";
export type { WorkerOptions, ActivityEvent } from "./worker.js";
export type {
  Json,
  JsonObject,
  Job,
  StepHandler,
  DeclarativeFlow,
  DeclarativeStep,
  FlowNode,
  SwitchCase,
  TimerStart,
  NodeEnvelopes,
  StepContract,
  FlowContracts,
  ImperativeWorkflow,
  Orchestration,
  WorkflowContext,
  Workflow,
  DeployResult,
  StartResult,
} from "./types.js";
