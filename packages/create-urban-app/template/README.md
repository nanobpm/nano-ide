# __APP_NAME__

An [Urban](https://github.com/nanobpm/nano-ide) app. Urban is a local‑first RAD toolkit
that turns a declarative manifest (`nano.app.json`) into a running application on top of the
[Nano](https://nanobpm.io) process engine — Borland Delphi for BPMN.

## What's here

```
nano.app.json         the manifest — the whole app, declared
processes/*.bpmn      BPMN process models
forms/*.form          form-js user task forms
db/migrations/*.sql   datasource schema (SQLite by default)
workers/*.ts          service-task handlers (host-agnostic TypeScript)
main.ts               entrypoint (calls the Urban runtime)
```

The manifest is the contract; the runtime is the interpreter; the host runs on **Node**
by default (the runtime is host-agnostic — Deno is supported too). You never eject.

## Run it

You need a Nano engine reachable at `CAMUNDA_REST_ADDRESS` (default
`http://localhost:8080/v2`).

```bash
npm install
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
deno task check
deno task gen
deno task start    # or: deno task dev  (hot reload)
```

<!-- /if:deno -->
Then trigger the demo:

```bash
curl -X POST localhost:8090/hooks/greet -H 'content-type: application/json' \
  -d '{"who":"Adam"}'
```

## Generated artifacts

`urban gen` derives files under `nano-generated/` from your manifest and models — SQL
migrations for your `types` and a `.d.ts` of worker input/output shapes. They are
regenerated (and git-ignored), so don't edit them by hand; `npm run dev` reruns `gen` on
every change. `npm run gen:check` reports whether the on-disk artifacts are stale versus
your current sources without rewriting them.

## Extend it

- Add a `.bpmn` under `processes/` and a matching worker under `workers/`.
- Add a domain type to `types` in the manifest and a migration under `db/migrations/`.
- Enable more surfaces (task inbox, chat) or triggers in the manifest.

See the [Urban runtime docs](https://github.com/nanobpm/nano-ide/tree/main/packages/urban).
