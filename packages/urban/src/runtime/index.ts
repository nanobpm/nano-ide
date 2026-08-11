// Public API for the Urban runtime (@nanobpm/urban, subpath ./runtime).

// Core runtime
export { createUrbanApp } from "./core/runtime.ts";
export type {
  CreateUrbanAppOptions,
  MountFlags,
  UrbanApp,
} from "./core/runtime.ts";

// Manifest
export {
  expandEnv,
  expandEnvString,
  loadManifest,
  parseManifest,
  workerJobType,
} from "./core/manifest.ts";
export type {
  ActionDecl,
  AppManifest,
  ChatSurface,
  DataSource,
  DomainField,
  DomainType,
  LlmBinding,
  PagesSurface,
  Surfaces,
  TaskInboxSurface,
  Trigger,
  Worker,
} from "./core/manifest.ts";

// Validation
export {
  collectManifestIssues,
  ManifestValidationError,
  validateManifest,
} from "./core/validate.ts";
export type { ValidationIssue } from "./core/validate.ts";

// Host + engine contracts (for custom hosts / tests)
export type {
  EngineClient,
  EngineJob,
  HostContext,
  HttpHandler,
  HttpRequest,
  HttpResponse,
  HttpServer,
  JobHandler,
  SqliteDb,
  WatchHandle,
  WorkerSubscription,
} from "./core/host.ts";
export type { AppApi, Mounted, RuntimeContext } from "./core/context.ts";
// Structured logging surface (see core/logger.ts): the shape of `AppApi.log`, plus `createLogger`
// so consumers can build a Logger for a custom sink or a no-op test double (`createLogger(() => {})`).
export { createLogger } from "./core/logger.ts";
export type { Logger, LogLevel, LogFields, LogSink } from "./core/logger.ts";

// BPMN error contract: a handler throws `BpmnError(code)` to raise a modelled
// error routed to an error boundary (ADR 0050), instead of a retryable failure.
export { BpmnError, isBpmnError } from "./core/host.ts";

// Connector packs (ADR 0050, in-process port)
export {
  adaptConnectorHandler,
  mountConnectors,
  resolveInstalledConnectors,
} from "./core/modules/connectors.ts";
export type { ConnectorsHandle } from "./core/modules/connectors.ts";

// Data layer
export { DataLayer, TypeRepo } from "./core/modules/datasource.ts";
export type { ProvisionedSource } from "./core/modules/datasource.ts";
export { runDataOp } from "./core/modules/dataops.ts";
export type { DataOp, DataRequest, ResolvedSource } from "./core/modules/dataops.ts";
export { makeGateway, Table } from "./core/modules/gateway.ts";
export type {
  ColumnMeta,
  DataSource as GatewayDataSource,
  ExecResult,
  ForeignKeyMeta,
  Row,
  TableMeta,
} from "./core/modules/gateway.ts";
export { createPagesRoutes, mountPages } from "./core/modules/pages.ts";
export type { PagesDataSource, PagesDeps, PagesHandle, PagesOptions } from "./core/modules/pages.ts";
export { cancelInstanceReconciling } from "./core/modules/cancel.ts";
export type { CancelInstanceResult, CancelInstanceState } from "./core/modules/cancel.ts";
export { mountActions, resolveActionHandler } from "./core/modules/actions.ts";
export type { ActionHandler, ActionRequest, ActionResult, ActionsHandle } from "./core/modules/actions.ts";
export { defineOperation, mountApi, resolveOperationHandler, NotImplemented } from "./core/modules/api.ts";
export type {
  ApiBinding,
  ApiHandle,
  DefaultContract,
  OperationContract,
  OperationHandler,
  OperationInput,
  OperationResult,
} from "./core/modules/api.ts";
export type { AppJobHandler } from "./core/modules/workers.ts";
export { resolveHandler, sdkDecisionEvaluator } from "./core/modules/workers.ts";
export {
  buildMessages,
  callLlm,
  resolveProvider,
  runLlmJob,
} from "./core/modules/llm.ts";
export type {
  ChatMessage,
  DecisionEvaluator,
  EnvLookup,
  LlmRuntime,
  LlmVars,
  ProviderConfig,
} from "./core/modules/llm.ts";
export { evalCorrelation } from "./core/modules/triggers.ts";

// Model deploy + `{{name}}` template substitution
export { deployModels } from "./core/modules/deploy.ts";
export { applyTemplates, resolveTemplates } from "./core/modules/templates.ts";
export type { TemplateApplication, TemplateSource } from "./core/modules/templates.ts";
export { defaultScheduler, MAX_TIMER_DELAY_MS } from "./core/modules/scheduler.ts";
export type { SchedulerDeps } from "./core/modules/scheduler.ts";

// Adapters + engine + run entrypoint
export { createNodeHost } from "./adapters/node.ts";
export { createDenoHost } from "./adapters/deno.ts";
export { isDeno, selectHost } from "./adapters/detect.ts";
export { createNanoSdkEngineClient, SdkEngineClient } from "./engine/nanosdk.ts";
export type {
  NanoSdkClient,
  NanoSdkEngineOptions,
  NanoSdkJobWorker,
  NanoSdkJobWorkerConfig,
} from "./engine/nanosdk.ts";
export type { EngineSdkClient } from "./engine/sdk.ts";
export { installSignalHandlers, runFromEnv } from "./run.ts";
export type { RunOptions } from "./run.ts";
export { runDev, shouldReload } from "./devserver.ts";
export type { DevDeps, DevOptions, DevServer } from "./devserver.ts";
