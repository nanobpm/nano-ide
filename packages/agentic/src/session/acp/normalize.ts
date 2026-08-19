/**
 * The ACP → canonical `SessionEvent` normaliser — ADR 0062, slice 2.
 *
 * A **pure, per-notification classifier**: it maps one ACP `session/update`
 * payload (the `update` object, discriminated by `sessionUpdate`) to a single
 * {@link AcpClassifiedUpdate}. It is deliberately free of any I/O, causal-chain,
 * or coalescing concern — those belong to {@link ./client.ts}, which owns event
 * identity (`id`/`parentId`) and buffers streamed chunks into whole messages.
 * Keeping the wire→model mapping a pure function is what makes the ingestion
 * fidelity testable in isolation (see `normalize.test.ts`).
 *
 * ## What maps, and what does not (ADR 0062 §5 fidelity note)
 *
 * The three primitives the world half needs all live in one ACP notification
 * stream:
 *
 *  - `agent_message_chunk` / `agent_thought_chunk` / `user_message_chunk` →
 *    canonical `assistant` / `reasoning` / `user` message text.
 *  - `tool_call` → a canonical `tool-call` (the request).
 *  - `tool_call_update` at a **terminal** status (`completed`/`failed`) → a
 *    canonical `tool-result`; the tool-call lifecycle is exactly the
 *    checkpoint/effect boundary the world half (slice 4) consumes.
 *
 * Everything else ACP streams — `plan`, `available_commands_update`,
 * `current_mode_update`, `config_option_update`, `session_info_update`, and the
 * intermediate `tool_call_update`s (status `pending`/`in_progress`) — is
 * classified `ignored`: not a canonical mind event, retained only as a reason
 * string for observability.
 *
 * The **gaps** (why slice 3's native normaliser must exist) are enumerated as a
 * first-class, testable artifact in {@link ACP_FIDELITY_GAPS} — do not let that
 * list drift from this mapping.
 */
import { contentBlockText, isRecord } from "./protocol.ts";

/**
 * The outcome of classifying one ACP `session/update`. A `message` still needs
 * its chunks coalesced by the client; a `tool-call`/`tool-result` is a complete
 * canonical event body; an `ignored` update carries no canonical meaning.
 */
export type AcpClassifiedUpdate =
  | {
      readonly kind: "message";
      readonly role: "assistant" | "reasoning" | "user";
      /** Groups streamed chunks into one message; `null` when the agent omits it. */
      readonly messageId: string | null;
      readonly text: string;
    }
  | { readonly kind: "tool-call"; readonly callId: string; readonly name: string; readonly args: unknown }
  | { readonly kind: "tool-result"; readonly callId: string; readonly ok: boolean; readonly result: unknown }
  | { readonly kind: "ignored"; readonly sessionUpdate: string; readonly reason: string };

// A null-prototype map so `sessionUpdate in CHUNK_ROLE` and `CHUNK_ROLE[sessionUpdate]`
// only ever see the three explicit chunk types — a wire `sessionUpdate` like
// "toString" or "constructor" must not match an inherited Object.prototype key and
// classify a chunk with a bogus (function-valued) role.
const CHUNK_ROLE: Readonly<Record<string, "assistant" | "reasoning" | "user">> = Object.assign(
  Object.create(null),
  {
    agent_message_chunk: "assistant",
    agent_thought_chunk: "reasoning",
    user_message_chunk: "user",
  },
);

function ignored(sessionUpdate: string, reason: string): AcpClassifiedUpdate {
  return { kind: "ignored", sessionUpdate, reason };
}

function optMessageId(update: Record<string, unknown>): string | null {
  const id = update.messageId;
  return typeof id === "string" ? id : null;
}

function classifyChunk(update: Record<string, unknown>, sessionUpdate: string): AcpClassifiedUpdate {
  const role = CHUNK_ROLE[sessionUpdate];
  const text = contentBlockText(update.content);
  if (text === null) {
    // A non-text content block (image/audio/resource_link) carries nothing the
    // canonical text model can represent — an intentional fidelity gap, not data.
    return ignored(sessionUpdate, `${role} chunk had no textual content`);
  }
  return { kind: "message", role, messageId: optMessageId(update), text };
}

function classifyToolCall(update: Record<string, unknown>): AcpClassifiedUpdate {
  const callId = update.toolCallId;
  if (typeof callId !== "string" || callId.length === 0) {
    return ignored("tool_call", `tool_call missing a string "toolCallId"`);
  }
  // ACP has no machine tool *name* distinct from the human-readable `title`
  // (ADR 0062 §5 gap); `title` is the best available identifier, falling back to
  // the call id when even that is absent.
  const title = update.title;
  const name = typeof title === "string" && title.length > 0 ? title : callId;
  // The call arguments live in `rawInput` (an opaque JSON value) when the agent
  // exposes them; otherwise there is nothing structured to record. Fall back to
  // `null` (never `undefined`), mirroring the tool-result `rawOutput` path: the
  // canonical `ToolCallEvent.args` is a JSON-serialisable value, and `undefined`
  // is dropped by `JSON.stringify`, which would violate that shape on persist/replay.
  const args = "rawInput" in update && update.rawInput !== undefined ? update.rawInput : null;
  return { kind: "tool-call", callId, name, args };
}

function classifyToolCallUpdate(update: Record<string, unknown>): AcpClassifiedUpdate {
  const callId = update.toolCallId;
  if (typeof callId !== "string" || callId.length === 0) {
    return ignored("tool_call_update", `tool_call_update missing a string "toolCallId"`);
  }
  const status = update.status;
  if (status !== "completed" && status !== "failed") {
    // pending / in_progress / unknown / status-less patch — an intermediate
    // lifecycle beat, not yet a canonical result.
    return ignored("tool_call_update", `tool_call_update status "${String(status)}" is not terminal`);
  }
  // Prefer the structured `rawOutput`; fall back to the display `content` array.
  const result = "rawOutput" in update ? update.rawOutput : (update.content ?? null);
  return { kind: "tool-result", callId, ok: status === "completed", result };
}

/**
 * Classify one ACP `update` object (the `params.update` of a `session/update`
 * notification). Pure and total — every input yields a classification, malformed
 * or unknown ones landing in `ignored` with a diagnostic reason rather than
 * throwing, so a single odd notification can never abort an ingestion stream.
 */
export function classifyUpdate(value: unknown): AcpClassifiedUpdate {
  if (!isRecord(value)) {
    return ignored("<none>", `update must be an object, got ${typeof value}`);
  }
  const sessionUpdate = value.sessionUpdate;
  if (typeof sessionUpdate !== "string") {
    return ignored("<none>", `update "sessionUpdate" must be a string, got ${typeof sessionUpdate}`);
  }
  if (sessionUpdate in CHUNK_ROLE) {
    return classifyChunk(value, sessionUpdate);
  }
  if (sessionUpdate === "tool_call") {
    return classifyToolCall(value);
  }
  if (sessionUpdate === "tool_call_update") {
    return classifyToolCallUpdate(value);
  }
  return ignored(sessionUpdate, `${sessionUpdate} is not a canonical mind event`);
}

/** One place where ACP is thinner than a native transcript (ADR 0062 §5). */
export interface AcpFidelityGap {
  /** The canonical concept that cannot be fully reconstructed from ACP alone. */
  readonly concept: string;
  /** Why ACP cannot carry it, and what a native transcript (slice 3) preserves. */
  readonly detail: string;
}

/**
 * The enumerated resume-fidelity gaps in the ACP backend — the documented reason
 * (ADR 0062 §5) the slice 3 native normaliser exists as a fallback path. This is
 * a derived source of truth: `normalize.test.ts` asserts the mapping above only
 * ever emits `assistant`/`reasoning`/`user`/`tool-call`/`tool-result`, so any
 * canonical event ACP *cannot* produce is accounted for here.
 */
export const ACP_FIDELITY_GAPS: readonly AcpFidelityGap[] = [
  {
    concept: "usage / token accounting (UsageEvent)",
    detail:
      "ACP's usage_update reports context-window occupancy ({ used, size, cost }), " +
      "not per-turn input/output token counts. It cannot reconstruct a canonical " +
      "UsageEvent's inputTokens/outputTokens, so usage is dropped rather than " +
      "mis-attributed; a native transcript carries the real accounting.",
  },
  {
    concept: "reasoning continuation (ReasoningEvent.providerContinuation)",
    detail:
      "ACP streams agent_thought_chunk text only. It has no field for a provider's " +
      "opaque encrypted reasoning-continuation blob, so a resumed incarnation cannot " +
      "resume the model's chain-of-thought exactly from an ACP transcript alone.",
  },
  {
    concept: "model identity (UsageEvent.model)",
    detail:
      "ACP does not attribute a session/update to a specific provider model id, so " +
      "the model a turn ran on is not recoverable from the ACP stream.",
  },
  {
    concept: "tool name vs. title (ToolCallEvent.name)",
    detail:
      "ACP's tool_call exposes a human-readable `title` and a `kind` category but no " +
      "stable machine tool name; the normaliser records `title` as the name, which is " +
      "a display string, not a canonical tool identifier.",
  },
  {
    concept: "compaction / truncation boundaries (CompactionEvent)",
    detail:
      "ACP has no notification for a context compaction or truncation, so a replayed " +
      "ACP history cannot mark the offset ranges a native transcript folds into a summary.",
  },
  {
    concept: "explicit turn boundaries (TurnStartEvent / TurnEndEvent)",
    detail:
      "ACP models a prompt's end via a state/stopReason on the session/prompt response, " +
      "not as numbered turn-start/turn-end markers in the update stream, so canonical " +
      "turn indices are not reconstructable from session/update notifications alone.",
  },
];
