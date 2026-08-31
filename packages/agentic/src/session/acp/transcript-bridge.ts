/**
 * The canonical ACP `session/update` → on-wire transcript-chunk bridge (#534).
 *
 * This is the ONE composition of the two halves the package already ships but never joined:
 *
 *  - {@link classifyUpdate} (`./normalize.ts`) maps a wire ACP `session/update` `update` object to a
 *    canonical {@link AcpClassifiedUpdate} (`message` / `tool-call` / `tool-result` / `ignored`), and
 *  - {@link encodeTranscriptEvent} (`../../transcript/events.ts`) encodes a canonical
 *    {@link TranscriptEvent} into the exact nwfTranscriptEvent-marker-as-key chunk the ONE parser
 *    ({@link parseTranscriptEvent}) decodes.
 *
 * Before this bridge existed the grammar was hand-rolled in three places and the producer emitted a
 * marker-as-value shape (the marker under a `type` field with a `v` version) the consumer's
 * marker-as-key decoder never matched, so every envelope fell back to a raw `stream-chunk` and the
 * cockpit rendered "raw replay only". Producers MUST now derive their on-wire bytes from THIS function
 * rather than hand-writing the marker — the derivation-over-duplication rule applied to the wire.
 *
 * Two shape gaps between the canonical classified update and the transcript event are resolved here
 * explicitly (see the issue's "Proposed change §1"):
 *
 *  - a `tool-result`'s opaque `result` (an arbitrary JSON value) is mapped to the transcript
 *    `tool-result`'s textual `content` (a string / omitted), and
 *  - the ACP `reasoning` message role (an agent thought) has no {@link TranscriptRole}, so it is
 *    mapped to `assistant` — the role {@link deriveView} already folds into a message card — which is
 *    what makes an `agent_thought_chunk` render as a structured message instead of raw bytes.
 *
 * The function is pure and total: any input the classifier calls `ignored` (a `plan`, an intermediate
 * `tool_call_update`, a non-text chunk, a malformed update) yields `null` — there is no chunk to emit.
 */
import { encodeTranscriptEvent, type TranscriptEvent, type TranscriptRole } from "../../transcript/events.ts";
import { type AcpClassifiedUpdate, classifyUpdate } from "./normalize.ts";

/**
 * Map the canonical classified-update message role to a {@link TranscriptRole}. ACP's `reasoning` (an
 * `agent_thought_chunk`) has no distinct transcript role, so it folds to `assistant` — the role
 * {@link deriveView} renders as a message card — keeping thoughts visible in the derived history rather
 * than dropping to raw bytes. `assistant`/`user` pass through unchanged.
 */
const ACP_ROLE_TO_TRANSCRIPT: Readonly<Record<"assistant" | "reasoning" | "user", TranscriptRole>> = Object.freeze({
  assistant: "assistant",
  reasoning: "assistant",
  user: "user",
});

/**
 * Resolve an ACP tool-result's opaque `result` (any JSON value) to the transcript `tool-result`'s
 * textual `content`: a string is carried verbatim, `null`/`undefined` omit `content` entirely, and any
 * other JSON value is serialised so the derived tool card always shows the outcome. Never `undefined`
 * inside the encoded object — an omitted `content` is simply left off the event.
 *
 * Serialisation is total: `result` is opaque wire data, so a value `JSON.stringify` rejects (a
 * `BigInt`, a circular reference, a `toJSON` that throws) must NOT abort the producer/ingestion stream
 * for one bad tool result — the bridge is documented "pure and total". Such a value falls back to its
 * `String(result)` form so the tool card still shows an outcome instead of the update crashing. The
 * fallback is itself guarded: `String(result)` invokes `Symbol.toPrimitive`/`toString`/`valueOf`, which
 * a hostile object can also throw from, so it degrades to a fixed placeholder rather than propagating.
 */
function toolResultContent(result: unknown): string | undefined {
  if (result === undefined || result === null) return undefined;
  if (typeof result === "string") return result;
  try {
    const serialised = JSON.stringify(result);
    // `JSON.stringify` returns `undefined` for a lone `undefined`/function/symbol; keep `content` total.
    return serialised === undefined ? safeString(result) : serialised;
  } catch {
    return safeString(result);
  }
}

/**
 * Coerce a value to a string without ever throwing. `String(value)` runs the value's
 * `Symbol.toPrimitive`/`toString`/`valueOf`, any of which a hostile object can throw from, so a failure
 * degrades to a fixed placeholder — keeping {@link toolResultContent} (and the bridge) total.
 */
function safeString(value: unknown): string {
  try {
    return String(value);
  } catch {
    return "[unserialisable tool result]";
  }
}

/**
 * Lift a canonical {@link AcpClassifiedUpdate} to a {@link TranscriptEvent} ready for
 * {@link encodeTranscriptEvent}, or `null` for an `ignored` update (nothing to emit). The `offset` is a
 * placeholder — {@link encodeTranscriptEvent} strips it, and the real store offset is assigned when the
 * chunk is appended — so a fixed `0` keeps the produced bytes deterministic.
 */
function classifiedToTranscriptEvent(classified: AcpClassifiedUpdate): TranscriptEvent | null {
  switch (classified.kind) {
    case "message":
      return {
        kind: "message",
        offset: 0,
        role: ACP_ROLE_TO_TRANSCRIPT[classified.role],
        text: classified.text,
      };
    case "tool-call":
      return {
        kind: "tool-call",
        offset: 0,
        name: classified.name,
        callId: classified.callId,
        args: classified.args,
      };
    case "tool-result": {
      const content = toolResultContent(classified.result);
      return {
        kind: "tool-result",
        offset: 0,
        callId: classified.callId,
        ok: classified.ok,
        ...(content !== undefined ? { content } : {}),
      };
    }
    case "ignored":
      return null;
  }
}

/**
 * THE CANONICAL BRIDGE. Compose {@link classifyUpdate} + {@link encodeTranscriptEvent}: given one raw
 * ACP `session/update` `update` object (the `params.update`), return the EXACT on-wire transcript-chunk
 * bytes a producer appends — the nwfTranscriptEvent-marker-as-key string {@link parseTranscriptEvent}
 * decodes to a typed event and {@link deriveView} folds into a message / tool card — or `null` when the
 * update carries no canonical meaning (an `ignored` classification: `plan`, an intermediate
 * `tool_call_update`, a non-text chunk, or a malformed update).
 *
 * Pure, total, and the SINGLE authoring path for the wire: no new envelope grammar, no hand-rolled
 * marker. A producer emits `acpUpdateToTranscriptChunk(update)` (skipping `null`); a consumer decodes
 * it with {@link parseTranscriptEvent}. The `@nanobpm/agentic/protocol/conformance` transcript vectors
 * pin this exact round-trip so a producer and a consumer can never diverge on the wire again.
 */
export function acpUpdateToTranscriptChunk(update: unknown): string | null {
  const event = classifiedToTranscriptEvent(classifyUpdate(update));
  return event === null ? null : encodeTranscriptEvent(event);
}
