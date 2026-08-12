# @nanobpm/agentic-channel

App-tier **channel & hub** for the Nano agentic protocol (ADR 0056, slice **S1**).

This package stands up the one app-tier channel on the app's **own bound port**
and gives every message-family module a place to attach. It builds on the S0 wire
contract in [`@nanobpm/agentic-protocol`](../agentic-protocol); the **Camunda-8
engine transport is a separate connection and is never touched** — the worker
still speaks the C8 job protocol to the engine unchanged.

## What it provides

- **A WebSocket server** (`WebSocketChannelTransport`) bound to the app's own
  port, or attached to an existing app HTTP server to share that port.
- **Authentication** (`sharedSecretAuthenticator`): an ADR 0028 identity token
  **plus** a capability credential — the same `?token=…` pattern
  nano-workforce's blackboard hook uses. Capability (cognition / weight / family
  / host) is an *enrolment attribute*, never a routing token.
- **A connection registry with liveness** (`ConnectionRegistry`): every
  authenticated peer is tracked and ages out on a TTL if it stops sending; any
  inbound frame or keepalive pong refreshes liveness.
- **The family-handler registration seam** (`FamilyRouter.registerFamilyHandler`)
  — the canonical extension point (see below).

## The `registerFamilyHandler` seam

The hub's frame→family routing is **derived from a registration table, not a
hand-edited `switch`**. Each wave-2 slice — S2 presence/registry, S5 relay, S7
blackboard — attaches its family as its **own self-contained module**:

```ts
import { AgenticHub, WebSocketChannelTransport, sharedSecretAuthenticator }
  from "@nanobpm/agentic-channel";

const hub = new AgenticHub({
  transport: new WebSocketChannelTransport({ port: 7332 }),      // the app's own port
  authenticator: sharedSecretAuthenticator({ secret: process.env.AGENTIC_TOKEN! }),
});

// S2's presence module attaches itself — no shared switch to edit:
hub.registerFamilyHandler("register", (frame, ctx) => {
  ctx.registry.setPresence(ctx.id, { instance: /* … */ "" });
  ctx.send({ lane: "control", family: "serve", seq: 1, payload: { /* … */ } });
});
```

Family keys are the S0 `MESSAGE_FAMILIES` set — the single source of truth.
Registering a key outside that set, or a second handler for a family that already
has one, is refused (`UnknownFamilyError` / `DuplicateFamilyHandlerError`), so two
sibling slices cannot silently clobber each other.

## Testing

```bash
npm test        # node --test (unit + a real-socket integration test)
npm run typecheck
```

The hub is transport-agnostic (`ChannelTransport` / `ChannelConnection`), so its
liveness/auth/dispatch logic is exercised deterministically over an in-memory
transport with an injectable clock; `WebSocketChannelTransport` is covered
end-to-end over a real ephemeral-port socket.
