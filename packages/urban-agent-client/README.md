# @nanobpm/urban-agent-client

Worker-side client for the **Nano agentic channel** (ADR 0056, epic
[nanobpm/nano-ide#124](https://github.com/nanobpm/nano-ide/issues/124), slice
**S9**).

A worker uses it — on a connection **separate from the C8 job protocol** — to
join the one app-tier agentic channel: declare a capability and receive its
resolved routing tokens, heartbeat/deregister for presence, and stream live
terminal / command-stream bytes. It speaks the
[`@nanobpm/agentic-protocol`](../agentic-protocol) wire contract (S0) and is held
to its shared conformance corpus; it never redefines the contract.

## What it does

- **`REGISTER` → `SERVE`.** Declares a capability (an _enrolment attribute_ —
  never part of a routing token, invariant #3) and resolves the leaf tokens the
  vocab handshake (S3) hands back.
- **Heartbeat / deregister.** Liveness so the registry ages the worker out on TTL
  (S2); a clean deregister on shutdown.
- **Produce relay bytes.** Streams output on the `bulk` lane with a monotonic
  per-stream byte offset so the hub-side ring can resume-from-offset (S5).
- **Hub-down tolerance (invariant #6).** Everything the worker produces goes
  through a bounded, QoS-aware **outbound ring**. The worker keeps producing while
  the hub is gone; on reconnect the buffer drains in strict lane priority
  (`control` > `interactive` > `bulk`), so a bulk-output storm never
  head-of-line-blocks a heartbeat (invariant #5). On overflow the ring sheds the
  oldest **bulk** frame first and never drops a control frame to make room for a
  relay chunk.

## Usage

```ts
import { connectAgenticChannel } from "@nanobpm/urban-agent-client";

const agent = connectAgenticChannel({ url: process.env.AGENTIC_CHANNEL_URL! });

// REGISTER {capability} → SERVE [leaf tokens]. Capability is an enrolment
// attribute, NOT part of any routing token.
const { serve } = await agent.register({
  capability: { cognition: "high", weight: 3, family: "opus", host: "cli" },
});
// serve === ["planning.spar#red", …] — resolved from the vocab artifact (S3)

agent.heartbeat();                 // liveness; ages out on TTL if it stops (S2)
agent.relay("stdout", "hello\n");  // stream terminal bytes on the relay/bulk lane
// …the client buffers + drains across a hub outage automatically…
agent.deregister("done");          // best-effort deregister, then close
```

You may `register` / `relay` **before** the channel is open — the frames buffer
and drain once it connects.

### Options

| option                | default            | meaning                                                              |
| --------------------- | ------------------ | -------------------------------------------------------------------- |
| `url`                 | —                  | the agentic channel URL (the app's own bound port)                   |
| `instance`            | random UUID        | stable instance id carried on every presence frame                   |
| `capability`          | —                  | capability to (re-)register with; may also be passed to `register()` |
| `transport`           | binary `WebSocket` | injectable {@link TransportFactory} (tests, custom framing)          |
| `bufferCapacity`      | `1024`             | outbound ring size in frames                                         |
| `heartbeatIntervalMs` | `0` (manual)       | auto-heartbeat period                                                |
| `serveTimeoutMs`      | `30000`            | how long `register()` waits for its `SERVE`                          |
| `reconnect`           | enabled            | backoff policy (`initialDelayMs`, `maxDelayMs`, `factor`)            |

### Events

`onServe`, `onFrame`, `onOpen`, `onClose`, `onError`, `onDrain` — each returns an
unsubscribe function. Decode/validation/transport errors are surfaced via
`onError` and are **never thrown**: a malformed inbound frame can never crash the
worker.

## Building blocks

The package also exports its internals for reuse and testing:

- **`OutboundRing`** — the bounded, QoS-aware buffer/flush-on-reconnect ring.
- **`websocketTransport` / `TransportFactory`** — the transport seam; supply your
  own to run without a global `WebSocket` or with custom framing.
- The S0 contract surface it consumes (`encodeFrame`, `decodeFrame`,
  `validatePayload`, `parseToken`, `MESSAGE_FAMILIES`, `QOS_LANES`, …), re-exported
  from `@nanobpm/agentic-protocol`.

## Conformance

`npm run test:conformance` runs this client against the **shared** adversarial
corpus at `@nanobpm/agentic-protocol/conformance` — golden frames both
directions, malformed byte vectors, and routing-token vectors — the same corpus
the S0 codec and the cross-repo c8ctl client are held to. It runs from source
(no build step) so the repo's `conformance` CI job exercises the real vectors.

## Runtime

Node ≥ 22 (which provides a global `WebSocket`). Ships as source `.ts` plus a
built `dist`; runs under `node --experimental-strip-types` like the rest of the
Urban stack.
