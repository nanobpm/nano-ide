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
| `@nanobpm/agentic/transcript` | Transcript store, retention-by-lifecycle (S6) + turn-structured view (Camunda `AgentHistoryRecordValue` parity) + the typed transcript-event **vocabulary** & single `parseTranscriptEvent` fold |
| `@nanobpm/agentic/blackboard` | Blackboard channel family (S7) |
| `@nanobpm/agentic/cockpit` | Operator visibility page — the cockpit (S8) |
| `@nanobpm/agentic/session` | Canonical `SessionEvent` + authoritative session log for durable agent-session resume (ADR 0062) |

The barrel `@nanobpm/agentic` re-exports each family as a namespace (`protocol`, `channel`, …). The worker-side client ships separately as `@nanobpm/urban-agent-client`.

The wire contract is the single source of truth; nothing here rides the Camunda-8 engine or its transport.

## Transcript event vocabulary (`@nanobpm/agentic/transcript`)

The transcript subpath now ships the canonical typed transcript-event **vocabulary** alongside the S6
store, so every Urban app derives ACP-rich transcripts from **one** parser instead of forking its own:

```ts
import {
  parseTranscriptEvent,          // THE ONE PARSER: stored chunk → typed TranscriptEvent
  deriveView,                    // THE ONE FOLD: typed events → per-turn structured view
  deriveViewFromChunks,          // parse + fold in one call
  mergeTranscriptVocab,          // additive EXTENSION POINT (register a new kind, never fork)
  CORE_TRANSCRIPT_VOCAB,
  encodeTranscriptEvent,
  utf8ByteLength,                // browser-safe (TextEncoder, no Buffer)
  TRANSCRIPT_EVENT_MARKER,       // "nwfTranscriptEvent" — canonical single source of truth
  TRANSCRIPT_EVENT_VERSION,      // 1
} from "@nanobpm/agentic/transcript";
```

The vocab/parser modules are **browser-safe** (no `Buffer`, no Node-only imports), so the cockpit derive
runs in-browser. Kinds: `message`, `tool-call`, `tool-result`, `turn`, `step`, `lifecycle`, `permission`,
plus the raw `stream-chunk` fallback that preserves byte-level replay fidelity. A stored chunk is decoded
as a structured event **only** when it is a JSON object carrying `TRANSCRIPT_EVENT_MARKER` at the current
version — otherwise it is retained verbatim, so a raw ANSI frame that happens to be JSON is never
mis-classified. `TRANSCRIPT_EVENT_MARKER` + `parseTranscriptEvent` are the canonical detection surface
the whole package family (e.g. the cockpit's structured-stream drill-in) imports from here — never a
private copy.

### Permission events (ACP `session/request_permission`)

`permission` is a **first-class core kind** (not an extension): ACP's `session/request_permission` is
protocol-universal — every Urban app with ACP agents gets permission prompts — so it lives beside
`tool-call`/`tool-result` in `CORE_TRANSCRIPT_VOCAB`. A single decoder handles both phases (`request`
and `resolution`), branching on `phase`; the fold pairs a request with its resolution by `callId` into a
`DerivedPermission` on `DerivedView.permissions` and `DerivedTurn.permissions` (mirroring how a
`tool-call` pairs with its `tool-result`). `optionKindAllows(kind)` is the single source of truth for
whether a chosen ACP option allows or rejects the action.

```ts
import { optionKindAllows, type DerivedPermission } from "@nanobpm/agentic/transcript";

optionKindAllows("allow-once"); // true   (allow-* → allow)
optionKindAllows("reject-always"); // false (reject-* → reject)
```

### Extending the vocabulary (merge, don't fork)

A downstream app adds its own kind + parse handler **without editing this package**:

```ts
const appVocab = mergeTranscriptVocab(CORE_TRANSCRIPT_VOCAB, {
  annotation: (body, offset) =>
    typeof body.noteId === "string"
      ? { kind: "message", offset, role: "system", text: `annotation(${body.noteId})` }
      : undefined, // reject malformed → raw fallback
});
parseTranscriptEvent({ offset, chunk }, appVocab); // the one parser, now aware of `annotation`
```

### Migration for nano-workforce

`nano-workforce` currently forks this vocabulary at `app/agentic/transcript-events.ts`. To consume the
shared copy:

1. Replace imports of the local `./transcript-events.ts` with `@nanobpm/agentic/transcript`
   (`parseTranscriptEvent`, `deriveView`, `mergeTranscriptVocab`, `TRANSCRIPT_EVENT_MARKER`,
   `TRANSCRIPT_EVENT_VERSION`, `utf8ByteLength`, the event types, …). The public API — symbol names,
   the `"nwfTranscriptEvent"` marker string, and version `1` — is preserved verbatim, so this is a
   drop-in.
2. nano-workforce's `permission` kind (nano-workforce#559) is now **first-class in this package** —
   import `PermissionPolicy`, `PermissionOption`, `PermissionOptionKind`, `optionKindAllows`,
   `PermissionRequestEvent`, `PermissionResolutionEvent`, and `DerivedPermission` from here instead of
   registering it via `mergeTranscriptVocab` or maintaining a forked shape.
3. **Delete** `app/agentic/transcript-events.ts` (and fold its `transcript-events.drift.test.ts` marker
   guard into the shared package's guard, already ported here as `events.drift.test.ts`).
