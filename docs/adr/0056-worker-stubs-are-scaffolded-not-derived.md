# ADR 0056 — Worker handler stubs are scaffolded (write-once), not derived

Status: Accepted
Date: 2026-07
Relates to: ADR 0033 (typed worker bindings), ADR 0053 (derivation is a shared
library), ADR 0054 (one code-first stack). Depends on PR #71 (`AppJobHandler`
generics).

> **Amendment (2026-08, ADR 0059):** the standalone `urban stubs` command has been
> **retired**. Write-once stub scaffolding now runs as part of `urban gen` (workers
> from the model *and* operation-delegate stubs from the OpenAPI spec). The
> **scaffold ≠ derive** distinction below is unchanged — stubs are still human-owned
> and never clobbered — but the two concerns share one command. `urban gen` writes
> stubs by default; `urban gen --check` writes nothing and now reports a **missing**
> stub as drift (the generated controller statically imports each operation delegate,
> so an uncommitted stub must fail CI). Stub *content* is still never drift-checked;
> only a delegate's *existence* is enforced.


## Context

Model-first analysis established that, given a BPMN model, almost everything an
Urban app needs is *mechanically derivable*:

- the worker type map (`nano-generated/worker-io.d.ts`) — already derived by
  `deriveWorkerBindings` from the model's data-envelope contract (ADR 0033 §3);
- SQL migrations from the manifest `types` — already derived by
  `deriveMigrations`;
- surfaces, triggers, data access — projected by the runtime from the manifest.

The one thing that is **not** derivable is a service task's **handler body** — the
business logic a human writes. Today an author must, for each service task,
hand-create `workers/<slug>/worker.ts`, hand-wire it into `manifest.workers[]`,
and hand-import the right generated types. That boilerplate is mechanical, but
the *body* is not — so it is a scaffolding problem, not a derivation problem.

## Decision

Add a **write-once worker-stub scaffolder** (originally `urban stubs`; now folded
into `urban gen` — see the amendment above) that, from the model, creates a typed
handler stub per un-wired service task and wires it into the manifest — and then
**never touches it again**.

The load-bearing distinction is **scaffold ≠ derive**:

| | `urban gen` (derive) | `urban gen` (scaffold) |
|---|---|---|
| Output location | `nano-generated/` (gitignored) | `workers/<slug>/worker.ts` (committed) |
| Ownership | machine-owned | human-owned |
| On re-run | **overwrite always** | **write-if-absent, never clobber** |
| Drift-checked (`--check`) | yes (content) | existence only (never content) |
| Default action | write | write-if-absent |

Because a stub is human-owned and edited after creation, it must **not** flow
through the `Deriver`/`runGen`/`--check` *content* path (which exists precisely to
overwrite and drift-gate the generated tree). It is composed into `urban gen` as a
write-once, write-if-absent step (see `toolkit/generate.ts`) that never clobbers an
existing stub; `--check` only enforces that a required stub **exists**.

### What a stub is

A stub matches a real hand-authored worker exactly (cf.
`workers/persist-round/worker.ts`): a default-exported `AppJobHandler` that
`throw`s "not implemented" so an un-implemented worker fails loudly rather than
silently acking. It carries the **types** from the model:

```ts
import type { AppJobHandler } from "@nanobpm/urban/worker";
import type { WorkerInputs, WorkerOutputs } from "../../nano-generated/worker-io.d.ts";

const handler: AppJobHandler<WorkerInputs["pr.finalize"], WorkerOutputs["pr.finalize"]> =
  async (job, app) => {
    // job.variables is typed as WorkerInputs["pr.finalize"].
    throw new Error("worker not implemented: pr.finalize");
  };

export default handler;
```

The typing rides on the `AppJobHandler<In, Out>` generics added in PR #71:
`job.variables` is typed as `In`, the return as `Out`. A task's `in`/`out` is
"typed" iff its data-envelope value names a **declared** domain type
(`manifest.types`) — the same rule the worker-io deriver uses (`typeRefFor`), so
a stub is typed exactly when `worker-io.d.ts` has a key for it. Otherwise the
generic slot is omitted (open `Record<string, unknown>` default) and no generated
import is emitted. Keys use `JSON.stringify(taskType)` (indexed access), matching
the deriver's property keys.

> Prerequisite: the generic `AppJobHandler<In, Out>` ships in `@nanobpm/urban`
> ≥ 0.14.0 (PR #71). Generated stubs typecheck against that version.

Stubs import `AppJobHandler` from the runtime-free `@nanobpm/urban/worker` subpath
(≥ 0.16.0) rather than the package barrel: the barrel re-exports the Node/Deno host
adapters, so its type graph transitively references `node:*` (needing `@types/node`
or `skipLibCheck`), whereas `/worker` re-exports only the `core/` authoring types,
which the ADR 0052 purity invariant keeps free of urban's own `node:*` imports.

The handler's type surface also reaches the SDK via `AppApi.sdk` (`app.sdk` is the
full `@nanobpm/nano-sdk` client, by design). That SDK is kept node-free by the
`@nanobpm/nano-sdk` ≥ 1.2.2 floor, which pulls `@camunda8/orchestration-cluster-api`
≥ 10.0.0-alpha.20 — whose public types no longer reference `node:worker_threads`.
Together (adapter-free `/worker` surface + node-free SDK floor) a scaffolded stub
typechecks on Node or Deno with no `@types/node` and no `skipLibCheck`.

### What is skipped (never stubbed)

- **Already-wired** task types (`manifest.workers[].taskType`) — the manifest
  wins; this also covers `llm`-bound workers, which live there.
- The **imperative orchestrator** task (`<workflowId>:__orchestrate`, ADR 0054 /
  `defineWorkflow`) — it is engine-internal, not an author handler.
- **Duplicates** — a task type appearing in several models is stubbed once.

### Manifest wiring

For every stubbed (or pre-existing but un-wired) task, the write-if-absent scaffold
step appends `{ taskType, handler }` to `manifest.workers[]` (creating the array if
absent). This reformats the manifest with 2-space indent — acceptable for a
scaffolding tool and only done when `urban gen` runs in write mode (not `--check`).

## Consequences

- The model remains the single source of truth for *structure and types*; humans
  own only the *bodies*. Re-running `urban gen` after adding a task creates just
  the new stub and leaves edited ones untouched.
- Never generating bodies keeps the tool honest: it scaffolds the seam, it does
  not fabricate logic.
- The overwrite-and-check derivation and the write-once scaffold have opposite
  semantics but share one command (`urban gen`): the derived tree is drift-gated,
  while a human-owned stub's *content* stays out of the gate — a stub edit can
  never fail `urban gen --check` (only a *missing* stub does).
- Imperative `defineWorkflow` apps (single degenerate orchestrator task) are not a
  target: their logic is code, not model-shaped, so there is nothing to stub.
