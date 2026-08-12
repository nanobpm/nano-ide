# Example — booting the Nano agentic channel in an Urban app

> Part of slice **S10** (epic
> [nanobpm/nano-ide#124](https://github.com/nanobpm/nano-ide/issues/124)). This is
> the **example wiring** that boots the agentic channel for an agentic Urban app.
> The channel/hub itself lands with **S1** ([#127](https://github.com/nanobpm/nano-ide/issues/127))
> and the families with S2/S3/S5/S7; the snippet below is the intended, stable
> host wiring and is promoted to a runnable example package as those slices land.
> See [`../nano-agentic-protocol.md`](../nano-agentic-protocol.md) for the contract.

## The idea

An agentic Urban app opts into the capability exactly the way it opts into pages
and workers today: it declares it, and the `@nanobpm/urban` runtime serves the
channel on the **app's own bound port** — a separate connection from the C8 job
protocol, which is untouched. Each message family attaches itself to the hub via
the `registerFamilyHandler(family, handler)` seam (S1), so the app never edits a
central dispatch switch.

## Host wiring

```ts
// main.ts — an agentic Urban app
import { createApp } from "@nanobpm/urban";
// The agentic capability + its core families (each attaches via the S1 seam).
// Package names are finalised by S0/S1; import the capability barrel it exports.
import { agenticChannel, coreVocab } from "@nanobpm/urban/agentic";

const app = createApp({
  // …the app's normal pages / workers / datasources…

  // Enable the agentic channel. Served on the app's own bound port, alongside
  // (never on top of) the C8 job protocol. Invariant #1 & #2.
  agentic: agenticChannel({
    // The versioned vocab artifact: core vocabulary + this app's extensions,
    // merged in the same schema (S3). Capability→token map lives HERE, never in
    // a worker. Invariant #4 & #7.
    vocab: coreVocab.extend({
      // app-specific roles/seats go here, in the same schema
    }),

    // Auth for the channel: ADR 0028 identity + a capability credential — the
    // same pattern nano-workforce's blackboard hook already uses (S1).
    auth: { identity: "adr-0028", capabilityCredential: true },

    // Three QoS lanes are on by default: control/facts > interactive > bulk.
    // A bulk-output storm never head-of-line-blocks a heartbeat. Invariant #5.
  }),
});

await app.listen(); // serves pages, workers, AND the agentic channel
```

## What a worker does (client side — S9)

A worker connects to the channel (a **separate** connection from its C8 job
stream), declares its capability, and receives its resolved tokens:

```ts
import { connectAgenticChannel } from "@nanobpm/urban-agent-client"; // S9

// connectAgenticChannel returns synchronously and starts connecting immediately.
const agent = connectAgenticChannel({ url: process.env.AGENTIC_CHANNEL_URL! });

// REGISTER {capability} → SERVE [leaf tokens]. Capability is an enrolment
// attribute, NOT part of any routing token. Invariant #3.
const { serve } = await agent.register({
  capability: { cognition: "high", weight: 3, family: "opus", host: "cli" },
});
// serve === ["planning.spar#red", …] — resolved from the vocab artifact (S3)

agent.heartbeat();                 // liveness; ages out on TTL if it stops (S2)
agent.relay("stdout", "hello\n");  // stream terminal bytes on the relay lane (S5)
// The client buffers + drains across a hub outage — hub-down tolerance. Invariant #6.
```

## Verifying it boots

Once S1 has landed, booting the app and connecting a worker should show the worker
in the registry with presence, and its terminal streaming to the cockpit page
(S8). Until then, this file documents the stable wiring surface and the conformance
corpus (`npm run test:conformance`) guards the wire contract both sides implement.
