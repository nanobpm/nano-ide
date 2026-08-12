# @nanobpm/agentic-relay

Relay ring + QoS scheduler for the **Nano agentic protocol** (ADR 0056, slice
**S5**). Live terminal relay over the one app-tier channel: it carries a worker's
terminal bytes to any number of watching consumers, survives consumer reconnects,
and never lets a bulk-output storm starve control/interactive traffic.

It attaches the `relay` message family to the S1 hub
(`@nanobpm/agentic-channel`) through the canonical
`registerFamilyHandler(family, handler)` seam — its own self-contained module,
never a hand-edited dispatch switch — and builds on the S0 wire contract
(`@nanobpm/agentic-protocol`). The Camunda-8 engine transport is a separate
connection and is never touched.

## Primitives

- **`ReplayRing`** — a bounded, per-stream replay buffer. Every appended chunk
  gets a monotonic, gap-free `offset`; only the most recent `capacity` chunks are
  retained. `since(from)` returns the retained tail for **resume-from-offset** and
  flags a `gap` when the requested offset was already evicted.
- **`IncarnationFence`** — generation fencing. Each producer stamps frames with an
  `incarnation`; once a newer incarnation takes over a stream, frames from an
  older one are fenced off, so a zombie producer can't corrupt a live stream.
- **`QosScheduler`** — the three-lane egress (`control` > `interactive` > `bulk`).
  Control/interactive drain eagerly and are **never** head-of-line-blocked; the
  `bulk` relay lane is gated by **credit-based backpressure** (a slow consumer
  grants credit for what it can accept) and bounded (overflow sheds the oldest
  bulk frame — safe, because the `ReplayRing` retains it for resume).
- **`RelayHub`** — composes the three, one replay ring + fence per stream and one
  scheduler per consumer.

## Wire sub-protocol (in the `relay` family payload)

Inbound (peer → hub):

| `op`        | fields                        | effect |
|-------------|-------------------------------|--------|
| `produce`   | `stream, incarnation, chunk`  | append a chunk (offset assigned by the hub); stale incarnations fenced |
| `subscribe` | `stream, from?, credit?`      | (re)attach and resume from `from` (default 0) |
| `credit`    | `credit`                      | grant more bulk credit (backpressure) |

Outbound (hub → consumer):

- a **data** frame is a pure S0 `RelayPayload` `{ stream, offset, chunk }` on the
  `bulk` lane;
- a **subscribed** ack rides the `control` lane and reports `{ gap, nextOffset }`.

## Usage

```ts
import { AgenticHub } from "@nanobpm/agentic-channel";
import { registerRelayFamily } from "@nanobpm/agentic-relay";

const hub = new AgenticHub({ transport, authenticator });
// Attach the relay family via the S1 seam; returns the RelayHub driving it.
const relay = registerRelayFamily(hub, { ringCapacity: 4096, defaultCredit: 256 });
```

The `relay` family is now routed by the hub's derived registration table. A
second `registerRelayFamily(hub)` is rejected by the seam
(`DuplicateFamilyHandlerError`) — one owning module per family.
