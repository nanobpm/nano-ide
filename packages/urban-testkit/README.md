# @nanobpm/urban-testkit

Generic, in-CI end-to-end test kit for [Urban](https://www.npmjs.com/package/@nanobpm/urban) apps.

Urban apps are code-first apps on the Nano BPMN engine with four surfaces — processes,
SQLite, workers, and UI actions. This kit lets you drive them deterministically, in
process, with no wall-clock waits, using the WASM build of the engine
(`@nanobpm/engine-wasm`).

Install it as a **devDependency** of your Urban app. Because the kit — not
`@nanobpm/urban` — owns the WASM engine, the engine never lands in your app's
production install.

```sh
npm i -D @nanobpm/urban-testkit
```

## What's here (S1)

- **`createWasmEngineClient()` / `WasmEngineClient`** — a WASM-backed implementation of
  Urban's `EngineClient` seam. Same contract the live `@nanobpm/nano-sdk` adapter
  implements, so tests written against it behave like the real engine, but
  deterministically. Pull-based `activateJobs`/`completeJob` is bridged to the push
  worker semantics the runtime expects by draining registered workers to quiescence
  after every mutating call. Virtual clock via `advanceTime`.
- **`runEngineClientContract(label, makeEngine)`** — a reusable, adapter-agnostic
  contract suite (deploy → create → work → complete/cancel, user tasks, boundary
  errors, timers, unsubscribe). Run it against any `EngineClient` to pin the seam that
  both adapters must satisfy — including the state-mapping projection
  (`Terminating → TERMINATED`) behind the cancelled-instance reconcile bug this kit
  exists to prevent.

```ts
import { runEngineClientContract, createWasmEngineClient } from "@nanobpm/urban-testkit";

runEngineClientContract("wasm", () => createWasmEngineClient());
```

Runs on Node (`node --test`) and Deno; the adapter is runtime-agnostic.

Later slices add `bootTestApp`, a deterministic `settle()` loop, and the
coverage/behaviour explorers (issue #157).
