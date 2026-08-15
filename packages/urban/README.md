# `@nanobpm/urban`

Build and run **code-first apps on Nano** — the runtime, the derivation toolkit,
and the `urban` CLI in one package, on **Node or Deno**.

An Urban app is a directory with a `nano.app.json` manifest that declares its
processes, forms, datasources, workers, HTTP surfaces and triggers. This package
brings it to life and gives you a library API to embed or extend it. Author your
durable processes in code with [`@nanobpm/workflow`](../workflow)
(`defineFlow`) — re-exported from here for convenience.

## Install

```bash
npm i -g @nanobpm/urban      # install the `urban` command
# or run without installing:
npx @nanobpm/urban new my-app
# or on Deno:
deno run -A npm:@nanobpm/urban run
```

Requires Node ≥ 22.6 or Deno. It ships as compiled JavaScript with `.d.ts` type
declarations: Node can't strip types under `node_modules`, so the published package
carries `dist/` and needs no build step or `--experimental-strip-types` flag to run.
Deno users can still import the TypeScript source directly via the `./source` export.

## The `urban` CLI

| Command | What it does |
|---|---|
| `urban new <name>` | scaffold a new app in a new directory |
| `urban check` | validate the app's `nano.app.json` manifest |
| `urban gen` | generate the `nano-generated/` artifacts (migrations, worker I/O) |
| `urban gen --check` | fail if the generated artifacts are out of date (a CI drift gate) |
| `urban run` | generate, then run the app — starts its workers and serves its surfaces |
| `urban dev` | run the app (hot-reload is not yet implemented) |
| `urban deploy` | deploy the app's models to the engine, then exit |

### Options

| Flag | Purpose | Default |
|---|---|---|
| `--root <dir>` | app directory | `.` |
| `--manifest <file>` | manifest filename | `nano.app.json` |
| `--port <n>` | HTTP port for surfaces and triggers (integer 0–65535) | `$PORT` or `8090` |
| `-h`, `--help` | show help | |
| `-v`, `--version` | print the version | |

The engine address comes from `$CAMUNDA_REST_ADDRESS` (default
`http://localhost:8080/v2`). Transport comes from `$CAMUNDA_TRANSPORT` (default
`auto`): the `@nanobpm/nano-sdk` client upgrades instance creation and job
serving to Falcon on a Nano server and falls back to REST elsewhere. Set it to
`rest`, `falcon`, or `embedded` to pin a specific transport.

### Network bind interface

By default an app's HTTP server binds to **loopback only** (`127.0.0.1`) — secure
by default, so surfaces, triggers and capability hooks are unreachable from other
machines. To make the app reachable from other hosts on the LAN (e.g. a
distributed worker fleet), opt in with the app-level `network.bind` manifest
setting:

```jsonc
// nano.app.json
{
  "network": { "bind": "loopback" }  // default — 127.0.0.1, refuses off-box connections
  // "network": { "bind": "all" }    // 0.0.0.0 — reachable across the LAN
}
```

| `network.bind` | Bind address | Reachability |
|---|---|---|
| `"loopback"` (default) | `127.0.0.1` | this machine only |
| `"all"` | `0.0.0.0` | every interface / the LAN |

Ops can override the manifest at deploy time with the `URBAN_BIND` environment
variable (`URBAN_BIND=all` or `URBAN_BIND=loopback`); a valid value wins over the
manifest, the manifest stays the declarative default. Binding to all interfaces
emits a startup `warn` log because it exposes the app off-box.

> **Security:** binding to all interfaces exposes the app's token-gated capability
> hooks on the LAN. Any LOCAL-mode "well-known localhost" credential (e.g. the
> agentic channel's LOCAL mode) must **not** be served on a non-loopback bind — a
> consumer that mints one must gate it on a loopback bind.


### A typical session

```bash
urban new invoices && cd invoices
urban gen        # generate nano-generated/
urban check      # validate the manifest
urban run        # start workers and serve surfaces
```

## Library API

Everything the CLI does is available programmatically. Import the whole surface
from `@nanobpm/urban`, or the focused subpaths `@nanobpm/urban/runtime`,
`@nanobpm/urban/toolkit`, and `@nanobpm/urban/effect`.

### Runtime — run an app

```ts
import { runFromEnv } from "@nanobpm/urban";

const app = await runFromEnv();          // reads ./nano.app.json and the environment
console.log(app.inspect());              // { app, name, httpPort, ... }
```

`runFromEnv` reads the engine address and transport from the environment, starts
the app (validate → deploy → provision datasources → start workers → serve
surfaces and webhook + cron triggers), and installs SIGINT/SIGTERM handlers for a
graceful shutdown. For full control, assemble the pieces yourself:

```ts
import { createUrbanApp, selectHost, createNanoSdkEngineClient } from "@nanobpm/urban";

const host = selectHost();                       // picks the Node or Deno adapter
const engine = await createNanoSdkEngineClient({
  restAddress: process.env.CAMUNDA_REST_ADDRESS!,
  transport: process.env.CAMUNDA_TRANSPORT,      // "auto" (default) | "rest" | "falcon" | "embedded"
});
const app = await createUrbanApp({ host, engine, root: "." });
await app.start();
// ... later:
await app.stop();                                // releases workers, server, datasources
```

The runtime has a single engine client, `SdkEngineClient`, backed by one
`@nanobpm/nano-sdk` client (a direct dependency). `createNanoSdkEngineClient`
selects the wire transport via `CAMUNDA_TRANSPORT`: `auto` (default) upgrades to
Falcon on a Nano server and falls back to REST elsewhere.

### Structured logging

Every worker handler and API route delegate receives an `AppApi` whose `log` is a
level-tagged structured logger (ADR 0061):

```ts
app.log.info("charge captured", { amount, currency });
app.log.warn("retrying", { attempt });
app.log.error("charge failed", { code });
app.log.debug("gateway response", { raw });   // hidden unless URBAN_LOG_LEVEL=debug

const orderLog = app.log.child({ orderId });    // bind context for a scope
orderLog.info("shipped");                        // every line carries orderId
```

The runtime **auto-correlates**: a worker handler's `app.log` is pre-bound to
`{ jobKey, jobType, processInstanceKey, elementId }` and a route delegate's to
`{ method, path, operationId }`, so every line you emit is tied to its job/request
for free.

The `UrbanApp` handle returned by `runFromEnv`/`createUrbanApp` also carries an
app-level `app.log` (no per-request correlation) for the entrypoint's boot/shutdown
lines:

```ts
const app = await runFromEnv();
app.log.info("started", { httpPort: app.httpPort });
```

Records are written as **NDJSON** — one JSON object per line,
`{"ts":…,"level":…,"msg":…, …fields}` — with `warn`/`error` on stderr and
`debug`/`info` on stdout. `URBAN_LOG_LEVEL` (default `info`) sets the minimum level.

> **Custom hosts:** the `HostContext.log` sink now accepts `"debug"` in addition to
> `"info" | "warn" | "error"`. A custom host that typed `log` with the narrower union must add a
> `"debug"` branch to keep satisfying the contract — a breaking change for that surface only.

### Toolkit — derive artifacts (`urban gen`)

```ts
import { runGen, createNodeGenIO } from "@nanobpm/urban";

const io = createNodeGenIO();
await runGen({ root: ".", io });                 // writes nano-generated/
const { drift } = await runGen({ root: ".", io, check: true });  // CI drift gate
```

Each deriver is a pure `(input) → artifacts` function you can also call directly:

| Deriver | Input | Output |
|---|---|---|
| `deriveMigrations` | the manifest's datasource types | `nano-generated/<source>.schema.sql` (`CREATE TABLE` per type) |
| `deriveWorkerBindings` | BPMN service tasks + their data-envelope I/O | `nano-generated/worker-io.d.ts` (typed worker input/output) |

Derivers are deterministic — the same input produces byte-identical output — so
generated files are safe to commit and to gate in CI.

### Code-first processes

Author durable processes in code with `defineFlow`, re-exported from
[`@nanobpm/workflow`](../workflow):

```ts
import { defineFlow, WorkflowClient, Worker } from "@nanobpm/urban";

const flow = defineFlow("pr-review", (w) => {
  w.run("fetchDiff", async (job) => ({ files: 3 }));
  w.signal("humanApproval", { correlationKey: "prId" }); // durable human wait
  w.run("merge", async (job) => ({ merged: true }));
});
```

The SDK derives the executable BPMN, the job types, and the message/correlation
wiring; `WorkflowClient` deploys and starts, `Worker` hosts your `run` steps.
`deploy` emits an auto-generated diagram (DI) so the deployed model is
inspectable in a modeller/Operate — `@nanobpm/urban` bundles `bpmn-auto-layout`
so this works out of the box.

### Deploy by convention (`resources/`)

Deployables are discovered by convention: with **no `models`** block in the
manifest, `@nanobpm/urban` deploys everything under `resources/` — walked
**shallow, one level deep** (`resources/*` and `resources/<subdir>/*`, never
deeper). Content type is by extension: `.bpmn`/`.dmn` → BPMN/DMN, `.form` →
form-js form, anything else → a `GenericScript` resource (this is how agent
prompts are deployed — see below).

```
resources/
  processes/  order.bpmn        ← deployed as a BPMN process
  decisions/  route.dmn         ← deployed as a DMN decision
  forms/      approve.form      ← deployed as a form
  prompts/    review.md         ← deployed as a GenericScript (an agent prompt)
```

`resources/` is **deploy-only**: everything under it deploys, and nothing outside
it ever does — so docs (`docs/`, `AGENTS.md`, top-level `*.md`) live **outside**
`resources/` and are never swept into a deployment. Resources are keyed by their
**basename** (filename), so two files with the same name in different sub-dirs are
a **hard error** — rename or relocate one. `urban gen` follows the same
convention: with no `models`, its `nano:shape`/code-first model scan defaults to
`resources/**/*.bpmn` (+ `.dmn`) and derived models are written to
`resources/processes/`, exactly where the convention deploy then finds them.

To opt out of the convention, declare `models` globs — they are used verbatim and
the `resources/` walk is skipped:

```jsonc
{
  "models": {
    "processes": ["src/models/*.bpmn"],
    "forms": ["src/forms/*.form"]
  }
}
```

### Modular prompts — the blessed path (`zeebe:linkedResource`)

To keep a large agent prompt out of a model's XML, author it as its own file under
`resources/prompts/` (deployed as a `GenericScript`) and **link** it into the
service task with a `zeebe:linkedResource` bound to the latest deployed version;
the runtime resolves it with the `appendPrompt` FEEL helper at execution time:

```xml
<!-- resources/processes/agent.bpmn -->
<zeebe:linkedResource linkName="prompt" resourceType="GenericScript"
                      bindingType="latest" resourceId="review" />
```

This is the **only** supported prompt-modularity mechanism — there is no
deploy-time string substitution (`{{name}}` templating has been removed).

> **Value-injection caveat.** Injecting a *value* into a model at deploy time (a
> URL, a feature flag, an environment-specific constant) must use **runtime
> variables / FEEL**, never string substitution baked into the model. A model is
> deployed once and shared across environments; bake a value in and you fork the
> model per environment. Pass the value as a process variable and reference it
> with FEEL instead.

### Triggers — the inbound I/O edge

Declare `triggers[]` in the app manifest to turn outside events into engine
calls (start a process or publish a message). Two source kinds are built in:

- **`webhook`** — mounts an HTTP `POST` route (`/hooks/<id>` by default), with
  optional `hmac:<connection>` signature verification and delivery-id
  idempotency.
- **`cron`** — arms a background timer from a 5-field crontab `spec` (evaluated
  in **UTC**), firing its `action` on schedule and rescheduling itself.

```jsonc
{
  "triggers": [
    { "id": "nightly", "type": "cron", "spec": "0 6 * * *",
      "action": { "start": "daily-report" } },
    { "id": "gh", "type": "webhook", "auth": "hmac:github",
      "action": { "message": "pr-opened", "correlationKey": "= body.number" } }
  ]
}
```

Cron scheduling is **app-side**: per-replica, in-memory, and it stops when the
process stops — glue for invoking handlers on a clock, not a durable clustered
scheduler. It therefore only honours `onMissed: "skip"` (the default); a declared
`"once"`/`"all"` catch-up needs a persisted last-fire the runtime does not keep,
so it warns and degrades to `skip`. For **durable, clustered** scheduling that
survives restarts, model a timer **start**/**intermediate** event instead with
`w.startOn(...)` / `w.timer(...)` from [`@nanobpm/workflow`](../workflow) — the
engine owns those.

### Effect — typed errors & scoped resources (`@nanobpm/urban/effect`)

A tiny, **zero-dependency**, Effect-like core for the imperative seams (workers,
provisioning, resource lifecycles) — without pulling in the `effect` package or
its viral paradigm. It gives you the three ergonomics you actually reach for:

- **Typed-error `Result<A, E>` with generator do-notation.** `gen(function* … )`
  + `yield*` threads success values and short-circuits on the first failure,
  automatically inferring the union of every failure type into `E` — like
  `Effect.gen` + `yield*`.
- **Tagged errors + exhaustive matching.** `tag("NotFound")` builds a discriminated
  error; `matchTags` forces you to handle **every** variant (omitting one is a
  compile error), like `Data.TaggedError` + `catchTags`.
- **Scoped resources.** `scoped` + `acquireRelease` run every release on every exit
  — success, failure, or thrown — LIFO, like `Effect.scoped`.

```ts
import { gen, ok, fail, tag, matchTags, scoped, acquireRelease } from "@nanobpm/urban/effect";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const parse = (s: string) => (s ? ok(s.length) : fail(tag("Empty")));
const check = (n: number) => (n > 3 ? fail(tag("TooLong", { n })) : ok(n));

const run = (s: string) =>
  gen(function* () {
    const n = yield* parse(s);        // E gains "Empty"
    return yield* check(n);           // E gains "TooLong"
  });                                 // Result<number, {_tag:"Empty"} | {_tag:"TooLong", n:number}>

const r = run("hello");
if (r._tag === "Fail") {
  matchTags(r.error, {                // must handle both — omit one and it won't compile
    Empty: () => "was empty",
    TooLong: (e) => `too long: ${e.n}`,
  });
}

// `acquireRelease`'s `acquire` is synchronous, so use sync fs APIs (or `await`
// the acquisition yourself and register the disposer with `scope.add`).
await scoped(async (scope) => {
  const dir = acquireRelease(
    scope,
    () => mkdtempSync(join(tmpdir(), "urban-")),
    (d) => rmSync(d, { recursive: true, force: true }),
  ); // released on any exit
  // …use dir…
});
```

## Related packages

- [`@nanobpm/workflow`](../workflow) — the code-first process surface (`defineFlow`).
- [`create-urban-app`](../create-urban-app) — the scaffolder behind `urban new`.
