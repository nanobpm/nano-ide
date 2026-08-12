# The Nano agentic protocol — a generic `@nanobpm/urban` capability

> **Status:** authored in parallel with the implementation slices (epic
> [nanobpm/nano-ide#124](https://github.com/nanobpm/nano-ide/issues/124)). Sections
> marked _“lands with Sn”_ describe contracts owned by a slice that may not yet be
> merged on `epic/agent-protocol`; they are the source of truth for that slice and
> are updated as each slice lands.
>
> **Design of record:** ADR&nbsp;0056 — _Agent relay / command-stream plane_
> (`docs/adr/0056-agent-relay-command-stream-plane.md` in the nano-bpm spec repo,
> [Magikcraft/nano-bpm#670](https://github.com/Magikcraft/nano-bpm/issues/670)) and
> ADR&nbsp;0057 — _Console App View_. Read those first; this document is the
> capability + wire-contract companion to them.

## 1. What this is

The **Nano agentic layer** is a generic Urban runtime capability: **one app-tier
channel**, served by the app on its own bound port, that carries agent
**presence/registry**, **demand×supply**, the **blackboard**, and **live terminal
relay**. Any agentic Urban app (Nano Workforce first) gets _networks of agents_ +
visibility for free — the way apps get pages and workers today.

The Camunda-8-compatible engine is **not touched**: it stays a frozen 1:1
job-type router. The agentic channel is a **separate connection**, alongside the
C8 job protocol, never on top of it.

## 2. Design invariants (do not drift)

These are load-bearing. Every slice is held to them; a change to any of them is an
ADR-level decision, not a slice-local one.

1. **App-tier, not engine-tier.** Nothing rides the engine or its transport. The
   channel is served by the app (`@nanobpm/urban` runtime) on the app's own bound
   port.
2. **The engine stays frozen.** The worker still speaks the C8 job protocol to the
   engine unchanged; the agentic channel is a separate connection. **Zero** changes
   to the Rust engine or the C8 protocol.
3. **Routing token = `network[.subnetwork…].role[#seat]`**, matched by the engine
   **1:1**. Capability (cognition / weight / family / host) is **never** in the
   token — it is an enrolment attribute + a registry gate.
4. **The capability→token map lives in the versioned vocab artifact**, applied over
   the channel (`REGISTER` → `SERVE`). No map is baked into any worker.
5. **Three QoS lanes on the one channel:** `control/facts` > `interactive` >
   `bulk`. A bulk-output storm must never head-of-line-block a heartbeat or a
   blackboard write.
6. **Hub-down tolerance is the worker's job.** The hub does not assume always-on
   producers; the worker buffers and drains across a hub outage (S9).
7. **Core vocabulary is opinionated and works out of the box; authors extend it in
   the same schema.**

## 3. Architecture at a glance

```
          ┌───────────────────────── Urban app (host) ─────────────────────────┐
          │                                                                     │
          │   C8 job protocol  ───────────►  ┌──────────────┐                   │
 worker ──┼──(unchanged, frozen engine)────► │  C8 engine   │  (1:1 token       │
   │      │                                   └──────────────┘   router)        │
   │      │                                                                     │
   │      │   agentic channel (separate WS, app's own port)                     │
   └──────┼──►  ┌─────────────── hub (S1) ───────────────┐                      │
          │     │  frame codec + 3-lane QoS framing (S0) │                      │
          │     │  registerFamilyHandler(family, handler)│ ◄── families attach  │
          │     │   ├─ register/heartbeat/deregister (S2)│     as own modules   │
          │     │   ├─ serve            (vocab handshake, S3)                    │
          │     │   ├─ demand           (demand×supply,   S4)                    │
          │     │   ├─ relay            (ring + QoS,       S5)                   │
          │     │   └─ blackboard       (idempotent append, S7)                 │
          │     └────────────────────────────────────────┘                      │
          │        registry rows / transcript store  ── app DataLayer (S2/S6)   │
          │        cockpit page (App View + standalone) ─────────────── (S8)    │
          └─────────────────────────────────────────────────────────────────────┘
```

## 4. The wire contract (owned by S0 — `#126`)

The wire is authored **once** as a shared contract and a shared **conformance
corpus**, because two implementations are written concurrently by different agents
(the TypeScript codec here and the c8ctl client that consumes it). A shared prose
spec does **not** stop divergence — **shared adversarial test vectors do.** If a
vector looks wrong, it is fixed on the **S0 issue**, never unilaterally in one
codec.

### 4.1 Message families

The canonical set of message families is exported by S0 as a single named constant
(the one source of truth that S1's handler-registration seam and every family
module key off):

| Family                              | Direction        | Purpose                                                        |
| ----------------------------------- | ---------------- | -------------------------------------------------------------- |
| `register` / `heartbeat` / `deregister` | worker → hub | presence & liveness (S2)                                       |
| `serve`                             | hub → worker     | resolved leaf tokens from the capability handshake (S3)        |
| `demand`                            | hub → cockpit    | demand×supply per network, "missing agent type" (S4)          |
| `blackboard`                        | both             | idempotent, capability-scoped coordination append/read (S7)    |
| `relay`                             | worker → hub → cockpit | live terminal / command-stream bytes (S5)                |

### 4.2 Frame codec & the three QoS lanes

Every frame carries a **QoS lane**: `control/facts` (heartbeats, registry, vocab,
blackboard) > `interactive` (live terminal keystrokes/echo) > `bulk` (large
command output). The scheduler (S5) guarantees a bulk-output storm never
head-of-line-blocks a heartbeat or a blackboard write. Round-trip encode/decode
and every malformed-input rejection are pinned by the S0 corpus.

### 4.3 Routing token grammar

```
token   = network ("." subnetwork)* "." role ("#" seat)?
```

The token is matched by the engine **1:1**. Capability lives **outside** the token
— it is declared at enrolment and gated by the registry. Examples:
`planning.spar#red`, `implementation.impl`, `ci.gate`.

### 4.4 Vocab artifact JSON schema (core + extension)

The capability→token map is a **versioned artifact**, not code. Its JSON schema
(owned by S0) defines, per role: `requires`, `weight`, `seats`, and
`seatsDistinctFamily`. The **core vocabulary** (`planning.*`, `qa.*`,
`implementation.*`, `ci.*`, `decide`, and seats) ships opinionated and works out
of the box; authors extend it **in the same schema** (S3 merges core + extension
and computes the diversity SLO, `family(#red) ≠ family(#blue)`).

## 5. The handler-registration seam (owned by S1 — `#127`)

Multiple families (S2 presence, S5 relay, S7 blackboard) attach a **new inbound
message-family handler** to the single hub, in parallel. To stop them colliding on
a central `frame → family` dispatch switch, the hub exposes an explicit, tested
seam:

```ts
hub.registerFamilyHandler(family, handler);
```

Each family is a self-contained module that attaches itself via this seam; the
hub's routing is **derived** from the registration table, never a hand-edited
switch. This is the canonical extension point every family module uses.

## 6. Slice map (what lands where)

| Slice | Sub-issue | Owns |
| ----- | --------- | ---- |
| **S0** | [#126](https://github.com/nanobpm/nano-ide/issues/126) | Contract & conformance corpus (message families, codec, QoS framing, vocab schema, shared fixtures) |
| **S1** | [#127](https://github.com/nanobpm/nano-ide/issues/127) | App-tier WS hub + `registerFamilyHandler` seam + auth |
| **S2** | [#128](https://github.com/nanobpm/nano-ide/issues/128) | Presence & registry (`register`/`heartbeat`/`deregister`, TTL) |
| **S3** | [#129](https://github.com/nanobpm/nano-ide/issues/129) | Vocab resolver + core vocabulary + diversity SLO |
| **S4** | [#130](https://github.com/nanobpm/nano-ide/issues/130) | Demand×supply model |
| **S5** | [#131](https://github.com/nanobpm/nano-ide/issues/131) | Relay ring + QoS scheduler |
| **S6** | [#132](https://github.com/nanobpm/nano-ide/issues/132) | Transcript store |
| **S7** | [#133](https://github.com/nanobpm/nano-ide/issues/133) | Blackboard channel family |
| **S8** | [#134](https://github.com/nanobpm/nano-ide/issues/134) | Visibility page (the cockpit) |
| **S9** | [#135](https://github.com/nanobpm/nano-ide/issues/135) | Worker client library (consumed by c8ctl) |
| **S10** | [#136](https://github.com/nanobpm/nano-ide/issues/136) | **This doc + CI wiring + example** |

## 7. Conformance in CI (this repo **and** c8ctl)

The S0 conformance corpus is the anti-drift keystone: both the codec in this repo
and the c8ctl client are held to the **same** golden frames and vocab documents.
CI runs it through a single canonical entry point.

### 7.1 In this repo

The root exposes one script — the single source of truth for "run the conformance
corpus":

```bash
npm run test:conformance
```

It runs every workspace package's `test:conformance` script
(`npm run test:conformance --workspaces --if-present`). Until S0 publishes its
package the target is a no-op (green); the **moment** S0's package declares a
`test:conformance` script, the same command exercises the real corpus — no CI edit
required, no second entry point to drift. The `conformance` job in
[`.github/workflows/ci.yml`](../.github/workflows/ci.yml) runs it on every push /
PR to `main` and to the `epic/**` integration branches.

### 7.2 In c8ctl (cross-repo)

The corpus is exported by S0 as a consumable artifact
([jwulf/c8ctl-plugin-nano#38](https://github.com/jwulf/c8ctl-plugin-nano/issues/38)
imports S0 for the contract and S9 for the client). c8ctl's CI depends on the S0
package (or the published corpus fixtures) and runs the **same** golden vectors
against its client codec, so both sides converge on one contract:

```jsonc
// c8ctl-plugin-nano — package.json (illustrative)
{
  "scripts": {
    // resolve the shared corpus from the S0 package and run it against the client
    "test:conformance": "node --test \"test/conformance/**/*.test.ts\""
  }
}
```

Wiring c8ctl's own CI job is c8ctl's responsibility; this repo's obligation is to
keep the corpus **consumable** and to hold its own codec to it. See S0 (`#126`) and
S9 (`#135`) for the export surface c8ctl imports.

## 8. Booting the channel in an Urban app

See the worked example in
[`examples/boot-agentic-channel.md`](./examples/boot-agentic-channel.md). In short,
an agentic Urban app enables the capability alongside its pages and workers; the
runtime serves the channel on the app's own bound port and each family attaches via
the S1 seam.

## 9. Out of scope (v1)

- **Matchmaking** (the registry actively placing work / holding a seat's job for a
  distinct family). v1 is a **read-only mirror + enrolment gate**.
- Engine or C8-protocol changes of any kind.
- `nano-workforce` adoption of the capability (its own follow-up).
