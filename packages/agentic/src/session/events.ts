/**
 * The canonical `SessionEvent` model — ADR 0062, slice 1 (the shared contract).
 *
 * This is **Nano's own** agent-session event model: the single schema every
 * harness dialect (ACP, stream-json, a native normalizer, …) normalizes *into*.
 * We never adopt an external harness schema as ours — those are ingestion
 * details owned by the later slices; this union is the stable interface they all
 * target.
 *
 * ## The causal chain
 *
 * A session is an append-only log of events. Two orthogonal orderings make the
 * log both replayable and mergeable:
 *
 *  - a **monotonic, gap-free `offset`** assigned by the authoritative log on
 *    append (see {@link AppendedSessionEvent}); it is the resume coordinate —
 *    `restore` hands back everything up to a checkpoint offset.
 *  - a **causal `parentId`** the producer stamps: the id of the event this one
 *    logically follows (`null` for the first event of a session). Offset gives a
 *    total order for replay; `parentId` records the *causal* edge, which survives
 *    a compaction that rewrites offsets.
 *
 * The producer owns identity (`id`) and causality (`parentId`); the log owns
 * ordering (`offset`) and fencing (`incarnation`). Keeping those responsibilities
 * split is what lets a resumed incarnation continue the same causal chain at a
 * fresh offset without the producer knowing the log's internal cursor.
 */

/** Discriminates a {@link SessionEvent}. One member per row in the union below. */
export type SessionEventType =
  | "system"
  | "user"
  | "assistant"
  | "reasoning"
  | "tool-call"
  | "tool-result"
  | "compaction"
  | "usage"
  | "turn-start"
  | "turn-end";

/** The set of valid event types, for a runtime membership check at the DB boundary. */
export const SESSION_EVENT_TYPES: readonly SessionEventType[] = [
  "system",
  "user",
  "assistant",
  "reasoning",
  "tool-call",
  "tool-result",
  "compaction",
  "usage",
  "turn-start",
  "turn-end",
];

/**
 * The fields every event carries regardless of type. `offset` is deliberately
 * absent — the producer does not assign it; the authoritative log does, yielding
 * an {@link AppendedSessionEvent}.
 */
export interface SessionEventEnvelope {
  /** Producer-assigned unique id for this event (the causal-chain node id). */
  readonly id: string;
  /** The id of the causal predecessor, or `null` for the first event of a session. */
  readonly parentId: string | null;
}

/** A system/instruction message (the harness/system prompt turn). */
export interface SystemMessageEvent extends SessionEventEnvelope {
  readonly type: "system";
  readonly text: string;
}

/** A user message. */
export interface UserMessageEvent extends SessionEventEnvelope {
  readonly type: "user";
  readonly text: string;
}

/** An assistant (model) message — the visible answer text. */
export interface AssistantMessageEvent extends SessionEventEnvelope {
  readonly type: "assistant";
  readonly text: string;
}

/**
 * Assistant reasoning (chain-of-thought / thinking) for a turn.
 *
 * `text` is the human-readable reasoning summary when the provider exposes one.
 * `providerContinuation` is an **opaque provider reasoning-continuation blob**:
 * some providers (e.g. encrypted reasoning tokens) return a handle that must be
 * fed back verbatim to continue reasoning across a resume. Nano never parses,
 * validates, or transforms it — it stores and replays it as an opaque string so
 * a re-leased incarnation can resume the model's reasoning exactly.
 */
export interface ReasoningEvent extends SessionEventEnvelope {
  readonly type: "reasoning";
  readonly text?: string;
  readonly providerContinuation?: string;
}

/** A tool/function call the assistant requested. */
export interface ToolCallEvent extends SessionEventEnvelope {
  readonly type: "tool-call";
  /** Correlates this call with its {@link ToolResultEvent}. */
  readonly callId: string;
  readonly name: string;
  /** The call arguments, as an opaque JSON-serialisable value. */
  readonly args: unknown;
}

/** The result of a previously-emitted {@link ToolCallEvent}. */
export interface ToolResultEvent extends SessionEventEnvelope {
  readonly type: "tool-result";
  /** Matches the originating {@link ToolCallEvent.callId}. */
  readonly callId: string;
  /** `false` when the tool failed; the failure detail lives in `result`. */
  readonly ok: boolean;
  /** The tool output, as an opaque JSON-serialisable value. */
  readonly result: unknown;
}

/**
 * A compaction or truncation boundary: the events in the (inclusive-exclusive)
 * offset range `[replacesFrom, replacesTo)` were summarised/dropped to bound
 * context growth. `summary` is the replacement text (present for compaction,
 * typically absent for a hard truncation). The original events keep their
 * offsets in the authoritative log; this marker records that a *replay* should
 * fold that range into the summary rather than replaying it verbatim.
 */
export interface CompactionEvent extends SessionEventEnvelope {
  readonly type: "compaction";
  readonly reason: "compaction" | "truncation";
  readonly replacesFrom: number;
  readonly replacesTo: number;
  readonly summary?: string;
}

/** A usage/accounting record for a turn (token counts, etc.). */
export interface UsageEvent extends SessionEventEnvelope {
  readonly type: "usage";
  readonly inputTokens: number;
  readonly outputTokens: number;
  /** Optional provider model identifier the usage is attributed to. */
  readonly model?: string;
}

/** The start of a turn (a request/response cycle). `turn` is a monotonic index. */
export interface TurnStartEvent extends SessionEventEnvelope {
  readonly type: "turn-start";
  readonly turn: number;
}

/** The end of a turn matching a prior {@link TurnStartEvent}. */
export interface TurnEndEvent extends SessionEventEnvelope {
  readonly type: "turn-end";
  readonly turn: number;
}

/**
 * The canonical session event — a discriminated union over {@link SessionEventType}.
 * Every harness dialect normalises into exactly this shape.
 */
export type SessionEvent =
  | SystemMessageEvent
  | UserMessageEvent
  | AssistantMessageEvent
  | ReasoningEvent
  | ToolCallEvent
  | ToolResultEvent
  | CompactionEvent
  | UsageEvent
  | TurnStartEvent
  | TurnEndEvent;

/**
 * A {@link SessionEvent} after the authoritative log has appended it: the same
 * event plus the log-assigned `offset` (its monotonic resume coordinate) and the
 * `incarnation` (the generation of the writer that produced it — the fencing
 * stamp). This is what {@link restore} replays as the mind seed.
 */
export type AppendedSessionEvent = SessionEvent & {
  readonly offset: number;
  readonly incarnation: number;
};

/** Raised when a value read back from storage is not a well-formed session event. */
export class SessionEventShapeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SessionEventShapeError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function reqString(obj: Record<string, unknown>, field: string): string {
  const v = obj[field];
  if (typeof v !== "string") {
    throw new SessionEventShapeError(`session event field "${field}" must be a string, got ${typeof v}`);
  }
  return v;
}

function optString(obj: Record<string, unknown>, field: string): string | undefined {
  const v = obj[field];
  if (v === undefined) return undefined;
  if (typeof v !== "string") {
    throw new SessionEventShapeError(`session event field "${field}" must be a string when present, got ${typeof v}`);
  }
  return v;
}

function reqNonNegInt(obj: Record<string, unknown>, field: string): number {
  const v = obj[field];
  if (typeof v !== "number" || !Number.isSafeInteger(v) || v < 0) {
    throw new SessionEventShapeError(
      `session event field "${field}" must be a non-negative safe integer, got ${String(v)}`,
    );
  }
  return v;
}

function reqBool(obj: Record<string, unknown>, field: string): boolean {
  const v = obj[field];
  if (typeof v !== "boolean") {
    throw new SessionEventShapeError(`session event field "${field}" must be a boolean, got ${typeof v}`);
  }
  return v;
}

function parentId(obj: Record<string, unknown>): string | null {
  const v = obj.parentId;
  if (v === null) return null;
  if (typeof v === "string") return v;
  throw new SessionEventShapeError(`session event "parentId" must be a string or null, got ${typeof v}`);
}

/**
 * Coerce a required opaque payload (a tool-call `args` / tool-result `result`) to
 * a JSON-serialisable value. These fields are documented as opaque *JSON-
 * serialisable* values, but a dialect can legitimately omit them (e.g. a tool
 * call with no arguments surfaces as `obj.arguments ?? obj.args === undefined`).
 * `undefined` is not JSON-serialisable — `JSON.stringify` drops the key — so an
 * un-normalised `undefined` would persist an event that no longer round-trips to
 * the same shape on replay. We normalise the absence to the canonical JSON "no
 * value" (`null`) here, at the single boundary every dialect flows through, so
 * they all get the same replay-stable guarantee (derivation over duplication).
 */
function opaquePayload(value: unknown): unknown {
  return value === undefined ? null : value;
}

/**
 * Parse and validate an untyped value (e.g. `JSON.parse` of a stored row) into a
 * {@link SessionEvent}, reconstructing the exact union member for its `type`.
 * Throws {@link SessionEventShapeError} on any malformed field. This is the
 * single trusted boundary between untyped storage and the typed union — it never
 * uses an `as`-cast to fabricate a shape (see AGENTS.md), it *builds* one field
 * by field, so a corrupt row fails loudly instead of masquerading as valid.
 */
export function parseSessionEvent(value: unknown): SessionEvent {
  if (!isRecord(value)) {
    throw new SessionEventShapeError(`session event must be an object, got ${typeof value}`);
  }
  const id = reqString(value, "id");
  const parent = parentId(value);
  const type = value.type;
  switch (type) {
    case "system":
      return { type, id, parentId: parent, text: reqString(value, "text") };
    case "user":
      return { type, id, parentId: parent, text: reqString(value, "text") };
    case "assistant":
      return { type, id, parentId: parent, text: reqString(value, "text") };
    case "reasoning": {
      const event: ReasoningEvent = { type, id, parentId: parent };
      const text = optString(value, "text");
      const cont = optString(value, "providerContinuation");
      return {
        ...event,
        ...(text !== undefined ? { text } : {}),
        ...(cont !== undefined ? { providerContinuation: cont } : {}),
      };
    }
    case "tool-call":
      return {
        type,
        id,
        parentId: parent,
        callId: reqString(value, "callId"),
        name: reqString(value, "name"),
        args: opaquePayload(value.args),
      };
    case "tool-result":
      return {
        type,
        id,
        parentId: parent,
        callId: reqString(value, "callId"),
        ok: reqBool(value, "ok"),
        result: opaquePayload(value.result),
      };
    case "compaction": {
      const reason = value.reason;
      if (reason !== "compaction" && reason !== "truncation") {
        throw new SessionEventShapeError(`compaction "reason" must be "compaction" or "truncation", got ${String(reason)}`);
      }
      const summary = optString(value, "summary");
      const replacesFrom = reqNonNegInt(value, "replacesFrom");
      const replacesTo = reqNonNegInt(value, "replacesTo");
      if (replacesTo < replacesFrom) {
        throw new SessionEventShapeError(
          `compaction "replacesTo" (${replacesTo}) must be >= "replacesFrom" (${replacesFrom})`,
        );
      }
      return {
        type,
        id,
        parentId: parent,
        reason,
        replacesFrom,
        replacesTo,
        ...(summary !== undefined ? { summary } : {}),
      };
    }
    case "usage": {
      const model = optString(value, "model");
      return {
        type,
        id,
        parentId: parent,
        inputTokens: reqNonNegInt(value, "inputTokens"),
        outputTokens: reqNonNegInt(value, "outputTokens"),
        ...(model !== undefined ? { model } : {}),
      };
    }
    case "turn-start":
      return { type, id, parentId: parent, turn: reqNonNegInt(value, "turn") };
    case "turn-end":
      return { type, id, parentId: parent, turn: reqNonNegInt(value, "turn") };
    default:
      throw new SessionEventShapeError(`unknown session event type: ${JSON.stringify(type)}`);
  }
}
