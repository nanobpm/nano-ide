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
truth for the coverage gate below).

## Coverage-exhaustive gate (S4)

Boot with `{ coverage: true }` and the harness derives the app's declared **surfaces** from
its *own* manifest + OpenAPI spec — never a second hand-written list — and records which
elements a test run actually exercises. `assertFullCoverage()` then **fails the build listing
any declared element that was never driven**, turning "we forgot to test operation X /
worker Y" from a silent gap into a red test.

Two surfaces ship in this slice:

- **`operations`** — every `operationId` in the app's OpenAPI document. Recorded when the
  test calls `app.api.call(operationId, …)` (even if the operation returns an error status —
  a driven-but-failing operation still counts as exercised).
- **`workers`** — every `workers[].taskType` in the manifest. Recorded automatically as the
  engine dispatches each job type, including workers a service task runs synchronously inside
  `createInstance`.

```ts
const app = await bootTestApp(appRoot, { coverage: true });
try {
  await app.api!.call("createOrder", { body: { item: "widget" } });
  await app.api!.call("getOrder", { params: { item: "widget" } });

  // Fails naming any operation/worker the test never drove:
  //   Coverage incomplete — declared surface elements were never exercised:
  //     operations: 1 un-exercised → cancelInstance
  app.coverage!.assertFullCoverage();
} finally {
  await app.stop();
}
```

`app.coverage.report()` returns per-surface `{ declared, exercised, missing, unexpected,
complete }` for a custom assertion, and `assertFullCoverage({ surfaces: ["operations"] })`
gates a chosen subset. Elements exercised outside the declared surface (e.g. an internal
system job type) surface as `unexpected` and are **informational only** — the gate fails on
`missing`, not on extras. Coverage is off by default (`app.coverage` is `undefined`), so a
plain `bootTestApp(root)` carries zero overhead.

The core (`SurfaceCoverage`) is surface-agnostic and free of any runtime import, so later
slices can add surfaces (webhook triggers, BPMN elements, SQLite tables) by declaring their
ids and recording hits — no change to the gate itself (issue #157).

## Fluent assertions — `assertThat*` (issue #295)

A fluent, intent-revealing assertion DSL for Urban e2e tests. Every matcher reads
synchronously from `snapshot()` / the engine read models and is fully
deterministic (no wall-clock, no polling); failures throw a `node:assert`
`AssertionError` that names the actual state. The public surface is wired through
the package barrel.

- **`assertThatInstance(app, keyOrSelector?)`** — assertions over a single
  process instance. The instance is selected by a bare process-instance key,
  `byKey(...)`, `byProcessId(...)`, or omitted for the single ACTIVE instance.
  Matchers: `isActive`, `hasCompleted`, `isTerminated`, `hasActiveElement(s)`,
  `hasCompletedElements`, `hasVariable`, `hasVariables`, `hasNoVariable`,
  `hasIncident`, `hasNoIncident`. Synchronous and chainable.

  ```ts
  assertThatInstance(app, processInstanceKey)
    .isActive()
    .hasActiveElement("work")
    .hasVariables({ who: "world" });
  assertThatInstance(app, byProcessId("order")).hasCompleted();
  ```

- **`assertThatUserTask(app, selector)`** — assertions over the user-task read
  model. `selector` is `{ instance?, elementId? }` (instance is a key, `byKey`,
  or `byProcessId`). Matchers are **async** — chain with `await`: `isCreated`,
  `isCompleted`, `hasAssignee`, `hasCandidateGroup`.

  ```ts
  await assertThatUserTask(app, { elementId: "review" })
    .isCreated()
    .then((a) => a.hasAssignee("alice"));
  ```

- **`assertThatDb(app).table(name)`** — assertions over `app.db`. Matchers are
  **async**: `hasRow(subset)`, `rowCount(n)`, `isEmpty`.

  ```ts
  await assertThatDb(app).table("orders").rowCount(1);
  ```

- **`assertThatResponse(res)`** — synchronous assertions over an already-resolved
  HTTP `ApiResponse`: `hasStatus`, `hasJson`, `hasHeader`.

  ```ts
  assertThatResponse(res).hasStatus(200).hasJson({ ok: true });
  ```

The shared selector resolver (`src/assert/selectors.ts`) — the single source of
truth for turning a key/`byKey`/`byProcessId`/default into a concrete instance —
and the failure-message helpers (`src/assert/format.ts`) back all matcher
families.
