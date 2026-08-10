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
