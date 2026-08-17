# ADR 0064 — A typed extension-event taxonomy with explicit dispatch modes

Status: Accepted
Date: 2026-08-17
Relates to: ADR 0055 (the Urban runtime absorbs app surfaces — the modules this
formalizes), ADR 0060 (typesafety under strip-types — the constraint the kernel is
authored within), ADR 0061 (structured logging — where contained throws land), and
the agentic capability epic #124 / ADR 0056 (the informal plugin surface this
hardens).
Repo: nanobpm/nano-ide (`packages/urban`).

Implementation issue: nanobpm/nano-ide#262. Cribbed from DeepSeek Harness's Cordis
microkernel notes (`2026-06-11-microkernel-event-taxonomy.md`,
`2026-07-27-dispose-ladder-to-consumer.md`).

## Context

Urban's runtime modules
(`packages/urban/src/runtime/core/modules/{actions,agent,api,cancel,connectors,cron,
dataops,datasource,deploy,gateway,instance-tracking,lineage-store,llm,pages,scheduler,
security,surfaces,triggers,workers}.ts`) are **wired directly** into `runtime.ts`.
Extension points are implicit — a module reaches for what it needs — and their
**ordering and failure-isolation semantics are undeclared**. nwf already leans on an
informal plugin pattern on top of this: the agentic channel's "sibling slices extend
by dropping a family module under `app/agentic/families/`, never editing `main.ts`".
That is exactly the shape a typed taxonomy would formalize and harden.

DeepSeek Harness (`dsh`) solves the same "everything is a plugin" problem with a
**pure event taxonomy** whose extension points are typed events with *deliberate*
dispatch modes. The payoff notes worth stealing: HMR + disposal come "free" because
registrations are framework **effects** on a **dispose ladder**; the dispatch loop is
**defensive** (a plugin exception is contained, never strands the pipeline); and a
kept-current **feature → mechanism map** stands as a proof obligation that every
feature is a listener.

## Decision

Introduce a small **extension-event microkernel** in `@nanobpm/urban` — a typed event
bus whose extension points are *channels*, each carrying a declared **dispatch mode** —
and a **typed Urban taxonomy** of seams over it. Modules and extensions hook onto the
seams instead of wiring into `runtime.ts`; *how* a seam's listeners run is a property
of the channel, not of each call site.

### 1. Four dispatch modes (`packages/urban/src/runtime/core/events.ts`)

| Mode | Semantics | For |
|---|---|---|
| **waterfall** | around-middleware: a listener wraps `next`, so it can transform the value, short-circuit (never call `next`), recover (catch a downstream throw), or wrap the result | policy / permission / transform seams |
| **serial** | listeners awaited in registration order | ordered checkpoints |
| **parallel** | fan-out awaited together; every listener gets an *independent* chance | durability checkpoints (cf. `session/flush`) |
| **emit** | synchronous fire-and-forget | notifications (lifecycle, errors, observations) |

### 2. Defensive dispatch

A listener exception is **contained at the pipeline boundary**: the bus reports it via
an injected `onError` sink (the runtime wires it to `host.log("warn", …)`, ADR 0061)
and the pipeline continues. A throwing waterfall middleware that never produced a
result **warns and delegates** — the chain continues with the unchanged value — so a
buggy extension never strands app boot or a request.

### 3. The dispose ladder — registrations are effects

Every `channel.on(...)` (and every `bus.effect(cleanup)` for a bare timer/subscription)
returns a `Disposer` **and** is pushed onto the bus's single ladder. `bus.dispose()`
unwinds the whole ladder LIFO. So a `start → stop → start` cycle — and a dev-server HMR
reload — leaks no listeners or timers. The runtime calls `bus.dispose()` once at the
end of teardown, after the terminal `lifecycle: stopped` notification.

### 4. The typed Urban taxonomy (`packages/urban/src/runtime/core/extensions.ts`)

`URBAN_EVENT_MODES` is the single source of truth for the seam→mode mapping; the typed
`UrbanEvents` channels and this ADR's feature→mechanism map both derive from it, so the
docs and code cannot drift.

The first concrete consumer is the informal plugin surface Urban already stresses:
agentic families and connector packs. Each becomes a `UrbanExtension` (`{ name, order?,
setup(ctx) }`); the runtime runs them through the `extension/register` serial checkpoint
in a deterministic order (`order`, then registration order), and everything an extension
registers rides the dispose ladder. Hosts pass them via
`createUrbanApp({ extensions: [...] })`; `app.events` exposes the taxonomy.

### Feature → mechanism map (the proof obligation)

Every seam is a listener on a typed channel. Wired today; the remaining core modules
migrate onto their seams incrementally (this is an extension-model refactor, not a
behavior change — ADR 0055's modules keep their behavior).

| Seam (event) | Mode | Mechanism | Status |
|---|---|---|---|
| `lifecycle` | emit | `runtime.ts` emits `starting`/`started`/`stopping`/`stopped` | **wired** |
| `extension/register` | serial | `mountExtensions` runs each `UrbanExtension.setup` in order | **wired** |
| `request/dispatch` | waterfall | around-middleware for request/action (transform / short-circuit) | declared — `api`/`actions` migrate onto it |
| `security/gate` | waterfall | permission gate; a listener short-circuits with a deny | declared — `security` migrates onto it |
| `reconcile` | parallel | instance-tracking reconcile fan-out | declared — `instance-tracking` migrates onto it |

## Consequences

- Extensions (agentic families, connector packs) plug in through one uniform, typed
  surface with declared ordering and failure isolation, instead of ad-hoc wiring.
- HMR/disposal correctness is structural: if a registration rode the ladder, teardown
  unwinds it. Leak tests assert `listenerCount === 0` across start→stop→start.
- The kernel is authored within the strip-types constraint (ADR 0060): plain class
  fields (no parameter properties), no `as` assertions, `.ts` sibling imports.
- The taxonomy is additive. The remaining seams are declared and typed but not yet the
  sole path for their modules; each migrates behind its channel in a follow-up without
  changing behavior.

## References

- Implementation: `packages/urban/src/runtime/core/events.ts` (microkernel),
  `packages/urban/src/runtime/core/extensions.ts` (typed taxonomy + extension host),
  wiring in `packages/urban/src/runtime/core/runtime.ts`.
- Tests: `events.test.ts` (dispatch modes + containment + dispose ladder),
  `extensions.test.ts` (order + short-circuit + disposal composition, containment,
  HMR), `runtime.extensions.test.ts` (lifecycle emits, boot not stranded, no leaks
  across a start→stop→start cycle).
- Cribbed from DeepSeek Harness `2026-06-11-microkernel-event-taxonomy.md` (dispatch
  modes), `2026-07-27-dispose-ladder-to-consumer.md` (disposal as effects), and the
  `cordis` framework (HMR/disposal as effects).
