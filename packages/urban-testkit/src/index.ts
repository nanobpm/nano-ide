// @nanobpm/urban testkit — S1 (issue #157).
//
// A generic, in-CI e2e test kit for Urban apps, built on the WASM engine
// (`@nanobpm/engine-wasm`). S1 ships the WASM-backed {@link EngineClient} adapter
// and the reusable {@link runEngineClientContract} suite that pins the engine
// seam both this adapter and the live `@nanobpm/nano-sdk` adapter must satisfy.
// Later slices add `bootTestApp`, the deterministic settle loop, and the
// coverage/behaviour explorers.

export {
  createWasmEngineClient,
  type ProcessInstanceSnapshot,
  type ProcessInstanceState,
  WasmEngineClient,
  wasmStateToProcessInstanceState,
} from "./wasm-engine.ts";
export { runEngineClientContract } from "./contract.ts";
export { createManualScheduler, type ManualScheduler } from "./manual-scheduler.ts";
export { createTestHost, type CreateTestHostOptions, type TestHost } from "./test-host.ts";
export {
  bootTestApp,
  type BootTestAppOptions,
  type RouteRequest,
  type TestApp,
  type UiDriver,
} from "./boot-app.ts";
export {
  type AssertFullCoverageOptions,
  type CoverageReport,
  SurfaceCoverage,
  type SurfaceReport,
} from "./coverage.ts";
export {
  type ApiCallOptions,
  type ApiDriver,
  type ApiOperation,
  type ApiResponse,
  collectOperations,
  createApiDriver,
  type DriverRouteRequest,
  parseOpenApi,
} from "./openapi-driver.ts";

// Fluent assertion DSL (`assertThat*`) — issue #295. The barrel is wired here
// once; each matcher lives in its own `./assert/*.ts` file so the parallel
// matcher slices never collide on this file.
export {
  assertThatInstance,
  type IncidentSelector,
  type InstanceAssert,
} from "./assert/instance.ts";
export {
  assertThatUserTask,
  type UserTaskAssert,
  type UserTaskSelector,
} from "./assert/user-task.ts";
export { assertThatDb, type DbAssert, type TableAssert } from "./assert/db.ts";
export { assertThatResponse, type ResponseAssert } from "./assert/response.ts";
export {
  byKey,
  byProcessId,
  type InstanceSelector,
} from "./assert/selectors.ts";
