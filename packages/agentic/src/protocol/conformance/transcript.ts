/**
 * The published ACP → transcript-chunk conformance vectors (#534).
 *
 * Golden triples `(ACP session/update) → (exact on-wire chunk bytes) → (expected typed event)` that
 * BOTH sides of the transcript wire import and hold themselves to:
 *
 *  - the PRODUCER (the c8ctl-nano ACP harness) asserts `acpUpdateToTranscriptChunk(update) === chunk`,
 *    so it can never regress to the old marker-as-value (type/v) envelope shape, and
 *  - the CONSUMER (the `@nanobpm/agentic/transcript` parser / the cockpit) asserts
 *    `parseTranscriptEvent({ offset, chunk })` decodes to `event` (never a raw `stream-chunk`) and
 *    `deriveView` folds it into a message / tool card.
 *
 * Because the SAME bytes pin both sides, a slice can no longer be green on one end while the wire
 * disagrees on the other — the ADR 0004 shared-contract-coordination failure class this issue closes.
 *
 * The `update` objects are the `params.update` of a real ACP `session/update` notification. Each
 * `chunk` is the EXACT string a producer appends (a committed golden — a bridge change that alters the
 * body bytes fails the round-trip test) and is `null` for an `ignored` ACP update (a `plan`, an
 * intermediate `tool_call_update`, a non-text chunk): there is no canonical chunk to emit. `event` is
 * the typed event the parser decodes the chunk into at the given offset, or `null` when `chunk` is
 * `null`.
 *
 * The envelope's marker key/version prefix is DERIVED from the one canonical definition
 * ({@link TRANSCRIPT_EVENT_MARKER} / {@link TRANSCRIPT_EVENT_VERSION}), never hardcoded — the transcript
 * drift-guard requires the marker string live only in `transcript/events.ts`, and deriving it here keeps
 * this golden honest against a marker/version change while still pinning the exact body bytes.
 *
 * Coverage spans every core ACP update kind the transcript wire carries: `agent_message_chunk`,
 * `agent_thought_chunk`, `user_message_chunk`, `tool_call`, a terminal `tool_call_update`, and an
 * `ignored` `plan`.
 */
import { TRANSCRIPT_EVENT_MARKER, TRANSCRIPT_EVENT_VERSION, type TranscriptEvent } from "../../transcript/events.ts";

/** The envelope's leading `{"<marker>":<version>,` bytes, derived from the ONE marker definition so this
 * golden never hardcodes the marker literal (the transcript drift-guard forbids a second copy of it). */
const ENVELOPE_PREFIX = `{${JSON.stringify(TRANSCRIPT_EVENT_MARKER)}:${TRANSCRIPT_EVENT_VERSION},`;

/** Compose the exact chunk bytes: the derived marker prefix + a literal golden body (the part
 * `encodeTranscriptEvent` appends after the marker). The body is pinned verbatim so a byte drift fails. */
function envelope(body: string): string {
  return `${ENVELOPE_PREFIX}${body}}`;
}

/** One `(ACP update) → (chunk bytes) → (typed event)` golden triple pinning the transcript wire. */
export interface AcpTranscriptVector {
  readonly name: string;
  /** The ACP `update.sessionUpdate` discriminant this vector exercises. */
  readonly sessionUpdate: string;
  /** The raw ACP `session/update` `update` object (`params.update`) fed to the bridge / classifier. */
  readonly update: Record<string, unknown>;
  /** Exact on-wire chunk bytes the bridge emits, or `null` when the update is `ignored` (no chunk). */
  readonly chunk: string | null;
  /** The typed event the parser decodes `chunk` into (at `offset`), or `null` when `chunk` is `null`. */
  readonly event: TranscriptEvent | null;
  /** The store offset the vector's expected `event` is decoded at (arbitrary; the wire bytes are offset-free). */
  readonly offset: number;
}

/**
 * The published golden triples. Imported by this repo's bridge round-trip test AND by the cross-repo
 * producer (jwulf/c8ctl-plugin-nano) so neither side can drift from the canonical wire.
 */
export const ACP_TRANSCRIPT_VECTORS: readonly AcpTranscriptVector[] = [
  {
    name: "agent_message_chunk -> assistant message",
    sessionUpdate: "agent_message_chunk",
    update: { sessionUpdate: "agent_message_chunk", messageId: "m1", content: { type: "text", text: "Hello, world." } },
    chunk: envelope('"kind":"message","role":"assistant","text":"Hello, world."'),
    event: { kind: "message", offset: 0, role: "assistant", text: "Hello, world." },
    offset: 0,
  },
  {
    name: "agent_thought_chunk -> assistant message (reasoning folds to assistant)",
    sessionUpdate: "agent_thought_chunk",
    update: { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "Let me think about this." } },
    chunk: envelope('"kind":"message","role":"assistant","text":"Let me think about this."'),
    event: { kind: "message", offset: 0, role: "assistant", text: "Let me think about this." },
    offset: 0,
  },
  {
    name: "user_message_chunk -> user message",
    sessionUpdate: "user_message_chunk",
    update: { sessionUpdate: "user_message_chunk", messageId: "u1", content: { type: "text", text: "Please refactor foo()." } },
    chunk: envelope('"kind":"message","role":"user","text":"Please refactor foo()."'),
    event: { kind: "message", offset: 0, role: "user", text: "Please refactor foo()." },
    offset: 0,
  },
  {
    name: "tool_call -> tool-call",
    sessionUpdate: "tool_call",
    update: { sessionUpdate: "tool_call", toolCallId: "call-1", title: "read_file", kind: "read", rawInput: { path: "src/app.ts" } },
    chunk: envelope('"kind":"tool-call","name":"read_file","callId":"call-1","args":{"path":"src/app.ts"}'),
    event: { kind: "tool-call", offset: 0, name: "read_file", callId: "call-1", args: { path: "src/app.ts" } },
    offset: 0,
  },
  {
    name: "tool_call_update (terminal, completed) -> tool-result",
    sessionUpdate: "tool_call_update",
    update: { sessionUpdate: "tool_call_update", toolCallId: "call-1", status: "completed", rawOutput: { bytes: 128, ok: true } },
    chunk: envelope('"kind":"tool-result","callId":"call-1","ok":true,"content":"{\\"bytes\\":128,\\"ok\\":true}"'),
    event: { kind: "tool-result", offset: 0, callId: "call-1", ok: true, content: '{"bytes":128,"ok":true}' },
    offset: 0,
  },
  {
    name: "plan -> ignored (no chunk)",
    sessionUpdate: "plan",
    update: { sessionUpdate: "plan", entries: [{ content: "Step one", status: "pending" }] },
    chunk: null,
    event: null,
    offset: 0,
  },
];
