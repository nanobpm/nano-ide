# @nanobpm/agentic

The **Nano agentic protocol** (ADR 0056): one app-tier channel carrying agent presence/registry, demand×supply, a shared blackboard and a live terminal relay. One published package, subpath exports per family.

## Subpath exports

| Import | What |
| --- | --- |
| `@nanobpm/agentic/protocol` | Wire contract, frame codec, routing-token grammar, vocab schema (S0) |
| `@nanobpm/agentic/protocol/conformance` | Shared conformance corpus |
| `@nanobpm/agentic/channel` | App-tier channel & hub, connection registry, auth (S1) |
| `@nanobpm/agentic/presence` | Presence & registry family (S2) |
| `@nanobpm/agentic/vocab` | Vocab resolver + core vocabulary (S3) |
| `@nanobpm/agentic/demand` | Demand×supply model (S4) |
| `@nanobpm/agentic/relay` | Relay ring + QoS scheduler (S5) |
| `@nanobpm/agentic/transcript` | Transcript store, retention-by-lifecycle (S6) + turn-structured view (Camunda `AgentHistoryRecordValue` parity) |
| `@nanobpm/agentic/blackboard` | Blackboard channel family (S7) |
| `@nanobpm/agentic/cockpit` | Operator visibility page — the cockpit (S8) |
| `@nanobpm/agentic/session` | Canonical `SessionEvent` + authoritative session log for durable agent-session resume (ADR 0062) |

The barrel `@nanobpm/agentic` re-exports each family as a namespace (`protocol`, `channel`, …). The worker-side client ships separately as `@nanobpm/urban-agent-client`.

The wire contract is the single source of truth; nothing here rides the Camunda-8 engine or its transport.
