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

## Booting a whole app (S2 + S3)

**`bootTestApp(root, opts?)`** boots a real Urban app in-process against the WASM engine
and a **virtual clock** — no ports, no wall-clock waits, no polling races. It returns a
harness over every surface plus deterministic time control:

- `app.ui.call(req)` — the low-level in-process router (method, path, query, headers, body).
- `app.api` — a **spec-driven** operations driver, or `undefined` when the app has no
  `api` binding. It reads the booted app's *own* OpenAPI document (JSON or YAML) and lets
  you call operations by `operationId`, so a test never hard-codes a route path or method
  and can never drift from the surface it drives.
- `app.callRoute(req)` — a response-parsing wrapper over `ui.call` for page actions, hooks,
  or any raw path (available with or without an `api` binding).
- `app.db` — the provisioned data layer; `app.engine` — the WASM engine; `app.snapshot()`.
- `app.settle()` — drive to a fixpoint at the current instant; `app.advanceTime(ms)` — the
  only way time moves (engine + background-loop timers in lockstep, then settle).

```ts
import { bootTestApp } from "@nanobpm/urban-testkit";

const app = await bootTestApp(appRoot);
try {
  // Call an operation by its operationId — path/method/base come from the app's spec.
  const res = await app.api!.call("startConvergenceLoop", { body: { pr: "acme/web#42" } });
  //   → fills the `/app/api` base + path template, sets content-type, JSON-serializes body

  // A path parameter fills the operation's `{name}` placeholders:
  const one = await app.api!.call("getOrder", { params: { item: "widget" } });

  // Drive a raw route (page action, webhook, hook) by exact path:
  await app.callRoute({ method: "POST", path: "/hooks/order", body: JSON.stringify({ item: "x" }) });

  // Reconcile a terminated instance's tracking row deterministically (no 15s poll wait):
  await app.advanceTime(5000);
} finally {
  await app.stop();
}
```

`app.api.operationIds()` and `app.api.operation(id)` enumerate the surface (the source of
truth for a future coverage gate).

Later slices add the coverage/behaviour explorers (issue #157).
