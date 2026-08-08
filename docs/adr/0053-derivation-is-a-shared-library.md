# ADR 0053 — Derivation is a shared library (the Urban toolkit)

Status: Accepted
Date: 2026-07-31
Extends: nano-bpm ADR 0052 (decoupled manifest interpreter / Urban runtime)
Repo: nanobpm/nano-ide (`packages/urban-toolkit`, `packages/urban-runtime`, `packages/urban-cli`, `packages/create-urban-app`)

## Context

ADR 0052 decoupled *running* an Urban app: the manifest is the contract, the runtime is the
interpreter, hosts (Node/Deno/console/CLI) are interchangeable. But an Urban app is not only
run — it is **derived**. Today the console (`nano-bpm/server/src/console`) is effectively the
compiler: as a side effect of the IDE running, it derives a set of typed modules from the model
and the live database and materialises them into `nano-generated/`, wired by a Deno import map:

| specifier | file | derived from |
|---|---|---|
| `@nanobpm/worker` | `workers.ts` + `worker-io.d.ts` | BPMN service tasks + data-envelope io (ADR 0033) |
| `@nanobpm/messages` | `messages.ts` + `message-io.d.ts` | model message defs (ADR 0040) |
| `@nanobpm/meta` | `meta.ts` | model metadata (ADR 0040 §5) |
| `@nanobpm/domain` | `domain.ts` + `domain-rows.d.ts` | fused domain model + live DB (ADR 0029) |
| `@nanobpm/data` | `data-sdk.ts` | datasource (ADR 0024) |
| `@nanobpm/app` | `app-pages.ts` | composed `page.json` (ADR 0042) |

Code-first authoring (nano-bpm PR #381: code → BPMN+DI) is the same shape in the other
direction. These are all **pure functions `derive(inputs) → artifacts`**, but they live coupled
inside the console (some Rust, some TS), so they can only run when the IDE runs. Agents, CI, and
standalone users cannot regenerate outside the console, and there is no drift gate.

## Decision

**Derivation is a library, not an IDE feature.** Introduce `@nanobpm/urban-toolkit`: a registry
of pure, deterministic derivers that both the IDE and the `urban gen` CLI call. The IDE and the
CLI are **peer callers** of the same functions.

Invariants:

1. **Derivers are pure and deterministic.** `derive(inputs) → DerivedArtifact[]` — no IO, same
   inputs ⇒ byte-identical output. All IO (reading models, writing artifacts, comparing) is
   confined to a single `gen` orchestrator behind a tiny FS port, so the same code runs on Node
   and Deno.
2. **One generated directory, one drift domain.** All output lands in the console's existing
   `nano-generated/` directory, using the same filenames and `@nanobpm/*` specifiers, so the
   toolkit is a **drop-in** for the console's own codegen — not a fork. `nano-generated/` is
   gitignored and never committed (regenerable at any time).
3. **The model is authoritative; artifacts are a cache.** `urban gen --check` regenerates in
   memory and diffs against disk, failing on drift. This makes the same gate runnable in the
   CLI, in CI, and in a pre-commit hook — not only live in the console.
4. **Layered separation.** `urban-toolkit` *produces* artifacts; `urban-runtime` (ADR 0052)
   *consumes* them and runs the app; the console/IDE is a UI host that calls the toolkit on save
   and the runtime on run.

### Engine transport

The console wires generated apps to `@nanobpm/nano-sdk`'s `createCamundaClient`, which upgrades
process-instance creation to the Falcon protocol (REST fallback). The runtime's `EngineClient`
is a thin seam; `createNanoSdkEngineClient` adapts that same client (Falcon on the creation hot
path, REST for cold paths). `@nanobpm/nano-sdk` is an optional dependency — the runtime keeps a
dependency-free core and a REST-only default, opting into nano-sdk via `CAMUNDA_TRANSPORT`.

## First cut (this PR)

Three derivers, faithful to the console's formats:

- `types → migrations` — CREATE TABLE per datasource (`nano-generated/<source>.schema.sql`).
- `model → worker-io` — `nano-generated/worker-io.d.ts`, a byte-compatible port of the console's
  `emitWorkerBindings` (ADR 0033 §3).
- `code → model` — a code-first flow → BPMN+DI (`nano-generated/processes/<id>.bpmn`).

Exposed as `urban gen [--check]`.

## Migration path (console → toolkit)

The console migrates onto the toolkit **emitter-by-emitter**, lowest-risk first, with
`urban gen --check` proving parity at each step:

1. `worker-io.d.ts` (already byte-matched here) → console delegates to the toolkit, deletes its
   embedded emitter.
2. `messages` / `meta` → same pattern.
3. `domain` (needs the fused domain model + live DB) → the toolkit gains a DB-schema reader; the
   console delegates.

Engine-tier derivation (the read-model schema, `readstore.rs`) stays in Rust and is out of
scope — only App-tier derivation moves.

## Consequences

- Agents/users/CI regenerate outside the console; the console becomes a thinner UI over the
  toolkit.
- A single drift gate (`urban gen --check`) replaces derivation bugs that previously only
  surfaced live in the IDE.
- Risk: the toolkit and console formats must not diverge during migration. Mitigated by (a)
  byte-compatible ports and (b) the drift gate; a follow-up CI job in nano-bpm should assert the
  console's reified output equals the toolkit's for a fixture.
