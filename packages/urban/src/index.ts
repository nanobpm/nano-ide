// @nanobpm/urban — the code-first Urban stack in one package (ADR 0054):
//
//   • runtime — materialize and serve an app from a nano.app.json manifest
//     (datasource, workers, surfaces, triggers) on Node or Deno.
//   • toolkit — pure derivers (`urban gen`) that emit generated artifacts
//     (SQL migrations, worker I/O bindings) from the model.
//   • workflow — the code-first process surface, re-exported from
//     `@nanobpm/workflow`: author durable flows with `defineFlow` and the SDK
//     derives the executable BPMN, job types, and correlation wiring.
//
// The CLI (`urban`) is a separate entrypoint (bin) over this same API.
// Subpath imports are also available: `@nanobpm/urban/runtime` and
// `@nanobpm/urban/toolkit`.

// Runtime — app materialization + hosting
export * from "./runtime/index.ts";

// The nano-sdk engine client factory: build a client to talk to a Nano/Camunda
// engine directly, or type an `AppApi.sdk`. The runtime uses this same factory, so a
// code-first author reaches the full engine surface without a separate
// `@nanobpm/nano-sdk` dependency. (`EngineSdkClient`, its return type, is re-exported
// from ./runtime/index.ts above.)
export { createCamundaClient } from "@nanobpm/nano-sdk";

// Toolkit — derivation library (`urban gen`)
export * from "./toolkit/index.ts";

// Code-first process surface (re-exported from @nanobpm/workflow)
export {
  defineFlow,
  declarativeToBpmn,
  declarativeToLayoutedBpmn,
  externalJobTypes,
  inlineJobTypes,
  envelope,
  layoutBpmn,
  toBpmn,
  toDeployableBpmn,
  Worker,
  WorkflowClient,
  WorkflowError,
} from "@nanobpm/workflow";
export type {
  FlowBuilder,
  TimerStart,
  Envelope,
  EnvelopeType,
  EnvelopeField,
  FieldSpec,
  ScalarType,
  WorkflowClientOptions,
  NanoSdkClient,
  NanoJobWorker,
  JobWorkerConfig,
  ActivatedJob,
  WorkerOptions,
  ActivityEvent,
} from "@nanobpm/workflow";
