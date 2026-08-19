# __APP_NAME__

A **code-first** [Urban](https://github.com/nanobpm/nano-ide) app. Urban is a local‑first
RAD toolkit that runs applications on top of the [Nano](https://nanobpm.io) process
engine — Borland Delphi for BPMN. Here the process is authored in TypeScript with
`defineFlow`, and `@nanobpm/urban` derives the executable BPMN model from it.

## What's here

```
nano.app.json          the manifest — datasource, types, surfaces
workflows/*.ts         code-first processes (defineFlow) — the model is derived
scripts/greet.ts       start an instance (WorkflowClient.start)
db/migrations/*.sql    datasource schema (SQLite by default)
tests/*.test.ts        e2e tests (@nanobpm/urban-testkit, in-process WASM engine)
main.ts                entrypoint: runs Urban, deploys the flow, hosts the worker
```

Model-first apps drop a `.bpmn` under `resources/` (deploy-by-convention) and run with
`urban run`. A code-first app instead authors the flow in code and owns deployment +
worker hosting in `main.ts` — `@nanobpm/urban` derives the model, job types and message
names from `defineFlow`, emitting the executable `.bpmn` into `resources/processes/`
(where the same convention then deploys it). The derived `.bpmn` is ejectable to
model-first, so you never get stuck.

## Run it

You need a Nano engine reachable at `CAMUNDA_REST_ADDRESS` (default
`http://localhost:8080/v2`).

```bash
npm install
npm run typecheck  # type-check the app (Node/tsc by default; `deno check` under --deno)
npm run lint       # Biome + ban-`as` GritQL plugin
npm run check      # validate the manifest
npm run gen        # derive generated artifacts (migrations, worker-io types)
npm start          # provision the DB, deploy the flow, host the worker + surfaces
```

For a fast edit loop, use the dev server — it restarts on any change to `main.ts`,
`workflows/`, or `scripts/`:

```bash
npm run dev
```

<!-- if:deno -->
Or run it on **Deno** (no install step):

```bash
deno task typecheck
deno task lint
deno task check
deno task gen
deno task start    # or: deno task dev  (watch + restart)
```

<!-- /if:deno -->
Then start a greeting (in another terminal, with the app running):

```bash
npm run greet -- Adam
```

## Test it

Two e2e tests ship in `tests/`, powered by
[`@nanobpm/urban-testkit`](https://www.npmjs.com/package/@nanobpm/urban-testkit) (a
devDependency). They drive the app against an in-process WASM build of the engine — no
server, no wall-clock waits, CI-friendly.

- **`app.e2e.test.ts`** — the flagship test. It boots the app with
  `bootTestApp(root, { coverage: true })` — which deploys the process derived from your
  `defineFlow` — starts a `greet` instance through the in-process engine, and asserts the
  result with the fluent **`assertThat*` DSL**:
  `assertThatInstance(app, byProcessId("greet")).hasCompleted()...` reads the engine's
  process state and `assertThatDb(app).table("greetings").hasRow(...)` reads the app's
  SQLite. (A code-first app has no OpenAPI `api` binding, so there is no HTTP response to
  `assertThatResponse` over; add one and that matcher slots in the same way.) `bootTestApp`
  hosts the app's *manifest* surface but not the code-first `w.run` worker (that lives in
  `main.ts`), so the test stands that worker in with `app.mockWorker("greet:hello")`. At the
  end it asserts the **coverage gate** (`app.coverage.assertFullCoverage()`) — it fails if any
  declared worker was never exercised, so the suite grows a hole the moment you add a service
  task without a test.
- **`engine-contract.test.ts`** — a minimal smoke test of the engine seam
  (`runEngineClientContract`).

```bash
npm test
```
<!-- if:deno -->
On Deno: `deno task test`.
<!-- /if:deno -->

## Generated artifacts

`urban gen` derives files under `nano-generated/` from your manifest — SQL migrations
for your `types` (and worker-io types where models exist). They are regenerated (and
git-ignored), so don't edit them by hand. `npm run gen:check` reports whether the
on-disk artifacts are stale versus your current sources without rewriting them.

## Extend it

- Add steps to the flow in `workflows/greet.ts` (`w.run`, `w.task`, `w.signal`,
  `w.timer`, `w.switch`, `w.loop`) — the model is re-derived on deploy.
- Add another flow under `workflows/`, deploy it in `main.ts`, and add it to the
  `Worker({ workflows: [...] })` list.
- Add a domain type to `types` in the manifest and a migration under `db/migrations/`.

See the [Urban runtime docs](https://github.com/nanobpm/nano-ide/tree/main/packages/urban)
and the [code-first workflow surface](https://github.com/nanobpm/nano-ide/tree/main/packages/workflow).
