# The Nano agentic protocol — a generic `@nanobpm/urban` capability

> **Status:** **shipped.** Epic
> [nanobpm/nano-ide#124](https://github.com/nanobpm/nano-ide/issues/124) (slices
> S0–S10) is closed, and the capability is published as **one package,
> `@nanobpm/agentic`**, with subpath exports (§6). Nano Workforce depends on it
> (`@nanobpm/agentic@^0.14`). This document describes the current state on `main`.
> The slice history is kept in §6.1 for provenance.
>
> **Design of record** (in the nano-bpm spec repo, `docs/adr/`):
> ADR&nbsp;0056 — _Agent relay / command-stream plane_;
> ADR&nbsp;0057 — _Console App View_;
> ADR&nbsp;0062 — _Durable agent session resume_ (the session log, §5.3);
> ADR&nbsp;0046 — _Agent-as-worker vs agent-in-the-node_ (where the engine-native
> AgentInstance fits, §1.1). This document is the capability and wire-contract
> companion to them.

## 1. What this is

The **Nano agentic layer** is a generic Urban runtime capability: **one app-tier
channel**, served by the app on its own bound port. It carries agent
**presence/registry**, **job ownership** (`claim`/`release`), **demand×supply**, the
**blackboard**, and **live relay** (terminal bytes and structured ACP transcripts,
with an inbound steer/control lane). Any agentic Urban app (Nano Workforce first) gets
_networks of agents_ and visibility for free, the same way apps get pages and workers.

The agentic channel is a **separate connection** next to the C8 job protocol. It
never runs on top of it, and nothing in this channel requires an engine change.

### 1.1 Relationship to the engine's AgentInstance / AgentHistory

When this epic shipped, the engine knew nothing about agents. Since then it has
gained **engine-native AgentInstance and AgentHistory** (nano-bpm epic
[#984](https://github.com/nanobpm/nano-bpm/issues/984), Camunda 8.10 parity). This
is a **C8 protocol feature**, not part of the agentic channel. The two planes divide
the work this way:

| Concern | Owner | Granularity / durability |
| --- | --- | --- |
| Agent turns: role, content, tool calls, metrics, `loopIteration`, commit status | **Engine**: `AgentInstance` + AgentHistory turn log, keyed `agentInstanceKey` → `elementInstanceKey`; REST `POST /v2/agent-instances/search`, `POST /v2/agent-instances/{key}/history/search` | Committed **turns**. System of record. Replicated with the engine |
| Live bytes / token stream of an in-flight turn, terminal output | **Agentic channel**: `relay` family + transcript store, stream `(instance, jobKey)` | Sub-turn **chunks**. App-tier, retention-bounded |
| Resume state of a harness session across workers | **Session log** (`@nanobpm/agentic/session`, ADR 0062), keyed `(processInstanceKey, elementId)` | Events + checkpoints. App-tier |
| Presence, demand×supply, blackboard | **Agentic channel** | Live, app-tier |

The worker (the c8ctl-nano supervisor) writes AgentHistory through the C8 REST API,
lease-gated by the job's `jobLeaseToken` (the engine request field, required by both
the create and update requests). It writes the relay/transcript stream over the
agentic channel. A consumer that only needs **what the agent did** (for example the
Process Explorer agent-history scrubber,
[nano-bpm#1314](https://github.com/nanobpm/nano-bpm/issues/1314)) reads the engine and
needs no running app. A consumer that wants **what the agent is doing right now**
also attaches to the relay, and must fall back gracefully when the hosting app is
down ([nano-bpm#1315](https://github.com/nanobpm/nano-bpm/issues/1315)).

## 2. Design invariants (do not drift)

These are load-bearing. Every slice is held to them; a change to any of them is an
ADR-level decision, not a slice-local one.

1. **App-tier, not engine-tier.** Nothing rides the engine or its transport. The
   channel is served by the app (`@nanobpm/urban` runtime) on the app's own bound
   port.
2. **The channel needs nothing from the engine.** The worker speaks the C8 job
   protocol (including the 8.10 agent-instance endpoints, §1.1) to the engine. The
   agentic channel is a separate connection, and no channel feature may require a
   change to the Rust engine or the C8 protocol. Engine-side agent state is a C8
   parity concern, not a channel concern.
3. **Routing token = `network[.subnetwork…].role[#seat]`**, matched by the engine
   **1:1**. Capability (cognition / weight / family / host) is **never** in the
   token — it is an enrolment attribute + a registry gate.
4. **The capability→token map lives in the versioned vocab artifact**, applied over
   the channel (`REGISTER` → `SERVE`). No map is baked into any worker.
5. **Three QoS lanes on the one channel:** `control/facts` > `interactive` >
   `bulk`. A bulk-output storm must never head-of-line-block a heartbeat or a
   blackboard write.
6. **Hub-down tolerance is the worker's job.** The hub does not assume always-on
   producers; the worker buffers and drains across a hub outage (the worker client, `@nanobpm/urban-agent-client`).
7. **Core vocabulary is opinionated and works out of the box; authors extend it in
   the same schema.**

## 3. Architecture at a glance

```
          ┌───────────────────────── Urban app (host) ──────────────────────────┐
          │                                                                     │
          │   C8 job protocol + 8.10 agent-instance REST  ──►  ┌────────────┐   │
 worker ──┼──(jobs, AgentInstance, AgentHistory turns)──────►  │ C8 engine  │   │
   │      │                                                    └────────────┘   │
   │      │   agentic channel (separate WS, app's own port)                     │
   └──────┼──►  ┌──────────────────── hub ─────────────────────┐                │
          │     │  frame codec + 3-lane QoS framing  (protocol) │                │
          │     │  registerFamilyHandler(family, handler)       │ ◄── families   │
          │     │   ├─ register/heartbeat/deregister (presence) │     attach as  │
          │     │   ├─ claim / release        (job ownership)   │     own modules│
          │     │   ├─ serve                  (vocab handshake) │                │
          │     │   ├─ demand                 (demand×supply)   │                │
          │     │   ├─ relay   (ring + QoS; out: bytes/ACP;     │                │
          │     │   │           in: steer / control frames)     │                │
          │     │   └─ blackboard             (idempotent append)               │
          │     └───────────────────────────────────────────────┘                │
          │   registry rows · transcript store · session log ── app DataLayer   │
          │   cockpit page (App View + standalone)                              │
          └─────────────────────────────────────────────────────────────────────┘
```

## 4. The wire contract (`@nanobpm/agentic/protocol`)

The wire is authored **once** as a shared contract and a shared **conformance
corpus**, because two implementations are written concurrently by different agents
(the TypeScript codec here and the c8ctl client that consumes it). A shared prose
spec does **not** stop divergence — **shared adversarial test vectors do.** If a
vector looks wrong, the corpus (`@nanobpm/agentic/protocol/conformance`) is fixed
first, never just one codec.

### 4.1 Message families

The canonical set is `MESSAGE_FAMILIES` in `@nanobpm/agentic/protocol`
(`src/protocol/families.ts`). It is the one source of truth that the hub's
handler-registration seam and every family module key off. On-wire codes
(`FAMILY_CODES`) are append-only:

| Family                              | Direction        | Purpose                                                        |
| ----------------------------------- | ---------------- | -------------------------------------------------------------- |
| `register` / `heartbeat` / `deregister` | worker → hub | presence & liveness                                          |
| `serve`                             | hub → worker     | resolved leaf tokens from the capability handshake           |
| `demand`                            | hub → cockpit    | demand×supply per network, "missing agent type"              |
| `blackboard`                        | both             | idempotent, capability-scoped coordination append/read       |
| `relay`                             | both             | out: live terminal bytes / ACP transcript chunks `{stream, offset, chunk}`; in: steer (§4.5) |
| `claim` / `release`                 | worker → hub     | job ownership: `{instance, jobKey}`, idempotent (#542)         |

### 4.2 Frame codec & the three QoS lanes

Every frame carries a **QoS lane**: `control/facts` (heartbeats, registry, vocab,
blackboard) > `interactive` (live terminal keystrokes/echo) > `bulk` (large
command output). The scheduler is instantiated only on **relay subscriber egress**
(`relay-family.ts`), so the guarantee is scoped to that path: a bulk-output storm
never head-of-line-blocks a subscriber's relay control acknowledgements — buffered
bulk sheds ahead of them. Heartbeat/blackboard handling and `HubConnection.send`
(`channel/hub.ts`) bypass the scheduler, so it does not order those families around
a relay storm. Round-trip encode/decode and every malformed-input rejection are
pinned by the conformance corpus.

### 4.3 Routing token grammar

```
token   = network ("." subnetwork)* "." role ("#" seat)?
```

The token is matched by the engine **1:1**. Capability lives **outside** the token
— it is declared at enrolment and gated by the registry. Examples:
`planning.spar#red`, `implementation.impl`, `ci.gate`.

### 4.4 Vocab artifact JSON schema (core + extension)

The capability→token map is a **versioned artifact**, not code. Its JSON schema
(in `/protocol`) defines, per role: `requires`, `weight`, `seats`, and
`seatsDistinctFamily`. The **core vocabulary** (`planning.*`, `qa.*`,
`implementation.*`, `ci.*`, `decide`, and seats) ships opinionated and works out
of the box; authors extend it **in the same schema** (`/vocab` merges core + extension
and computes the diversity SLO, `family(#red) ≠ family(#blue)`).

### 4.5 Inbound control frames (steer)

The outbound relay data frame stays `{ stream, offset, chunk }`. The **inbound**
(consumer → agent) lane carries a typed control vocabulary (`protocol/control.ts`):
`prompt` (start a turn), `cancel` (interrupt the turn) and `permission` (answer a
blocked ACP `session/request_permission`). A structured frame is a JSON envelope
tagged `nanoControlFrame: 1`. A tagged but malformed envelope is an **error**. Any
untagged chunk decodes as a legacy `prompt` whose text is the raw bytes, so
raw-keystroke PTY steering keeps working unchanged.

### 4.6 Transcript streams and ownership

A job transcript's relay stream id is the `(instance, jobKey)` pair, composed as
`N:<instance>/<jobKey>` by `composeStreamId`; `parseStreamId` is its exact inverse
(`@nanobpm/agentic/emit`). `N` is the instance length in UTF-16 code units. Before
streaming, a worker emits `claim {instance, jobKey}`, and `release` when the job
settles. Both are idempotent. One host connection can multiplex many hired instances
(`emit` client, #545). ACP output is normalized into transcript envelopes by the one
canonical bridge, `session/acp/transcript-bridge.ts` (#534), and pinned by a
conformance vector.

## 5. Hub seam and stores

### 5.1 The handler-registration seam (`@nanobpm/agentic/channel`)

Multiple families attach a **new inbound message-family handler** to the single hub,
in parallel. To stop them colliding on a central `frame → family` dispatch switch,
the hub exposes an explicit, tested seam:

```ts
hub.registerFamilyHandler(family, handler);
```

The hub binds **one handler per family** and its routing is **derived** from the
registration table, never a hand-edited switch. Not every family ships a
self-attaching module, though: **presence** (`register`/`heartbeat`/`deregister`),
**relay**, and **blackboard** ship self-contained modules that attach themselves
through this seam (`attachPresenceFamily`, `registerRelayFamily`,
`attachBlackboardFamily`). `attachPresenceFamily` owns the whole
`register`/`heartbeat`/`deregister` lifecycle (validation, registry mirroring,
and the TTL sweep); the `serve` reply and `claim`/`release` are **protocol-only**
surfaces — shipped as the `serveCapability` helper and the emit client
(`@nanobpm/agentic/emit`), *not* as self-attaching modules or an ownership store.
So the composition root supplies the `serve` half of `REGISTER→SERVE` through
presence's `onRegistered` hook, and owns the `claim`/`release` handlers itself,
composing the shipped stores and helpers (see
[`examples/boot-agentic-channel.md`](examples/boot-agentic-channel.md)).

### 5.2 Transcript store (`@nanobpm/agentic/transcript`)

Durable, retention-bounded chunk storage per stream, in the app DataLayer. Readers
resume with `since(from)`, which returns `{entries, gap, nextOffset}`. `gap: true`
means retention already dropped chunks the reader asked for, and consumers must
show it rather than splice over it. The store also keeps an additive
**turn-structured** view (`TranscriptTurn`: `sequence`, `loopIteration`, `role`,
content blocks, `toolCalls`, `metrics`, `producedAt`, #475) that mirrors those
turn-level fields of the engine's AgentHistory items. It is a parity *projection*,
not a wire-compatible copy: it omits record identity/linkage, job attribution,
commit status, and other engine-only AgentHistory fields, so consumers should not
treat it as interchangeable with an AgentHistory item. `deriveDisplay` / `createDisplayProjection` fold events into
ordered display blocks for UIs (#566). Stream metadata includes `byteLength` and
`chunkCount` (#521).

### 5.3 Session log (`@nanobpm/agentic/session`, ADR 0062)

The authoritative, resumable harness-session log: canonical `SessionEvent`s
(`system`, `user`, `assistant`, `reasoning`, `tool-call`, `tool-result`,
`compaction`, `usage`, `turn-start`, `turn-end`) with gap-free offsets, causal
`parentId`, incarnation fencing and checkpoints. It is keyed per activation
`(processInstanceKey, elementId)` in tables `agentic_session_log`,
`agentic_session_event` and `agentic_session_checkpoint`. Ingestion backends:
ACP (`session/acp`, preferred) and per-harness normalizers (`session/normalizer`:
claude, copilot, qwen, kimi, pi, deepseek). It exists so a re-leased job can
resume the same conversation on another worker. It is **not** the system of record
for completed turns; the engine's AgentHistory is (§1.1).

## 6. Package layout

Everything ships as **`@nanobpm/agentic`** (`packages/agentic`). Each concern is a
subpath export, and each has a `./source/<subpath>` twin for strip-types consumers:

| Subpath | Contents |
| --- | --- |
| `/protocol` | families, frame codec, QoS lanes, token grammar, payload validators, control frames, vocab schema |
| `/protocol/conformance` | the shared golden and malformed vector corpus (frames, tokens, vocab, control, transcript) |
| `/channel` | hub, WS transport, auth, `registerFamilyHandler`, connection registry |
| `/emit` | client-side ownership/presence emit client, `composeStreamId` / `parseStreamId` |
| `/presence` | register/heartbeat/deregister family + registry store |
| `/vocab` | resolver, core vocabulary, extension merge, diversity SLO, `serve` |
| `/demand` | demand×supply model, C8 REST task-definition reader, agentic-task detection (`linkName="prompt"`, #364) |
| `/relay` | replay ring, QoS scheduler, incarnation fencing, relay family |
| `/transcript` | transcript store, event schema, turn view, display projection |
| `/blackboard` | blackboard family + store |
| `/session` | session log, ACP backend, harness normalizers |
| `/cockpit` | operator cockpit: terminal and structured views, relay client |

There are **two** worker-side clients, and they are not interchangeable:

- **`@nanobpm/urban-agent-client`** (`packages/urban-agent-client`) is the
  **single-instance** worker client: one connection carries one agent's
  REGISTER→SERVE, heartbeat/deregister, and relay bytes. It has **no
  `claim`/`release`** — it predates the multi-instance ownership protocol and
  cannot drive the §4.6 ownership flow.
- **`@nanobpm/agentic/emit`** (`packages/agentic/src/emit`) is the blessed
  **multiplexed ownership/transcript emitter**: one host connection that N
  instances share, emitting `register` / `heartbeat` / `deregister` /
  `claim` / `release` and the relay transcript sink with an explicit `instance`
  per frame, with reconnect resync. A supervisor that hires many instances and
  must run the §4.6 claim/release ownership flow builds on **this** client, not
  the single-instance one.

### 6.1 Slice history (epic #124, all closed)

| Slice | Issue | Delivered |
| ----- | ----- | --------- |
| S0 | [#126](https://github.com/nanobpm/nano-ide/issues/126) | Contract & conformance corpus |
| S1 | [#127](https://github.com/nanobpm/nano-ide/issues/127) | App-tier WS hub + `registerFamilyHandler` + auth |
| S2 | [#128](https://github.com/nanobpm/nano-ide/issues/128) | Presence & registry |
| S3 | [#129](https://github.com/nanobpm/nano-ide/issues/129) | Vocab resolver + core vocabulary + diversity SLO |
| S4 | [#130](https://github.com/nanobpm/nano-ide/issues/130) | Demand×supply model |
| S5 | [#131](https://github.com/nanobpm/nano-ide/issues/131) | Relay ring + QoS scheduler |
| S6 | [#132](https://github.com/nanobpm/nano-ide/issues/132) | Transcript store |
| S7 | [#133](https://github.com/nanobpm/nano-ide/issues/133) | Blackboard family |
| S8 | [#134](https://github.com/nanobpm/nano-ide/issues/134) | Cockpit |
| S9 | [#135](https://github.com/nanobpm/nano-ide/issues/135) | Worker client library |
| S10 | [#136](https://github.com/nanobpm/nano-ide/issues/136) | This doc + CI + example |

Post-epic additions: turn-structured transcript / AgentHistory parity (#475), shared
ACP plumbing and structured steer (#480, #514), the canonical ACP→transcript bridge
(#534), claim/release ownership + multi-instance presence (#542, #545),
`parseStreamId` (#557), streaming display blocks (#566), and the ADR 0062 session
log (#365).

## 7. Conformance in CI (this repo **and** c8ctl)

The conformance corpus is the anti-drift keystone: both the codec in this repo
and the c8ctl client are held to the **same** golden frames and vocab documents.
CI runs it through a single canonical entry point.

### 7.1 In this repo

The root exposes one script — the single source of truth for "run the conformance
corpus":

```bash
npm run test:conformance
```

It runs every workspace package's `test:conformance` script
(`npm run test:conformance --workspaces --if-present`). Today that is three
packages: `@nanobpm/agentic`'s `src/protocol/conformance/corpus.test.ts`,
`@nanobpm/urban-agent-client`'s `src/conformance.test.ts`, and `@nanobpm/urban`'s
`src/context/conformance/**/*.conformance.ts`. The `conformance` job in
[`.github/workflows/ci.yml`](../.github/workflows/ci.yml) runs it on every push /
PR to `main` or an `epic/**` branch.

### 7.2 In c8ctl (cross-repo)

The corpus is exported as `@nanobpm/agentic/protocol/conformance`
([jwulf/c8ctl-plugin-nano#38](https://github.com/jwulf/c8ctl-plugin-nano/issues/38)
imports it for the contract). c8ctl's CI depends on the corpus
package (or the published corpus fixtures) and runs the **same** golden vectors
against its client codec, so both sides converge on one contract:

```jsonc
// c8ctl-plugin-nano — package.json (illustrative)
{
  "scripts": {
    // resolve the shared corpus from @nanobpm/agentic and run it against the client
    "test:conformance": "node --test \"test/conformance/**/*.test.ts\""
  }
}
```

Wiring c8ctl's own CI job is c8ctl's responsibility; this repo's obligation is to
keep the corpus **consumable** and to hold its own codec to it.

## 8. Booting the channel in an Urban app

See the worked example in
[`examples/boot-agentic-channel.md`](./examples/boot-agentic-channel.md). In short,
there is no `@nanobpm/urban/agentic` capability barrel: an agentic Urban app mounts
the channel itself. It snapshots the started app's `httpServer` (the runtime's
native `node:http` `Server`), serves the channel as a WebSocket upgrade on that own
port with `WebSocketChannelTransport` from `@nanobpm/agentic/channel`, constructs an
`AgenticHub` over that transport with an authenticator, and attaches each family via
`registerFamilyHandler` (§5.1).

## 9. Out of scope / open

- **Matchmaking** (the registry actively placing work, or holding a seat's job for a
  distinct family). The registry is still a **read-only mirror + enrolment gate**.
- Any engine or C8-protocol change *driven by the channel* (invariant 2). Engine
  AgentInstance/AgentHistory evolve under C8 parity (§1.1).
- Console (Process Explorer) consumption of the relay tail with graceful
  degradation when the hosting app is down: tracked in
  [nano-bpm#1315](https://github.com/nanobpm/nano-bpm/issues/1315).
