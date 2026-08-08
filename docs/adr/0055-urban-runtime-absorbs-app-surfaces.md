# ADR 0055 — The Urban runtime absorbs the app surfaces (apps reduce to `runFromEnv`)

Status: Accepted
Date: 2026-08-02
Extends: ADR 0052 (decoupled Urban runtime), ADR 0053 (derivation is a shared library),
ADR 0054 (one code-first stack)
Repo: nanobpm/nano-ide (`packages/urban`)

## Context

ADR 0053/0054 committed to producing the per-app `nano-generated/*` modules from the toolkit
(`urban gen`) instead of the console, and to a single code-first stack owned by nano-ide. But the
two apps that actually exercise the stack — `jwulf/urban-pr-review` (model-first) and
`jwulf/urban-pr-review-codefirst` — still hand-compose a bespoke `main.ts` that imports the
console-generated engines through a Deno import map:

| specifier | generated file | what it really is |
|---|---|---|
| `@nanobpm/data` | `data-sdk.ts` (537 L) | a **static** async `DataSource`/`Table<T>` sqlite gateway |
| `@nanobpm/domain` | `domain.ts` (36 L) | a **thin** typed wrapper: `openDomain()` → `Table<Row>` per table |
| `@nanobpm/app` | `app-pages.ts` (676 L) | a **static** schema-driven page runtime over `pages/*.page.json` (ADR 0042) |
| `@nanobpm/llm` | `llm-worker.ts` (403 L) | a **static** LLM job-worker host reading `workers[].llm` bindings |
| `@nanobpm/worker`/`messages`/`meta` | thin `.ts` + `*-io.d.ts` | typed wrappers over the worker/message SDK |

Their `main.ts` then adds, by hand: app-specific **action overrides** (parse-PR → create aggregate
on start, reconcile app rows on cancel, record-and-publish on answer), a GitHub **review-ready
poller**, and a **webhook**. `@nanobpm/urban`'s runtime today only ships `taskInbox`/`chat`
surfaces and a `webhook` trigger, and its `DataLayer`/`TypeRepo` is a thinner, synchronous,
`types`-driven cousin of `data-sdk.ts` — so `runFromEnv` cannot yet run either app.

The important observation: **almost all of those generated files are static runtime engines**, not
per-app code. The only per-app parts are authored artifacts already living in the app
(`pages/*.page.json`, `.bpmn`, `forms/*.form`, `db/migrations/*.sql`) plus thin typed wrappers.
Keeping the engines as *generated code the app imports* (ADR 0053) is what forces every app to
hand-wire a `main.ts`.

## Decision

**Promote the static app engines into the `@nanobpm/urban` runtime as first-class surfaces and
features, so an app reduces to `runFromEnv` + a declarative `nano.app.json` + authored artifacts +
handler files.** This evolves ADR 0053/0054: the engines become *runtime*, not *generated*; only
authored artifacts and (optionally) typed-wrapper `.d.ts` from `urban gen` remain per-app.

Concretely, the runtime gains:

1. **A rich datasource as `AppApi.data`.** Port `data-sdk.ts`'s async `DataSource` + `Table<T>`
   (`get/find/findOne/insert/update/delete/count/all/tx/schema/table`, schema-reflecting, no
   manifest `types` required) into `packages/urban/src/runtime`, and expose it as `AppApi.data`
   (superseding the `types`-only `TypeRepo`, which becomes a typed convenience over it). This is
   the single data seam every other surface/handler uses.

2. **A `pages` surface.** Port `app-pages.ts` as a runtime surface that serves the authored
   `pages/*.page.json` (list/detail/filter/actions) using `AppApi.data` + `AppApi.sdk`. Enabled via
   `manifest.surfaces.pages`.

3. **App action handlers.** A first-class extension point: a page/action whose behaviour is
   app-specific resolves to a handler **file** (`actions/<id>.ts` exporting `AppApi`-injected code),
   the same resolution model as workers. The generic create/publish path stays the default; a
   declared handler overrides it. This replaces the hand-written HTTP overrides.

4. **An `llm` worker kind.** Port `llm-worker.ts` so a `workers[]` entry with an `llm` binding is
   hosted by the runtime (provider resolved from env, ADR-faithful), removing `startLlmWorkers()`
   boilerplate.

5. **A `poll`/`schedule` trigger.** A trigger type that runs a handler on an interval (the
   review-ready poller), alongside the existing `webhook` trigger.

Authored artifacts (`pages/*.page.json`, `processes/*.bpmn`, `forms/*.form`,
`db/migrations/*.sql`, `actions/*.ts`, `workers/*.ts`) stay in the app. `urban gen` still emits the
typed-wrapper `.d.ts` (worker-io, domain-rows, message-io) for authoring ergonomics; the runtime
no longer needs the generated engines.

## Phased delivery (one PR per phase, each warning-free + green CI)

| # | Phase | Deliverable |
|---|---|---|
| 0 | ADR | this document |
| 1 | **Data** | rich `DataSource`/`Table<T>` as `AppApi.data`; `TypeRepo` layered on top |
| 2 | **Pages** | `pages` surface serving `pages/*.page.json` |
| 3 | **Actions** | app action-handler resolution (`actions/<id>.ts`) |
| 4 | **LLM** | `llm` worker kind |
| 5 | **Poller** | `poll`/`schedule` trigger |
| 6 | **Typing** | `messages`/`meta` derivers in `urban gen` |
| 7 | **Manifests** | migrate both apps' manifests to the runtime schema |
| 8 | **Refactor model-first** | `urban-pr-review` → `runFromEnv` |
| 9 | **Refactor code-first** | `urban-pr-review-codefirst` → `runFromEnv` |

Each phase keeps `urban gen --check` parity and the existing runtime tests green; app refactors
(7–9) land in the app repos after the runtime phases publish.

## Consequences

- An Urban app is a manifest + authored artifacts + handler files; `main.ts` is one call. The
  "Borland Delphi for Nano" experience — open the manifest, get a running app — is realised for
  code-first apps, not only in the IDE.
- The console and the runtime now share the same page/data/LLM engines (runtime), not divergent
  copies (console codegen vs runtime surfaces). ADR 0053's drift risk shrinks: fewer generated
  engines to keep byte-compatible.
- Risk: porting `data-sdk.ts` (async) over the runtime's `SqliteDb` (sync host seam) must preserve
  the app-facing API exactly. Mitigated by porting the API surface verbatim and unit-testing it
  against the existing app fixtures before the app refactors.
- The generated `@nanobpm/{data,domain,app,llm}` specifiers are retired for `runFromEnv` apps
  (still available for hand-composed apps during migration).
