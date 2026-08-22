# ADR 0065 — Reconciling read models (declare once, compile to both; engine truth as the source)

Status: Proposed
Date: 2026-08-22
Relates to: ADR 0063 (the framework-level lineage primitive — the writer→source
inversion this generalises), ADR 0055 (the Urban runtime absorbs app surfaces), and the
write-provenance / per-source sidecar plane this mirrors.
Repo: nanobpm/nano-ide (`packages/urban`). First consumer: nanobpm/nano-workforce.

Implementation epic: nanobpm/nano-ide#452. Prior art: nano-workforce#412 (display
projections became SQLite VIEWs). Closes the drift classes behind nano-workforce#422
(a stale ⚠ after an answered escalation), #439-L1 and #318.

## Context

An Urban app presents **derived operator state** — a task's display stage, an instance's
status edge, whether it is parked on a human. That state is a *pure function of canonical
inputs* (the engine's truth plus the app's own rows), yet it keeps **tearing** from those
inputs: a value stored or projected at write time drifts out of step with the inputs it was
derived from, and the operator sees a stale answer.

nano-workforce#412 removed the first drift surface by making display projections **SQLite
VIEWs** rather than stored columns — a VIEW is recomputed on every read, so it cannot lag
its inputs. That was the right move, but two drift surfaces survived it, plus the deeper one
that VIEWs alone cannot reach:

| # | Drift surface | Where it lives today |
|---|---|---|
| 1 | A **derived value is STORED by a writer** (a reconciler `table.update`s a `status` column), so it tears from its inputs the moment they change again. | `instance-tracking.ts` writes `onTerminated.set` / `onWaitingHuman.set`. |
| 2 | A derived column is **authored TWICE** — once as SQL (`CASE`/`EXISTS`) in the VIEW, once as a TS oracle (`deriveStage`) — kept in lockstep only by a **hand-written parity test** (itself a drift surface). | Every VIEW + its `derive*` twin + its parity test. |
| 3 | Every read model is **hand-wired end to end** — migration + VIEW + page binding + pages↔schema contract entry + parity test — re-authored **per projection**. | Each read model, by hand. |

Surface #2 is the trap hiding inside #412's fix: the moment a value is computed both in SQL
(for the VIEW) and in TS (for in-process logic), you own two authorings of one truth and a
test whose only job is to notice when they diverge. Surface #1 is the original sin — a
*writer* that already knows engine truth chooses to **store** a derived edge instead of
letting it be derived, re-introducing tearing that #412 removed elsewhere. Surface #3 is the
per-projection tax that makes every new read model expensive enough to discourage doing it
right.

## Decision

One declaration, two backends, engine truth as the source — all in `@nanobpm/urban`, exported
from the runtime barrel (`@nanobpm/urban/runtime`). Four proposal points:

### 1. Canonical engine-truth projections (close surface #1's *source* gap)

Provision framework-owned, per-source **sidecar** projections that make engine truth
*queryable*, exactly the way `LineageStore` (ADR 0063) is: a `_urban_`-prefixed table hidden
from the domain model / DB Manager, with a canonical DDL applied by `ensureSchema()`, mirrored
verbatim by a boot migration under `db/migrations/`, drift-guarded by a test, and provisioned
per source in `workers.ts`. Two land in this epic:

- **`urban_open_user_tasks`** — the set of currently-open (`CREATED`-state) user tasks per
  process instance, recorded idempotently from the same engine query the reconciler already
  runs (`searchUserTasks({ state: "CREATED" })`). This *absorbs* nano-workforce's hand-rolled
  `user_tasks` table: it is the one authoritative projection of "which instances are parked on
  a human".
- **`urban_instance_state`** — the canonical per-instance engine lifecycle state
  (`ACTIVE`/`COMPLETED`/`TERMINATED`, and whether waiting-on-human), recorded from engine
  truth so a read model can derive an instance's status edge purely from this projection.

They are framework **bookkeeping** (never app-written); an app with no datasource records
nothing (absent-safe), and a projection write never breaks a job. *(Lands in a later PR of
this epic; the primitive below is authored so it can reference these by name before they land.)*

### 2. Declare a read model once, in a closed expression DSL

`defineReadModel(...)` (`core/read-model.ts`) declares a derived read model **once**, as a
pure derivation over a **base row** plus **named canonical projections**. The derivation body
is a small **CLOSED expression DSL** — a discriminated-union AST, *not* arbitrary strings or
SQL fragments — supporting at minimum:

- **comparisons** (`eq`/`neq`/`lt`/`lte`/`gt`/`gte`),
- **`CASE`** / when-then-else (`caseWhen`),
- **`EXISTS`** over a *named* projection with a correlation predicate (`exists(name, where)`),
- **column references** to the base row (`col`) and to the correlated projection row (`pcol`),
- **literals** (`lit`) and boolean combinators (`and`/`or`/`not`).

Closedness is the whole point: because the derivation is data, one declaration can be walked
by more than one backend.

### 3. One AST, two backends — so they cannot drift (close surface #2)

A single compiler emits **both** backends from that one AST, by construction:

- `compileToSqlSelect(expr)` → the SQLite VIEW select-list expression string for the derived
  column.
- `compileToFn(expr)` → a runtime TS function `(baseRow, projections) => value` computing the
  **same** value in-process.

Because both walk the identical AST exhaustively, the SQL a VIEW runs and the TS an app calls
are two renderings of one authoring — the double-authoring of surface #2 is gone. The
`EXISTS` projection reference resolves through a **projection-name seam**: the SQL backend
learns which physical `_urban_` table to read; the TS backend is handed the projection's rows
at evaluate time. A read model may reference a projection by name even before its sidecar
lands.

### 4. Framework-emitted plumbing + parity guard (close surface #3)

From a `defineReadModel` declaration the framework **derives** the rest, so an app stops
hand-wiring it:

- the **managed SQLite VIEW DDL** (`deriveReadModelViewDdl` / `ReadModel.viewDdl()`), applied
  on the same per-source boot path the existing derived VIEWs / lineage sidecar use (a
  `readModelRegistry` a declaration registers into; the runtime `ensureViews` it against the
  app's data source at worker mount);
- a **parity guard** (`assertReadModelParity`) that, given sample base + projection rows,
  materialises the VIEW over throwaway fixtures, reads the SQL-derived value, computes the
  TS-function value for the same inputs, and asserts they agree — so an app no longer writes a
  bespoke parity test per projection. It fails loudly, naming the column and sample, when a
  deliberately-mutated AST would diverge.

### Writer → source inversion (close surface #1)

The last surface is `instance-tracking.ts` *writing* the derived status edges it already
computes. The fix is the same move ADR 0063 made for lineage: **invert the writer into a
source.** The reconciler stops applying `table.update` patches for the derivable
(terminated → terminal-status, waiting-on-human → `awaiting_operator`) edges and instead
**feeds** the canonical projections (#1). Those edges become a `defineReadModel` derivation
over `urban_instance_state` and `urban_open_user_tasks`, recomputed on every read — so a
re-escalation after an answer re-flips **by construction** and the #422 staleness cannot
recur. Real business outcomes that an app's own workers genuinely store once (e.g. a finalize
worker's terminal outcome) stay stored; only the *derivable* edges are inverted. The cancel
path that also reconciles a terminated key is updated in lockstep so cancel and poll cannot
drift. *(Lands in the final PR of this epic.)*

## Rollout (issue #452)

1. **nano-workforce#412 (done, different repo):** display projections became SQLite VIEWs —
   removed stored display columns.
2. **This primitive (`defineReadModel` + DSL + two-backend compiler + managed-VIEW derivation
   + parity guard):** declare-once, compile-to-both, with the read-model registry and
   projection-name seams established for the later waves.
3. **Canonical engine-truth projections** (`urban_open_user_tasks`, `urban_instance_state`):
   the per-source sidecars that make engine truth queryable, registered under the
   projection-name seam.
4. **Writer → source inversion:** retire the derivable-status writes in `instance-tracking.ts`
   (and the cancel path); derive those edges via `defineReadModel` over the canonical
   projections instead.

## Consequences

- A read model is **authored once**; the SQL VIEW and the in-process TS function are two
  renderings of it and cannot drift (surface #2 closed). The parity guard becomes a framework
  utility, not per-projection boilerplate (surface #3 closed).
- Derived operator state stops tearing from its inputs: a derivable edge is a VIEW/function
  over live canonical projections, recomputed on read, so an answered escalation re-flips by
  construction (surface #1 closed; #422 gone).
- Engine truth gets a single authoritative home per concern (`urban_open_user_tasks`,
  `urban_instance_state`), absorbing hand-rolled app tables like nano-workforce's
  `user_tasks`.
- The projections are per-source sidecars on the app's own data source (like lineage /
  write-provenance): an app with no datasource records nothing (absent-safe), and a projection
  write never breaks a job.
- New read models cost a single declaration, so doing it right (derive, don't store) becomes
  the path of least resistance.
- The DSL is intentionally small and closed. Derivations that outgrow it are a signal to
  extend the AST (one node kind, both backends) rather than to escape into raw SQL — keeping
  the no-drift guarantee total.
