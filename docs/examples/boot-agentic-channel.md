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
mounted as a WebSocket upgrade on the started app's `httpServer`. Presence,
relay, and blackboard ship self-contained family modules that attach to the hub
via the `registerFamilyHandler(family, handler)` seam (S1), so the app never
edits a central dispatch switch. The hub binds **one handler per family**:
presence's `attachPresenceFamily` owns the `register`/`heartbeat`/`deregister`
families (and the TTL sweep), so the composition root supplies only the second
half of `REGISTER→SERVE` — capability resolution — through that module's
`onRegistered` hook, and owns the protocol-only `claim`/`release` families
itself (all shown below).

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
import { CORE_VOCAB, serveCapability, VocabResolver } from "@nanobpm/agentic/vocab";
import { validatePayload } from "@nanobpm/agentic/protocol";
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
// Fail CLOSED on a missing secret: an unset env var would otherwise reach the
// authenticator as an empty secret that any `?token=` connection matches.
// Validate it at runtime before constructing the hub.
const secret = process.env.AGENTIC_CHANNEL_SECRET;
if (!secret) {
  throw new Error("AGENTIC_CHANNEL_SECRET must be set — refusing an empty channel secret");
}
const hub = new AgenticHub({
  transport,
  authenticator: sharedSecretAuthenticator({ secret }),
});

// Relay and blackboard ship self-contained family modules that attach through
// the S1 seam — no central dispatch switch:
registerRelayFamily(hub); //                               S5
attachBlackboardFamily(hub, new BlackboardStore(/* … */)); // S7

// REGISTER→SERVE. Presence ships `attachPresenceFamily`, which owns the whole
// `register`/`heartbeat`/`deregister` lifecycle on the S1 seam: it VALIDATES and
// narrows each untrusted frame payload (the decoded `Frame.payload` is `unknown`),
// persists the row, mirrors the instance onto the live registry, calls
// `removeInstance` on deregister, and schedules the presence-TTL sweep that ages
// out rows a worker stops heartbeating. The composition root supplies only the
// SECOND half of the handshake — capability resolution — through the module's
// `onRegistered` hook, which fires after a validated register with the narrowed
// instance + capability, so it never re-owns (or re-validates) the `register`
// family:
const resolver = new VocabResolver(CORE_VOCAB);
const presence = attachPresenceFamily(hub, new PresenceStore(/* … */), {
  onRegistered: (ctx, instance, capability) =>
    serveCapability(resolver, ctx, instance, capability), // SERVE reply → control lane
}); //                                                         S2 + S3

// `claim`/`release` are protocol-only families (no shipped module or ownership
// store), so the composition root owns them too — attach via the SAME S1 seam,
// backed by an app ownership store. `validatePayload` proves SHAPE (`{ instance,
// jobKey }` are non-empty strings) but a VALID frame is not yet an AUTHORISED
// one: an authenticated peer must not claim/release ANOTHER connection's
// instance. Prove OWNERSHIP before touching the store by resolving the frame's
// EXPLICIT `instance` against the registry's `instancesForConnection(ctx.id)` —
// §4.6 attribution's source of truth, never inferred 1:1 from the connection id
// (one connection may multiplex many instances). Hand the store the validated,
// still-`unknown` payload rather than destructuring an untrusted frame. Without
// these handlers `FamilyRouter` silently drops the multiplexed emitter's
// ownership frames and the §4.6 ownership window never opens.
// The store interface is concrete so `ownership.claim`/`release` type-check;
// the no-op default keeps the snippet bootable while it owns no jobs. Swap in a
// real store (one that opens the §4.6 ownership window) for production.
interface OwnershipStore {
  claim(identity: string, payload: unknown): void;
  release(identity: string, payload: unknown): void;
}
const ownership: OwnershipStore = {
  claim: () => {},
  release: () => {},
};
// Narrow the `unknown` payload with a type GUARD (no `as` cast) and accept it
// only if `owned` — the connection's registered instances — contains the named
// instance. Returns `false` for a shape the validator already rejected, so it is
// also safe as a standalone check.
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const ownsNamedInstance = (payload: unknown, owned: ReadonlySet<string>): boolean =>
  isRecord(payload) && typeof payload.instance === "string" && owned.has(payload.instance);
hub.registerFamilyHandler("claim", (frame, ctx) => {
  if (!validatePayload("claim", frame.payload).ok) return;
  // Reject a claim for an instance this connection does not own (anti-spoofing).
  if (!ownsNamedInstance(frame.payload, ctx.registry.instancesForConnection(ctx.id))) return;
  ownership.claim(ctx.identity, frame.payload);
});
hub.registerFamilyHandler("release", (frame, ctx) => {
  if (!validatePayload("release", frame.payload).ok) return;
  if (!ownsNamedInstance(frame.payload, ctx.registry.instancesForConnection(ctx.id))) return;
  ownership.release(ctx.identity, frame.payload);
});

await transport.ready();

// On shutdown, tear down the channel alongside the app: stop the presence sweep
// timer, then close the hub — `AgenticHub.close()` clears the hub liveness timer,
// closes tracked connections, and closes the WebSocket transport, so channel
// resources do not leak across an app shutdown/restart:
// presence.stop();
// await hub.close();
```

Three QoS lanes are encoded on every frame: control/facts > interactive > bulk.
The scheduler that enforces them sits on **relay subscriber egress** (each
subscriber gets a `QosScheduler`), so a bulk relay storm never head-of-line-blocks
that subscriber's relay control acks. Inbound heartbeats and blackboard writes are
handled directly by the hub, off that scheduler — the lanes label frames, they do
not impose a global ordering across families. Invariant #5.

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
