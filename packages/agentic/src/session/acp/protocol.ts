/**
 * The ACP (Agent Client Protocol) wire vocabulary — ADR 0062, slice 2.
 *
 * This is the **harness-facing** half of the ACP ingestion backend: the JSON-RPC
 * method names, the protocol-version constant, and the small set of runtime
 * guards that turn the untyped JSON a harness sends over the wire into the typed
 * shapes {@link ./normalize.ts} and {@link ./client.ts} consume. Exactly like
 * `../events.ts`' `parseSessionEvent`, every guard *builds* a typed value field
 * by field and fails loudly on a malformed one — it never uses an `as`-cast to
 * fabricate a shape (AGENTS.md: the `as T` ban applies at every untyped boundary).
 *
 * The shapes mirror ACP **protocol version 1** — the version `opencode acp`
 * speaks and the one ADR 0062 §5 resolves as the preferred harness protocol.
 * Method names are verified against the canonical schema
 * (`zed-industries/agent-client-protocol`, `schema/v1/meta.json`) and confirmed
 * present in the opencode binary: `initialize`, `session/new|load|prompt|cancel`,
 * `session/update`.
 */

/** The ACP protocol version this client negotiates (integer, per the spec). */
export const ACP_PROTOCOL_VERSION = 1;

/** Agent-handled JSON-RPC methods (client → agent requests / notifications). */
export const ACP_METHOD = {
  initialize: "initialize",
  sessionNew: "session/new",
  sessionLoad: "session/load",
  sessionPrompt: "session/prompt",
  /** A notification — no response is expected. */
  sessionCancel: "session/cancel",
} as const;

/** Client-handled JSON-RPC methods (agent → client requests / notifications). */
export const ACP_CLIENT_METHOD = {
  /** Streamed session activity — a notification the agent pushes to the client. */
  sessionUpdate: "session/update",
  /** The agent asks the client to approve a tool call. */
  requestPermission: "session/request_permission",
} as const;

/** A JSON object with unknown-typed values — the raw wire shape before guarding. */
export type JsonRecord = Record<string, unknown>;

/** Narrow an unknown value to a plain (non-array) object. */
export function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The prompt-content capabilities an agent advertises (`agentCapabilities`
 * sub-object). All optional booleans, defaulting to `false` when absent.
 */
export interface AcpPromptCapabilities {
  readonly image: boolean;
  readonly audio: boolean;
  readonly embeddedContext: boolean;
}

/**
 * The subset of `agentCapabilities` this slice reads from the `initialize`
 * handshake. `loadSession` is the ADR 0062 §5 durable-resume probe; the rest is
 * retained verbatim in {@link AcpInitializeResult.rawAgentCapabilities} for
 * consumers that need more.
 */
export interface AcpAgentCapabilities {
  /** Whether the agent supports `session/load` — the durable-resume signal. */
  readonly loadSession: boolean;
  readonly promptCapabilities: AcpPromptCapabilities;
}

/** The negotiated result of an `initialize` handshake, guarded off the wire. */
export interface AcpInitializeResult {
  readonly protocolVersion: number;
  readonly agentCapabilities: AcpAgentCapabilities;
  /** The full, unmodified `agentCapabilities` object (opaque passthrough). */
  readonly rawAgentCapabilities: unknown;
}

function optBool(record: JsonRecord, field: string): boolean {
  return record[field] === true;
}

function readPromptCapabilities(value: unknown): AcpPromptCapabilities {
  if (!isRecord(value)) {
    return { image: false, audio: false, embeddedContext: false };
  }
  return {
    image: optBool(value, "image"),
    audio: optBool(value, "audio"),
    embeddedContext: optBool(value, "embeddedContext"),
  };
}

/** Raised when an ACP wire message is not the well-formed shape its method requires. */
export class AcpProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AcpProtocolError";
  }
}

/**
 * Parse an `initialize` result. The agent MAY answer with a lower
 * `protocolVersion` than requested (down-negotiation); we surface whatever it
 * reports and let the caller decide. A missing `agentCapabilities` is treated as
 * "no capabilities" (every flag `false`) rather than an error, matching the ACP
 * schema's `x-deserialize-default-on-error` default.
 */
export function parseInitializeResult(value: unknown): AcpInitializeResult {
  if (!isRecord(value)) {
    throw new AcpProtocolError(`initialize result must be an object, got ${typeof value}`);
  }
  const protocolVersion = value.protocolVersion;
  if (typeof protocolVersion !== "number" || !Number.isInteger(protocolVersion)) {
    throw new AcpProtocolError(
      `initialize result "protocolVersion" must be an integer, got ${String(protocolVersion)}`,
    );
  }
  const rawAgentCapabilities = value.agentCapabilities;
  const caps = isRecord(rawAgentCapabilities) ? rawAgentCapabilities : {};
  return {
    protocolVersion,
    agentCapabilities: {
      loadSession: optBool(caps, "loadSession"),
      promptCapabilities: readPromptCapabilities(caps.promptCapabilities),
    },
    rawAgentCapabilities,
  };
}

/**
 * Extract the session id from a `session/new` result (`{ sessionId }`).
 * `session/load` carries the id from the request and returns only session
 * metadata, so this guards the `session/new` case.
 */
export function parseSessionId(value: unknown): string {
  if (!isRecord(value)) {
    throw new AcpProtocolError(`session result must be an object, got ${typeof value}`);
  }
  const sessionId = value.sessionId;
  if (typeof sessionId !== "string" || sessionId.length === 0) {
    throw new AcpProtocolError(`session result "sessionId" must be a non-empty string`);
  }
  return sessionId;
}

/**
 * Flatten an ACP `ContentBlock` (or an array of them) to plain text — the only
 * projection the canonical `SessionEvent` model needs from a message/thought
 * chunk. A `text` block contributes its `text`; a `resource` block with embedded
 * text contributes that; every other block type (image/audio/resource_link)
 * contributes nothing. Returns `null` when no text could be recovered so the
 * caller can distinguish "empty text" from "no textual content at all".
 */
export function contentBlockText(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    const parts: string[] = [];
    for (const item of value) {
      const text = contentBlockText(item);
      if (text !== null) parts.push(text);
    }
    return parts.length > 0 ? parts.join("") : null;
  }
  if (!isRecord(value)) return null;
  const type = value.type;
  if (type === "text") {
    return typeof value.text === "string" ? value.text : null;
  }
  if (type === "resource") {
    const resource = value.resource;
    if (isRecord(resource) && typeof resource.text === "string") {
      return resource.text;
    }
    return null;
  }
  return null;
}
