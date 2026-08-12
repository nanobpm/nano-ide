# @nanobpm/agentic-vocab

Vocab resolver and core vocabulary for the **Nano agentic protocol** (ADR 0056,
slice **S3**). Turns the versioned vocab artifact — the one capability→token map,
never baked into a worker — into the `REGISTER {capability}` → `SERVE [leaf
tokens]` handshake, and grades review-seat diversity.

Built on [`@nanobpm/agentic-protocol`](../agentic-protocol) (the wire contract:
message families, routing-token grammar, vocab schema, `serve` payload). This
package builds on that contract and never redefines it.

## What it provides

- **`VocabResolver`** — resolves a declared enrolment capability
  (`cognition` / `weight` / `family` / `host`) to a **deterministic** SERVE token
  set: every role whose `requires` gate the capability satisfies. Capability is
  the enrolment attribute the gate reads; it is **never** in the routing token.
- **`CORE_VOCAB`** — the opinionated core vocabulary that works out of the box:
  the `planning.*`, `qa.*`, `implementation.*`, `ci.*` networks plus the bare
  `decide` role, each gated by a `requires` predicate and sized with seats.
- **`mergeVocab(extension, base?)`** — merge an author extension over the core (or
  any base) **in the same schema**; the result is re-validated and returned fresh
  (neither input is mutated).
- **Diversity SLO** — `computeDiversity` / `correlateRegistry` grade seating
  **red / amber / green**: a same-family collision is **red** on a role that opted
  into `seatsDistinctFamily` (strict), **amber** on a warn-default role, **green**
  otherwise.
- **Serve handshake** — `serveCapability` / `buildServeFrame` resolve a capability
  and emit the `serve` reply on the **control** lane. (S2 owns the `register`
  family on the hub; this slice supplies the resolve-and-reply half, so the
  composition root wires it without editing S2.)

## `requires` predicate grammar

Each `requires` entry gates one capability field:

```
predicate = field op value
field     = cognition | weight | family | host
op        = "=" | "==" | "!=" | ">=" | "<=" | ">" | "<"
```

Ordering operators (`>=`, `<=`, `>`, `<`) apply to the numeric `weight` field
only. A capability satisfies a role iff it satisfies **every** predicate; a role
with no `requires` is open to any capability. Matching is fail-closed: an absent
field fails every positive predicate (only `!=` is satisfied by an absent field).

## Bare (network-less) roles

The S0 vocab schema nests roles under networks, so every role-derived token has at
least `network.role`. To express a single-segment token like `decide`, author a
**self-named top-level role** — `networks.decide.roles.decide` — which the
resolver collapses to the bare token `decide`.

## Example

```ts
import { VocabResolver, CORE_VOCAB, correlateRegistry } from "@nanobpm/agentic-vocab";

const resolver = new VocabResolver(CORE_VOCAB);

// REGISTER {capability} -> SERVE [leaf tokens]
resolver.resolve({ cognition: "planning", family: "acme" }).tokens;
// => ["planning.planner", "planning.reviewer"]

// Grade the live registry's family mix against the diversity SLO.
correlateRegistry(resolver, [
  { instance: "w-a", capability: { cognition: "planning", family: "acme" } },
  { instance: "w-b", capability: { cognition: "planning", family: "acme" } },
]).status;
// => "red"  (planning.reviewer is strict and both seats are family "acme")
```

## Scripts

```bash
npm run typecheck -w @nanobpm/agentic-vocab
npm run build     -w @nanobpm/agentic-vocab
npm test          -w @nanobpm/agentic-vocab
```
