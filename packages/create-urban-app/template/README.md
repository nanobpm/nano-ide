# __APP_NAME__

An [Urban](https://github.com/nanobpm/nano-ide) app. Urban is a local‑first RAD toolkit
that turns a declarative manifest (`nano.app.json`) into a running application on top of the
[Nano](https://nanobpm.io) process engine — Borland Delphi for BPMN.

## What's here

```
nano.app.json         the manifest — the whole app, declared
openapi.json          the app's REST API contract (OpenAPI); Swagger UI for free
operations/*.ts       one delegate per operationId (you write only the body)
pages/*.page.json     the home UI (a declarative, data-bound screen)
processes/*.bpmn      BPMN process models
forms/*.form          form-js user task forms
db/migrations/*.sql   datasource schema (SQLite by default)
workers/*.ts          service-task handlers (host-agnostic TypeScript)
tests/*.test.ts       e2e tests (@nanobpm/urban-testkit, in-process WASM engine)
main.ts               entrypoint (calls the Urban runtime)
```

Everything is wired end-to-end. Sending a greeting — from the home page, the REST API,
or the webhook — publishes the **same** message; the BPMN process correlates it, the
`greet` worker records a row, and it shows up in the page's grid and in `GET /greetings`:

```
UI form / POST /greetings / POST /hooks/greet
        │  (publishMessage "greet-requested")
        ▼
   greet.bpmn (message start) ──▶ workers/greet.ts ──▶ greetings table
        │                                                    │
        └───────────────────────── GET /greetings ◀──────────┘  (and the home grid)
```


The manifest is the contract; the runtime is the interpreter; the host runs on **Node**
by default (the runtime is host-agnostic — Deno is supported too). You never eject.

## Run it

You need a Nano engine reachable at `CAMUNDA_REST_ADDRESS` (default
`http://localhost:8080/v2`).

```bash
npm install
npm run typecheck  # Deno-powered TypeScript check (requires Deno on PATH)
npm run lint       # Biome + ban-`as` GritQL plugin
npm run check      # validate the manifest
npm run gen        # derive generated artifacts (migrations, worker-io types)
npm start          # deploy models, provision the DB, start workers + surfaces
```

For a fast edit loop, use the dev server — it derives once, starts the app, then
**hot-reloads** whenever you change a model, form, migration, type or worker:

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
deno task start    # or: deno task dev  (hot reload)
```

<!-- /if:deno -->
Then open the app and trigger the demo:

- **Home UI** — <http://localhost:8090/> — send a greeting and watch the grid update.
- **API docs** — <http://localhost:8090/app/api-docs> — Swagger UI for the REST API
  (linked from the "API docs ↗" badge on the home page). It's generated from
  `openapi.json` for free; use "Try it out" to call the API live.

```bash
# Same flow, three ways in — all publish the greet message:
curl -X POST localhost:8090/app/api/greetings -H 'content-type: application/json' -d '{"who":"Adam"}'
curl -X POST localhost:8090/hooks/greet       -H 'content-type: application/json' -d '{"who":"Eve"}'
curl localhost:8090/app/api/greetings         # list what the process recorded
```

## API & docs

The app is **OpenAPI-first**. `openapi.json` is the API contract; Urban derives the route
table, typed request/response contracts, and runtime validators from it, and calls one
delegate per `operationId` under `operations/`. You write only the delegate body.

- **Swagger UI** is served automatically at `/app/api-docs` — no config, no build step.
- The raw spec (with `servers` pointed at the live base) is at `/app/api-docs/openapi.json`.

Add an endpoint: declare the path + a unique `operationId` in `openapi.json`, then create
`operations/<operationId>.ts` exporting `defineOperation("<operationId>", (input, app) => …)`.
`npm run dev` picks it up on save.


## Test it

A starter e2e test ships in `tests/`, powered by
[`@nanobpm/urban-testkit`](https://www.npmjs.com/package/@nanobpm/urban-testkit) (a
devDependency). It drives the app against an in-process WASM build of the engine — no
server, no wall-clock waits, CI-friendly.

```bash
npm test
```
<!-- if:deno -->
On Deno: `deno task test`.
<!-- /if:deno -->

## Generated artifacts

`urban gen` derives files under `nano-generated/` from your manifest and models — SQL
migrations for your `types` and a `.d.ts` of worker input/output shapes. They are
regenerated (and git-ignored), so don't edit them by hand; `npm run dev` reruns `gen` on
every change. `npm run gen:check` reports whether the on-disk artifacts are stale versus
your current sources without rewriting them.

## Next steps

- **Add an API endpoint** — a path + `operationId` in `openapi.json`, then
  `operations/<operationId>.ts`. Swagger picks it up automatically.
- **Add a screen** — drop a `*.page.json` under `pages/` (nav, text, `actionForm`,
  `dataGrid` nodes). Link it from the `nav` items.
- **Add a process step** — a `.bpmn` under `processes/` and a matching worker under
  `workers/`.
- **Add a domain type** — an entry in `types` in the manifest and a migration under
  `db/migrations/`.
- **Enable more surfaces** (task inbox, chat) or triggers in the manifest.

See the [Urban runtime docs](https://github.com/nanobpm/nano-ide/tree/main/packages/urban).
