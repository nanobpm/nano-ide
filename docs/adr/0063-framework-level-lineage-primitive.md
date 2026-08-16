# ADR 0063 — A framework-level lineage primitive (SDK envelope + generic read projection)

Status: Proposed
Date: 2026-08-17
Relates to: ADR 0055 (the Urban runtime absorbs app surfaces), ADR 0061 (structured
logging — the ambient job context this reuses), and the write-provenance plane (the
`execContext` / per-source sidecar this mirrors).
Repo: nanobpm/nano-ide (`packages/urban`, `packages/urban-testkit`).

Implementation issue: nanobpm/nano-ide#254. First consumer / product design:
nanobpm/nano-workforce#245. Complementary engine execution edge: Magikcraft/nano-bpm#808.

## Context

Every Urban app wants to stitch **user intent → progress**: a single root request (a
button press, an inbound webhook, an API call) fans out into the process instances, PRs,
tasks and sub-loops it *causes*, and an operator wants to see that whole thread. Today
each app hand-rolls that correlation — in nano-workforce, `feature_runs.pr_key ↔
pull_requests.pr_key`, `plan_tasks.pr_key`, message `correlationKey`. The next Urban app
should get intent→progress threading for free.

Two DISTINCT relationships stitch the thread, and conflating them is the trap:

| | Execution edge | Lineage / causation edge |
|---|---|---|
| Primitive | `parentProcessInstanceKey` (engine, Magikcraft/nano-bpm#808) | `_urban.lineage` envelope (this ADR) |
| Semantics | synchronous delegation; parent token blocks on child | asynchronous causation; cause does not block effect |
| Cardinality | single-parent, child lifetime ⊆ parent | fan-out (1→N), descendants settle independently |
| Survives ancestor termination? | no | yes |
| Created by | call activity | message-start / API `createInstance` / webhook / call activity |

Most Urban lineage edges are the right-hand column, so `parentProcessInstanceKey` alone
cannot be the general model.

## Decision

Two primitives, one projection — all in `@nanobpm/urban`.

### 1. Lineage envelope — an SDK convention

A reserved variable namespace on every instance/message:

```
_urban.lineage = { rootRequestKey: string, causedByInstanceKey?: string }
```

It is **auto-threaded** by the runtime. The worker runtime already stamps an ambient job
execution context (`execContext.ts`, used by write-provenance); it now also carries the
running instance's `rootRequestKey`. When a handler spawns an instance
(`EngineClient.createInstance`) or publishes a message (`publishMessage`), a single shared
step (`applyAmbientLineage`, `core/lineage.ts`) merges the envelope into the variables:
`rootRequestKey` is preserved and `causedByInstanceKey` is set to the current instance. A
genuine top-level request (no ambient lineage) mints a fresh `rootRequestKey`. An explicit
caller-supplied envelope always wins (start a new root or re-parent deliberately).

Both engine adapters — the live `SdkEngineClient` and the testkit's `WasmEngineClient` —
route through the **same** `applyAmbientLineage`, so lineage threads identically in
production and in-harness (No Drift Surfaces). This is why the testkit can observe lineage
straight off the engine.

### 2. Execution edge — consumed, not duplicated

Where Magikcraft/nano-bpm#808 lands, the engine emits `parentProcessInstanceKey` natively.
The projection treats it as a **strong** edge type, unioned with the envelope's weak/causal
edges. No SDK threading is needed for that subset, and #808 is not a blocker — the
projection is buildable now on the weak edges alone.

### 3. Generic lineage read projection

`LineageStore` (`core/modules/lineage-store.ts`) is a framework read-model, provisioned as
a per-source sidecar exactly like the write-provenance table. As every instance that does
work activates a job, the worker runtime records the edge that job's envelope reveals
(idempotently). `getLineage(rootRequestKey)` unions the weak and strong edges — a strong
execution edge supersedes a weak guess for the same node — into a stitched descendant tree.
Apps attach their own domain rows (PRs, tasks) to a node via `LineageStore.attach`, which
the framework stores opaquely by `(nodeKey, kind, ref)` — the extension point that keeps
intent→progress visualisation app-agnostic. The tree assembly itself is the pure
`buildLineageTree`; the store is only its idempotent persistence + query layer. The DDL is
mirrored by the boot migration `db/migrations/004_urban_lineage.sql`, drift-guarded by a
test.

Everything is exported from the runtime barrel (`@nanobpm/urban/runtime`).

## Consequences

- Any Urban app gets intent→progress lineage for free: spawn/publish auto-thread the
  envelope, and the projection materialises the tree with no per-app correlation code.
- Lineage recording is a sidecar on the app's own default data source; an app with no
  datasource simply records nothing (absent-safe), and a projection write never breaks a
  job.
- The weak/strong split lets #808's engine-native edge slot in later without a schema or
  API change — it just supersedes the weak edge for its nodes.
- The nwf-specific UI (nanobpm/nano-workforce#245) is the first consumer and is out of
  scope here.
