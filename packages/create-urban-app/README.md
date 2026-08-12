# `create-urban-app`

Scaffold a new, runnable Urban app in one command.

## Create an app

```bash
npm create urban-app my-app
# or, if you have the CLI installed:
urban new my-app
```

This creates a `my-app/` directory:

```
my-app/
  nano.app.json          # the manifest: the app's contract
  processes/greet.bpmn   # a process (with layout; opens in the modeller)
  forms/greeting.form    # a form
  db/migrations/001_init.sql
  workers/greet.ts       # a job worker
  tests/app.e2e.test.ts  # e2e tests (@nanobpm/urban-testkit)
  main.ts                # entrypoint that runs the app
  package.json           # npm run scripts
  .gitignore
  README.md
```

Pass `--deno` to additionally emit a `deno.json` (Deno tasks + import map) and the
Deno usage docs. The scaffold defaults to Node to keep the authoring experience
simple; the Urban runtime itself is host-agnostic, so `--deno` is purely additive.

### Model-first or code-first

By default the scaffold is **model-first**: the process is an authored
`processes/greet.bpmn`, run by `urban run`. Pass `--code-first` (or `--style code`)
to scaffold a **code-first** app instead — the process is authored in TypeScript with
[`defineFlow`](../workflow) under `workflows/`, and `@nanobpm/urban` derives the
executable model. A code-first app owns process deployment and worker hosting in its
`main.ts`, and is started via a script (`npm run greet -- Adam`):

```
my-app/
  nano.app.json          # the manifest: datasource, types, surfaces
  workflows/greet.ts     # a defineFlow process (the model is derived)
  scripts/greet.ts       # start an instance (WorkflowClient.start)
  db/migrations/001_init.sql
  main.ts                # runs Urban, deploys the flow, hosts the worker
  package.json
  .gitignore
  README.md
```

## Run it

```bash
cd my-app
npm install
npm start                # or: npx urban run
```

`npm start` generates the app's `nano-generated/` artifacts and starts it against a
nano-bpm engine (set `CAMUNDA_REST_ADDRESS`, default `http://localhost:8080/v2`).
The scaffolded `package.json` also exposes `check`, `dev` and `deploy` scripts. With
`--deno`, the equivalent `deno task <name>` commands are available too.

## Test it

Every scaffold ships e2e tests wired to
[`@nanobpm/urban-testkit`](../urban-testkit), which runs the app against an in-process
WASM build of the engine — no server, no wall-clock waits, CI-friendly:

```bash
cd my-app
npm test
```

A **model-first** app gets a flagship `tests/app.e2e.test.ts` that boots the whole app,
drives the full `POST → process → worker → GET` pipeline, and asserts a **coverage
gate** (`assertFullCoverage()`) that fails if any operation or worker is left
un-exercised. A **code-first** app gets an engine-contract smoke test. See the generated
`README.md`'s "Test it" section for how to extend the suite.

## Options

| Flag | Purpose | Default |
|---|---|---|
| `--dir <path>` | target directory | `./<name>` (slugified) |
| `--id <slug>` | app id in the manifest | derived from the name |
| `--preset <full\|headless>` | `full` includes surfaces, triggers and forms; `headless` is workers-only | `full` |
| `--style <model\|code>` | `model` scaffolds an authored `.bpmn`; `code` scaffolds a `defineFlow` app | `model` |
| `--code-first` | shorthand for `--style code` | — |
| `--deno` | also emit `deno.json` + Deno docs | Node only |

## Related packages

- [`@nanobpm/urban`](../urban) — the runtime, derivation toolkit, and CLI (`urban new`, `run`, `gen`, `check`, `deploy`) in one package.
- [`@nanobpm/workflow`](../workflow) — the code-first process surface (`defineFlow`).
- [`@nanobpm/urban-testkit`](../urban-testkit) — the in-process WASM e2e harness the scaffold's tests are built on (`bootTestApp`, coverage gate).
