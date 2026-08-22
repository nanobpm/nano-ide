# ADR 0065 — Reconciling read models (declare-once derived views over engine truth)

Status: Accepted
Date: 2026-08-22
Relates to: ADR 0053 (derivation is a shared library — the principle this generalizes),
ADR 0055 (the Urban runtime absorbs app surfaces — where this primitive lives),
ADR 0063 (framework-level lineage primitive — the SDK-envelope + generic-projection +
per-source-sidecar shape this mirrors), and the `instanceTracking` reconciler
(`packages/urban/src/runtime/core/modules/instance-tracking.ts` — the write-time seam
this inverts).
Repo: nanobpm/nano-ide (`packages/urban`, `packages/urban-testkit`).

Implementation issue: nanobpm/nano-ide#452. Motivating instances (nano-workforce):
#412 (projection → SQL VIEW technique), #439 (the L1/L2 derivation framing),
#318 (engine-authoritative wait-state derivation), #422 (answered-escalation drift —
the instance that exposed the residual class), fixed tactically by nano-workforce#458.

## Context

Urban apps present operators with **derived** state: a feature's `stage`, its
`attention` badge, its `list_bucket` — none of which are ground truth. They are functions
of a canonical input (the base row, the engine's wait/terminal state). We have learned,
across a run of incidents, that **anywhere derived state is *stored* it eventually tears**
from its inputs.

Two derivation layers, named in nano-workforce#439:

| | L1 — base status | L2 — display projection |
|---|---|---|
| Example | `feature_runs.status` | `stage`, `attention`, `list_bucket` |
| Maintained by | workers (imperative writes) **and** `instanceTracking` reconciler | derived *from* `status` |
| Fixed as a class? | **No** — still imperatively written | Partly — #412 made it a VIEW, not a stored column |

L2 got a *class* technique (#412: a projection is a SQLite VIEW, never a stored column),
but two drift surfaces survive even after that win, and #422 is the proof:

1. **The base `status` (L1) is still maintained imperatively.** Workers write it, and the
   `instanceTracking` reconciler writes it too — `onTerminated.set → abandoned`,
   `onWaitingHuman.set → awaiting_operator` (issue #355). The answered-escalation loop in
   nwf returns the token to `implement-task` *without* resetting `status`, so `status`
   stays `escalated` until the re-run completes, and every reader of `status` sees the
   stale value. nano-workforce#458 fixed exactly one edge — it re-pointed the `attention`
   badge at engine truth (an open `user_tasks` row) instead of `status` — but any *other*
   reader of `status` remains exposed. That is an instance fix, not a class fix.

2. **Each derived column is authored twice.** The SQL `CASE`/`EXISTS` inside the VIEW and
   the TypeScript oracle (`deriveStage`) express the *same* function in two languages,
   kept in lockstep by a hand-written parity test. The lockstep test is itself a drift
   surface — it does not remove the duplication, it only alarms when the two copies
   diverge.

3. **Every read model is hand-wired.** Per projection, an author writes: the migration,
   the VIEW DDL, the page binding, the pages↔schema contract entry, and the parity test.
   That per-app boilerplate is where the whack-a-mole lives.

The crucial observation: **`instanceTracking` already knows the engine truth and already
computes the derived edge — but it *writes* it.** It is a reconciler that *maintains*
(`table.update`), which is precisely the write path that tears. The categorical fix is to
turn that reconciler from a **writer** into a **source**, and let read models *derive*
rather than be *patched* — the same inversion ADR 0063 performed for lineage (a per-app
hand-rolled correlation promoted to a framework-owned generic projection provisioned as a
per-source sidecar with a boot migration and a drift-guard test).

## Decision

Introduce a framework primitive in `@nanobpm/urban` — **reconciling read models** — with
four parts. Modeled on ADR 0063: canonical projections + one declaration + framework-owned
plumbing + the reconciler inversion.

### 1. Canonical engine-truth projections (promote, don't hand-roll)

Framework-owned read projections, provisioned as per-source sidecars exactly like
`LineageStore` (ADR 0063) and the write-provenance table, reconciled by the existing poll
loop and **never app-written**:

- `urban_open_user_tasks` — open user tasks by `(subject_type, subject_key, element_id)`.
  nano-workforce's `user_tasks` (populated by `pollUserTasks` in `app/service.ts`) is a
  hand-rolled instance of exactly this; the primitive absorbs it.
- `urban_instance_state` — per instance: live / terminated, and (where
  Magikcraft/nano-bpm#808 lands) the native execution edge.

These are the canonical inputs a derived read model is allowed to read besides its own
base table. A row exists **iff** the engine says so, so a projection over them cannot go
stale.

### 2. Declare a projection once; compile to both surfaces

An app declares a derived read model as a **pure derivation** over its base row and the
canonical projections, in one place:

```ts
defineReadModel("feature_read_model", {
  base: "feature_runs",
  derive: {
    attention: (row, engine) =>
      engine.hasOpenUserTask("feature", row.feature_key, "feature-blocked")     ? "blocked"
      : engine.hasOpenUserTask("feature", row.feature_key, "feature-escalation") ? "⚠"
      : null,
    stage: (row) => /* … */,
    list_bucket: (row) => /* … */,
  },
})
```

The `derive` entries are a small, closed **expression DSL** (compare / `CASE` / `EXISTS`
over base columns + the canonical projections). Urban compiles each entry to **both**:

- the **SQLite VIEW** select-list (the `CASE` / correlated `EXISTS`), so the existing flat
  page-filter DSL can still filter and sort on the derived column; and
- the **runtime TypeScript** function (retiring the hand-written `deriveStage` oracle).

Because both fall out of one declaration, drift surface #2 disappears by construction —
there is nothing to keep in lockstep. A closed expression DSL (not arbitrary TS) is what
makes compilation to SQL tractable and total; it covers the stage/attention/list_bucket
shape we actually have.

### 3. The framework emits the plumbing

From the single `defineReadModel`, Urban generates — per ADR 0063's shape — the managed
VIEW (applied at boot / as a generated migration), the pages↔schema contract entry, and
the parity guard. No per-app migration/VIEW/contract/test boilerplate; drift surface #3
disappears.

### 4. Invert the reconciler: writer → source

Once derivable columns are framework VIEWs over canonical projections,
`instanceTracking`'s `onTerminated.set` / `onWaitingHuman.set` are unnecessary **for
anything derivable** — there is no stored derived column left to tear. `status` then
splits cleanly into:

- **business outcomes that need a record** (e.g. `merged`, genuinely `abandoned`) — real
  stored state, written once at the transition; and
- **derivable edges** (waiting-on-human, terminated) — pure projections of
  `urban_open_user_tasks` / `urban_instance_state`.

This delivers #439's L1 arm and #318 as a **framework capability**, not per-app code, and
retires drift surface #1 at its source.

## Consequences

- A new Urban app declares a reconciling read model in one place and gets the VIEW, the
  contract entry, the parity guard, and drift-freedom for free — no hand-wired SQL/TS
  mirror, no write path to leave stale.
- The three residual drift surfaces named above are each closed structurally rather than
  alarmed: #2 by compile-to-both, #3 by framework-emitted plumbing, #1 by
  writer→source inversion.
- `parentProcessInstanceKey` / #808 slots into `urban_instance_state` later without an API
  change (same weak/strong pattern as ADR 0063).
- Migration risk is bounded: existing per-app VIEWs (nwf migrations 073/075) are
  superseded incrementally; the primitive can adopt one read model at a time.
- Scope guard: this ADR is the primitive. The nwf-specific read models are the first
  consumer and are migrated behind it, not designed here.

## Rollout (incremental, each step independently shippable)

1. **Now:** land nano-workforce#458 — the instance fix for the live symptom (#422).
2. **First framework step (PR-sized, highest leverage):** the declare-once → compile-to-both
   expression DSL, applied to nwf's existing three read models (feature/plan). Kills drift
   surface #2 on real surfaces; lowest risk, highest proof value; no engine-truth changes yet.
3. Promote `user_tasks` → the canonical `urban_open_user_tasks` projection; re-point the read
   models at it (removes drift surface #1's *source* for the attention/wait edges).
4. Invert `instanceTracking` from writer → source; retire the derivable `status` writes
   (closes drift surface #1 and delivers #439-L1 / #318).
