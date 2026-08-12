# @nanobpm/agentic-demand

The **demand×supply model** for the Nano agentic protocol (ADR 0056, slice **S4**).

A **read-only mirror + enrolment gate**. It reads the deployed models'
`taskDefinition` leaves from the engine's C8 REST API, buckets them by network
prefix, and diffs that *demand* against live *supply* — the S2 presence registry
resolved through the S3 vocabulary — to surface, per network, the **missing
agent types** (`demand ∖ supply`) and the **SLO state**.

It does **not** match-make: it never places work on a worker or holds a seat's
job. Active placement is out of scope for v1. Nothing here rides the Camunda-8
engine or its transport — the C8 REST read is an ordinary read over a separate
connection; the engine and the C8 job protocol stay frozen.

## What it computes

Given:

- **demand** — the distinct routing tokens deployed models declare (each a
  `<zeebe:taskDefinition type="…">` leaf), and
- **supply** — the live S2 registry, where a worker *serves* a token iff that
  token is in `resolver.resolve(worker.capability).tokens` (S3),

`computeDemandSupply` reports, per network:

- every demanded token and how many registered workers serve it;
- the **missing agent types** — demanded tokens with zero supply;
- the **SLO state** — the worst of the missing-agent signal (a missing token is
  RED) and the S3 diversity SLO (`family(#red) ≠ family(#blue)`).

Capability (cognition/weight/family/host) is **never** in the routing token — it
is the enrolment attribute the vocab's `requires` gate reads (design invariant 3).

## Usage

```ts
import { VocabResolver, CORE_VOCAB } from "@nanobpm/agentic-vocab";
import {
  httpC8RestReader,
  readDeployedTaskDefinitions,
  computeDemandSupply,
  toDemandPayloads,
} from "@nanobpm/agentic-demand";

const resolver = new VocabResolver(CORE_VOCAB);

// Demand: read deployed taskDefinition leaves from the C8 REST API.
const reader = httpC8RestReader({ restAddress: "http://localhost:8080/v2" });
const taskDefinitions = await readDeployedTaskDefinitions(reader);

// Supply: the live S2 registry rows ({ instance, capability }).
const workers = presenceStore.list().map((row) => ({
  instance: row.instance,
  capability: row.capability,
}));

const report = computeDemandSupply({ taskDefinitions, workers, resolver });

report.status;          // "green" | "amber" | "red"
report.missing;         // e.g. ["ci.runner"] — the missing agent types
report.networks;        // per-network demand×supply
toDemandPayloads(report); // one S0 `demand` payload per network for the channel
```

## Design invariants honoured

- **App-tier, read-only.** Reads engine state over ordinary C8 REST; mutates
  nothing.
- **Engine frozen.** No change to the Rust engine or the C8 job protocol.
- **Token ≠ capability.** Supply is resolved via the S3 `requires` gate; the
  routing token never carries capability.
- **Vocab is the one map.** Token derivation comes entirely from the S0/S3 vocab
  artifact; no map is baked in here.

Built on `@nanobpm/agentic-protocol` (wire contract) and `@nanobpm/agentic-vocab`
(resolver, registry rows, diversity SLO).
