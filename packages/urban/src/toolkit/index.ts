// The Urban derivation toolkit — the shared derivation library. The IDE and the
// `urban gen` CLI are peer callers of these pure derivers (ADR 0053). Code-first
// process authoring is provided by `@nanobpm/workflow` (`defineFlow`), not here
// (ADR 0054) — the toolkit derives migrations and worker I/O from the model.

// Artifact + deriver contract
export type { DerivedArtifact, Deriver } from "./artifact.ts";
export { GENERATED_DIR, sortArtifacts } from "./artifact.ts";

// Derivers
export {
  deriveMigrations,
  migrationsDeriver,
  sqlType,
  createTableSql,
  tableSchemaForType,
  groupTypesBySource,
} from "./derivers/migrations.ts";
export type {
  ToolkitManifest,
  ToolkitType,
  ToolkitField,
  DerivedColumn,
  DerivedTable,
} from "./derivers/migrations.ts";

export {
  deriveDomain,
  emitDomain,
  emitDomainModel,
  emitDomainBindings,
  emitDomainDts,
  emitDomainDtsForSources,
  emitDomainTypeRegistry,
  domainDeriver,
  isPrimitiveKeyword,
  sourcesFromManifest,
  registryFromManifest,
  sqliteAffinityToTs,
  interfaceName,
  DOMAIN_BINDINGS,
} from "./derivers/domain.ts";
export type {
  SourceSchema,
  DomainFieldDef,
  DomainTypeDef,
  DomainTypeRegistry,
  ColumnMeta,
  TableMeta,
} from "./derivers/domain.ts";

export {
  resolveShapes,
  columnToField,
  emitDomainModelJson,
  DOMAIN_MODEL_JSON,
} from "./derivers/shapes.ts";
export type {
  ShapeOp,
  ShapeDecl,
  ShapeDiagnostic,
  ShapeResolution,
  FusedMetaDecl,
} from "./derivers/shapes.ts";

export {
  deriveWorkerBindings,
  emitWorkerBindings,
  emitWorkerBindingsRuntime,
  overlayDerivedWorkerIo,
  workerIoDeriver,
  scanModelWorkers,
  WORKER_BINDINGS_DTS,
  WORKER_BINDINGS_TS,
  DOMAIN_DTS,
} from "./derivers/worker-io.ts";
export type { ModelSource, WorkerIo, WorkerBindingDecl } from "./derivers/worker-io.ts";
export { byModelPath, typeRefFor } from "./derivers/worker-io.ts";

export {
  deriveMeta,
  emitMeta,
  foldMeta,
  metaDeriver,
  scanModelMeta,
  META_TS,
} from "./derivers/meta.ts";
export type { MetaDecl } from "./derivers/meta.ts";

export {
  deriveMessageBindings,
  emitMessageBindings,
  emitMessageBindingsRuntime,
  messagesDeriver,
  scanModelMessages,
  MESSAGE_BINDINGS_DTS,
  MESSAGE_BINDINGS_TS,
} from "./derivers/messages.ts";
export type { MessageIo, MessageBindingDecl } from "./derivers/messages.ts";

export {
  apiDeriver,
  deriveApi,
  emitApiBindings,
  emitApiBindingsRuntime,
  schemaToTs,
  API_BINDINGS_DTS,
  API_BINDINGS_TS,
} from "./derivers/api.ts";

// The OpenAPI machinery the deriver + runtime share (ADR 0058).
export {
  collectOperations,
  HTTP_METHODS,
  isSafeOperationId,
  operationsWithoutId,
  operationsWithUnsafeId,
  parseSpec,
  refName,
  resolveSchema,
  toRouteMatcher,
  undeclaredPathParams,
  validateValue,
} from "../openapi/spec.ts";
export type {
  HttpMethodLower,
  OpenApiDoc,
  OpenApiParameter,
  OpenApiSchema,
  OperationInfo,
} from "../openapi/spec.ts";

// The registry of all derivers (for discovery / IDE migration).
import { migrationsDeriver } from "./derivers/migrations.ts";
import { domainDeriver } from "./derivers/domain.ts";
import { workerIoDeriver } from "./derivers/worker-io.ts";
import { metaDeriver } from "./derivers/meta.ts";
import { messagesDeriver } from "./derivers/messages.ts";
import { apiDeriver } from "./derivers/api.ts";
export const DERIVERS = [
  migrationsDeriver,
  domainDeriver,
  workerIoDeriver,
  metaDeriver,
  messagesDeriver,
  apiDeriver,
] as const;

// Gen orchestrator + IO
export { collectArtifacts, runGen, joinPath, readModels, expandPattern, previewModels } from "./gen.ts";
export type { GenIO, GenOptions, GenResult } from "./gen.ts";
export { createNodeGenIO } from "./fsio.ts";

// Code-first model derivation (workflows/*.ts → BPMN)
export {
  deriveModels,
  isWorkflow,
  bpmnFilename,
  processesOutDir,
  DEFAULT_WORKFLOW_PATTERNS,
  PROCESSES_DIR,
  MODEL_PROVENANCE,
} from "./models.ts";
export type { DerivedModels, DerivedModelInfo, ModelError, ModelsManifest } from "./models.ts";

// Worker-stub scaffolder (ADR 0056): write-once handler stubs from the model.
export {
  planWorkerScaffold,
  renderWorkerStub,
  slugifyTaskType,
} from "./scaffold/workers.ts";
export type {
  ScaffoldWorker,
  SkippedWorker,
  SkipReason,
  StubManifestEntry,
  WorkerScaffoldPlan,
  WorkerStubPlan,
} from "./scaffold/workers.ts";
export { scaffoldWorkers } from "./scaffold.ts";
export type { ScaffoldOptions, ScaffoldRun, StubOutcome, StubStatus } from "./scaffold.ts";

export { addConnector } from "./addConnector.ts";
export type { AddConnectorOptions, AddConnectorResult } from "./addConnector.ts";
