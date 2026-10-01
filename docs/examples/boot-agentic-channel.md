# Example — booting the Nano agentic channel in an Urban app

> Part of slice **S10** (epic
> [nanobpm/nano-ide#124](https://github.com/nanobpm/nano-ide/issues/124)). This is
> the **example wiring** that boots the agentic channel for an agentic Urban app.
> See [`../nano-agentic-protocol.md`](../nano-agentic-protocol.md) for the contract.

## The idea

An agentic Urban app serves the channel on the **app's own bound port** — a
separate connection from the C8 job protocol, which is untouched. There is no
`@nanobpm/urban/agentic` capability barrel and no `agenticChannel(...)` manifest
key: the shipped surface is the channel hub from `@nanobpm/agentic/channel`,
mounted as a WebSocket upgrade on the started app's `httpServer`. Each message
family attaches itself to the hub via the `registerFamilyHandler(family, handler)`
seam (S1), so the app never edits a central dispatch switch.

## Host wiring

```ts
// main.ts — an agentic Urban app
import { createUrbanApp } from "@nanobpm/urban/runtime";
import {
  AgenticHub,
  WebSocketChannelTransport,
  sharedSecretAuthenticator,
} from "@nanobpm/agentic/channel";
import { attachPresenceFamily, PresenceStore } from "@nanobpm/agentic/presence";
import { registerRelayFamily } from "@nanobpm/agentic/relay";
import { attachBlackboardFamily, BlackboardStore } from "@nanobpm/agentic/blackboard";

const app = await createUrbanApp({
  // …the app's normal pages / workers / datasources…
});
await app.start(); // binds the app's own HTTP port

// Snapshot the runtime's native node:http Server and narrow it before use (the
// runtime exposes it as `object | undefined`; no type assertion needed).
const { Server } = await import("node:http");
const server = app.httpServer;
if (!(server instanceof Server)) {
  throw new Error("agentic channel needs the app's node:http Server");
}

// Serve the channel as a WebSocket upgrade on the app's OWN port (default path
// `/agentic`) — alongside, never on top of, the C8 job protocol. Invariant #1 & #2.
const transport = new WebSocketChannelTransport({ server });

// Auth for the channel: a shared-secret identity token + a required capability
// credential — the same pattern nano-workforce's blackboard hook uses (S1). Swap
// in a real ADR 0028 verifier by passing your own `Authenticator` to the hub.
const hub = new AgenticHub({
  transport,
  authenticator: sharedSecretAuthenticator({
    secret: process.env.AGENTIC_CHANNEL_SECRET!,
  }),
});

// Each family attaches through the S1 seam — no central dispatch switch.
attachPresenceFamily(hub, new PresenceStore(/* … */)); // S2
registerRelayFamily(hub); //                             S5
attachBlackboardFamily(hub, new BlackboardStore(/* … */)); // S7

await transport.ready();
```

Three QoS lanes are on by default: control/facts > interactive > bulk. A
bulk-output storm never head-of-line-blocks a heartbeat. Invariant #5.

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

> **Single-instance vs multiplexed.** `@nanobpm/urban-agent-client` (above) is the
> single-instance client — one connection, one agent, no `claim`/`release`. A
> supervisor that hires many instances and runs the §4.6 ownership flow uses the
> blessed multiplexed emitter `@nanobpm/agentic/emit` instead. See
> [`../nano-agentic-protocol.md`](../nano-agentic-protocol.md) §6.

## Verifying it boots

Booting the app and connecting a worker should show the worker in the registry
with presence, and its terminal streaming to the cockpit page (S8). The
conformance corpus (`npm run test:conformance`) guards the wire contract both
sides implement.
