// Public API for the Urban runtime (@nanobpm/urban, subpath ./runtime).

// Core runtime
export { createUrbanApp } from "./core/runtime.ts";
export type {
  CreateUrbanAppOptions,
  MountFlags,
  UrbanApp,
} from "./core/runtime.ts";

// Extension-event taxonomy + microkernel (issue #262)
export { EventBus } from "./core/events.ts";
export type {
  DispatchMode,
  Disposer,
  EmitChannel,
  ErrorSink,
  EventBusOptions,
  Listener,
  Middleware,
  ParallelChannel,
  SerialChannel,
  WaterfallChannel,
} from "./core/events.ts";
export { URBAN_EVENT_MODES, createUrbanEvents, mountExtensions, urbanEventMode } from "./core/extensions.ts";
export type {
  DispatchRequest,
  DispatchResponse,
  ExtensionHost,
  ExtensionRegistered,
  ExtensionSetupContext,
  GateDecision,
  GateRequest,
  LifecycleEvent,
  MountExtensionsOptions,
  ReconcileEvent,
  UrbanEventName,
  UrbanEvents,
  UrbanExtension,
} from "./core/extensions.ts";

// Manifest
export {
  bindModeToHost,
  expandEnv,
  expandEnvString,
  isBindMode,
  loadManifest,
  parseManifest,
  resolveBindHost,
  resolveBindMode,
  workerJobType,
  ALL_INTERFACES_HOST,
  BIND_ENV_VAR,
  LOOPBACK_HOST,
} from "./core/manifest.ts";
export type {
  ActionDecl,
  AppManifest,
  BindMode,
  ChatSurface,
  DataSource,
  DomainField,
  DomainType,
  LlmBinding,
  NetworkConfig,
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
  FormSchema,
  HostContext,
  HttpHandler,
  HttpRequest,
  HttpResponse,
  HttpServer,
  JobHandler,
  ProcessInstanceSnapshot,
  ProcessInstanceState,
  SqliteDb,
  UserTaskState,
  UserTaskSummary,
  WatchHandle,
  WorkerSubscription,
} from "./core/host.ts";
// Shared form/user-task contract normalization (issue #252): the single source of truth
// both engine adapters (SDK/REST + WASM test double) call, so their form-identifier,
// form-schema, and user-task form-linkage handling cannot drift.
export {
  buildFormSchema,
  parseFormSchema,
  pickFormLinkage,
  presentFormIdentifier,
  resolveFormIdentifier,
} from "./core/form-contract.ts";
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

// Lineage — the framework-level lineage primitive (issue #254): the `_urban.lineage`
// envelope + auto-threading, and the generic read projection that stitches user intent →
// progress (a root request → the instances/PRs/tasks it causes).
export {
  applyAmbientLineage,
  buildLineageTree,
  deriveLineage,
  LINEAGE_KEY,
  LINEAGE_NAMESPACE,
  mintRootRequestKey,
  readLineage,
  writeLineage,
} from "./core/lineage.ts";
export type {
  ApplyLineageOptions,
  LineageAttachment,
  LineageEdge,
  LineageEdgeType,
  LineageEnvelope,
  LineageNode,
  LineageTree,
} from "./core/lineage.ts";
export {
  LINEAGE_ATTACHMENTS_TABLE,
  LINEAGE_EDGES_TABLE,
  LINEAGE_SCHEMA_SQL,
  LineageStore,
  systemClock as lineageSystemClock,
} from "./core/modules/lineage-store.ts";
export type {
  Clock as LineageClock,
  LineageJobLike,
  LineageStoreOptions,
} from "./core/modules/lineage-store.ts";

// Model deploy (deploy-by-convention under `resources/`, ADR 0062)
export { deployModels, RESOURCES_DIR } from "./core/modules/deploy.ts";
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
