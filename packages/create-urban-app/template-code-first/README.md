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
main.ts                entrypoint: runs Urban, deploys the flow, hosts the worker
```

Model-first apps declare `processes/*.bpmn` in the manifest and run with `urban run`.
A code-first app instead authors the flow in code and owns deployment + worker hosting
in `main.ts` — `@nanobpm/urban` derives the model, job types and message names from
`defineFlow`. The derived `.bpmn` is ejectable to model-first, so you never get stuck.

## Run it

You need a Nano engine reachable at `CAMUNDA_REST_ADDRESS` (default
`http://localhost:8080/v2`).

```bash
npm install
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
deno task check
deno task gen
deno task start    # or: deno task dev  (watch + restart)
```

<!-- /if:deno -->
Then start a greeting (in another terminal, with the app running):

```bash
npm run greet -- Adam
```

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
