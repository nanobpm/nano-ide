# ADR 0060 — Type-safety under `--strip-types`: derived runtime validators at every trust boundary, threaded by generics

Status: Proposed
Date: 2026-08-10
Extends: ADR 0040 (the fused domain model — the single derived source), ADR 0033
(the data-envelope carrier / worker-I/O derivation), ADR 0058 (OpenAPI endpoint
surface — the one boundary that already validates), ADR 0059 (one HTTP surface;
"a validator you hand-write is a validator you can get wrong").
Relates to: nano-ide #150 (the `gw-guard` `null >= null` incident is a boundary
escape), #156 (0059 tracking).
Repo: nanobpm/nano-ide (`packages/urban`), Magikcraft/nano-bpm (`spec-app/`).

## Context

An Urban app has **three I/O surfaces**, each a boundary where untyped data enters
TypeScript-land:

| Boundary | Data source | What crosses |
|---|---|---|
| **REST API** | HTTP client | request params/query/body, response body |
| **Process engine** | the engine | `job.variables`, message payloads |
| **Database** | SQLite | rows read back from dynamic SQL |

Apps run under Node/Deno **`--strip-types`**: types are **erased, not checked**.
There is *no compile step at runtime* — a TS type is a purely lexical annotation
that is gone by the time code executes. Two consequences:

1. **TypeScript types give zero runtime protection.** A value typed `number` that
   is actually `undefined` at runtime sails straight through.
2. **The only compile-time safety net is an out-of-band gate** (`tsc --noEmit` /
   `deno check`) run in CI/editor — never at load. If that gate is missing or
   advisory, a type error ships silently.

Today only **one** of the three boundaries validates at runtime. The runtime
validator `validateValue` — a hand-written helper in
`packages/urban/src/openapi/spec.ts` — is called from exactly one module,
`packages/urban/src/runtime/core/modules/api.ts` (REST params/query/body/response,
ADR 0058). The other two boundaries **cast**:

- **Engine → worker:** `packages/urban/src/runtime/core/modules/workers.ts`
  (`dispatch`) calls the handler with `job.variables: Record<string, unknown>`. The
  `In` in `AppJobHandler<In, Out>` is a **phantom** type — never checked.
- **DB read:** `packages/urban/src/runtime/core/modules/datasource.ts`
  `all<T>()` / `query<T>()` do `return this.db.all<T>(...)` — a pure cast; `T`
  never exists at runtime.

Both of this session's production incidents are escapes at these two unvalidated
boundaries — "runtime errors not caught by compilation":

- **`gw-guard` incident (instance 250):** the gateway condition `round >= maxRounds`
  (stored as the FEEL expression `=round >= maxRounds`) evaluated `null >= null`
  because `round`/`maxRounds` were never seeded — `undefined` at the engine→worker
  boundary, typed as `number`.
- **`record-plan` crash:** `unsupported SQLite parameter type: undefined` because
  `planKey` was `undefined` flowing into a query typed `string`.

The compiler *could not* have caught either: the values crossed a trust boundary
where, at runtime, there are no types.

## Decision

**Every trust boundary parses; it never casts. The runtime validator and the
static type are the same derived artifact, threaded through the code by generics
whose type parameter is *inferred from the schema value*.**

Three load-bearing rules.

### 1. Generics are the vehicle, not the guarantee

The intuition to use generics is right — but a bare generic (`<T>`, phantom `In`)
is erased and validates nothing; adding more of them only relocates the failing
cast. A generic delivers safety **only when its type parameter is inferred from a
runtime schema value**:

```ts
// derived per type from the fused model (ADR 0040): ONE artifact, runtime + type.
export const Order = schema({ id: str(), total: num({ min: 0 }) });
export type  Order = Infer<typeof Order>;   // the static type is INFERRED — it cannot drift.

// the generic is inferred FROM the schema, so `parse` returns the type, guaranteed:
function parse<S extends Schema>(s: S, v: unknown): Infer<S> { /* validate or throw */ }
```

**The rule: a boundary type is always `Infer<typeof schemaValue>`, never a
hand-declared `interface`.** Then a generic `<S extends Schema>` propagates it with
zero drift, and crossing the boundary runs `parse(S, …)` — exactly what
`validateValue` already does at REST, generalized to a schema-carrying value.

### 2. One derived schema, three call sites

The fused registry (ADR 0040) already derives each type's shape. It emits, per
type, a **schema descriptor** — a runtime value (the existing `validateValue`
JSON-Schema subset is the substrate) whose TS type is `Infer<…>`. The generic
surfaces take the *schema*, not a bare `T`:

- `table(Order).query({ … }) : Order[]` — rows validated on read.
- `AppJobHandler` receives `job.variables` **validated** against the task's derived
  input schema (ADR 0033 worker-I/O) before the body runs.
- REST operation types already carry the schema (ADR 0058) — unchanged.

`validateValue` moves from one call site to three; the schema descriptors are all
derived from the one fused source, so the DB, engine, and REST views of an `Order`
cannot disagree.

### 3. Parse at ingress → a clean error, never a downstream blow-up

At each boundary, validation runs **before** app/handler code:

- **Engine → worker:** a missing/mistyped required variable raises a **clean
  incident** naming the field — not a `null >= null` gateway failure three steps
  later. (This subsumes the "companion hardening" flagged for #150.)
- **DB read:** SQLite is dynamically typed — declared column affinity guarantees
  nothing — so rows are validated out of `all`/`query`; a schema-violating row is a
  named error at the read, not an `undefined` param crash downstream.
- **REST:** unchanged (already 400s on malformed input).

There are **no per-boundary hand-written validators**: the single validator helper
(`validateValue`) is written once, and every boundary drives it with a **derived**
schema — ADR 0059's rule ("a validator you hand-write is one you can get wrong")
generalized from REST to all three boundaries.

### 4. The `tsc --noEmit` / `deno check` gate is mandatory, not advisory

Because `--strip-types` never type-checks, the interior (everything *between*
boundaries, where derived generics are the only safety) is only sound if a compile
gate runs. This ADR makes it a **required** check, and has the scaffolder emit it:

- `create-urban-app` scaffolds a `typecheck` npm script (`tsc --noEmit`) **and** a
  CI workflow that runs it (plus `urban check` and, for Deno apps, `deno check`) —
  so every generated app ships the gate on day one rather than adding it later
  (as `nano-workforce` had to).

### Erasability constraint

All generated code (schemas, inferred types, validators, generics) must be
**erasable-only** so it runs under `--strip-types`: `import type` for types, no
runtime `enum`/`namespace`/parameter-properties. The schema *descriptors* are plain
runtime values; the *types* over them are `Infer<…>` and fully erased.

## Consequences

- **The runtime-error class is closed at the source.** No `undefined`-as-`number`
  or unvalidated row can reach business logic; the boundary rejects it first, with
  a field-level message.
- **Minimal boilerplate, maximum derivation.** The author declares nothing per
  boundary: schemas + inferred types + validators are all derived from the fused
  model; generics thread them. One `schema` per type, not one interface + one
  validator + one cast.
- **Consistency across all three surfaces** by construction — DB, engine, and REST
  share one schema per type.
- **`--strip-types` stays viable** (no build, no runtime cost for the interior)
  *precisely because* the compile gate is mandatory and the boundaries carry
  runtime validators — the two things that replace the missing compile step.
- **Generics are honoured, not abandoned** — the user intuition is adopted, with
  the correction that the generic's parameter must be `Infer<typeof schema>` so it
  is backed by a runtime check rather than a phantom cast.

### Non-goals / open questions

- **Schema library choice.** Reuse the existing `validateValue` JSON-Schema subset
  as the descriptor substrate (already derived, already browser-safe per ADR 0059)
  vs. adopting a Standard-Schema-compatible lib (Zod/Valibot) for `Infer`
  ergonomics. Prefer the in-house substrate to stay dependency-free and to keep the
  OpenAPI/DB/engine schemas one representation; expose a Standard-Schema-shaped
  `~standard` adapter if third-party interop is wanted.
- **Validation cost on hot DB reads.** Allow opting a read out of per-row
  validation where a table is provably framework-owned; default is validate.
- **Response validation** stays `dev`-only (ADR 0058) — outbound data is our own.
