/**
 * Typed INBOUND control vocabulary for the `relay` family (ADR 0056, ACP steer).
 *
 * The relay data frame ({@link RelayPayload} `{ stream, offset, chunk }`) is the
 * OUTBOUND (hub → consumer) byte lane and is left untouched. This module adds an
 * ADDITIVE vocabulary for the INBOUND (consumer → agent) steer lane, where a
 * peer historically sent a bare `chunk` string that a PTY role fed straight to
 * the terminal as keystrokes. ACP steering must now distinguish three intents:
 *
 *  - `prompt`     — start a new turn (carries the prompt text);
 *  - `cancel`     — interrupt the current turn (optionally with a reason);
 *  - `permission` — answer/release a blocked `session/request_permission`
 *                   (carries the request id being answered + the outcome).
 *
 * ## Backward compatibility (raw-byte steer)
 *
 * The vocabulary is a STRICT superset of the legacy raw-byte path. A structured
 * frame is a JSON envelope TAGGED with {@link CONTROL_FRAME_MARKER}; a bare
 * inbound string that is NOT such a tagged envelope (a keystroke, a shell line,
 * unrelated JSON) continues to decode as a `prompt` whose `text` is the original
 * chunk verbatim. Existing raw-byte producers and consumers need not change.
 *
 * ## Decode order (see {@link parseInboundRelayChunk})
 *
 *  1. If the chunk parses as a control envelope (a JSON object tagged with the
 *     marker at the current version) → validate it and return the typed frame;
 *     a tagged-but-malformed envelope is an ERROR, never a silent prompt.
 *  2. Otherwise → legacy fall-back: `{ kind: "prompt", text: <chunk> }`.
 *
 * This is purely the inbound control vocabulary at the protocol seam: it changes
 * neither the relay transport (ring, QoS, offsets, stream routing) nor the
 * outbound `{ stream, offset, chunk }` data-frame shape.
 */

/**
 * The marker key that tags a chunk as a structured inbound control envelope.
 * Its value is the {@link CONTROL_FRAME_VERSION}. A chunk without this key is a
 * legacy bare-string steer and decodes as a `prompt`.
 */
export const CONTROL_FRAME_MARKER = "nanoControlFrame" as const;

/** The schema version carried by the {@link CONTROL_FRAME_MARKER}. */
export const CONTROL_FRAME_VERSION = 1 as const;

/** The three inbound steer intents. */
export type InboundControlKind = "prompt" | "cancel" | "permission";

/** How a blocked `session/request_permission` was answered. */
export type PermissionOutcome = "granted" | "denied";

/** Start a new turn with the given prompt text. */
export interface PromptControlFrame {
  readonly kind: "prompt";
  readonly text: string;
}

/** Interrupt the current turn. `reason` is advisory, for telemetry/audit. */
export interface CancelControlFrame {
  readonly kind: "cancel";
  readonly reason?: string;
}

/** Answer a blocked `session/request_permission` identified by `requestId`. */
export interface PermissionControlFrame {
  readonly kind: "permission";
  readonly requestId: string;
  readonly outcome: PermissionOutcome;
}

/** The typed inbound control vocabulary — a discriminated union on `kind`. */
export type InboundControlFrame =
  | PromptControlFrame
  | CancelControlFrame
  | PermissionControlFrame;

export interface InboundControlError {
  readonly code: InboundControlErrorCode;
  readonly message: string;
}

/**
 * The closed set of validation-error codes a tagged-but-malformed control
 * envelope can raise. The conformance corpus derives its coverage from this
 * union, so a new code cannot be added without a covering malformed vector.
 */
export type InboundControlErrorCode =
  | "bad-kind"
  | "bad-prompt-text"
  | "bad-cancel-reason"
  | "bad-permission-request-id"
  | "bad-permission-outcome";

/**
 * The result of decoding an inbound steer chunk. `structured` distinguishes a
 * recognised control envelope from the legacy bare-string-as-prompt fall-back,
 * so a consumer can tell an explicit `prompt` frame from a raw keystroke.
 */
export type InboundControlDecodeResult =
  | { readonly ok: true; readonly frame: InboundControlFrame; readonly structured: boolean }
  | { readonly ok: false; readonly errors: readonly InboundControlError[] };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Is `value` a structured inbound control envelope (a plain object tagged with
 * the marker at the current version)? This is the discriminator the decoder uses
 * to choose the structured path over the legacy bare-string fall-back — it does
 * NOT assert the envelope's `kind`-specific fields are well-formed.
 */
export function isInboundControlEnvelope(value: unknown): value is Record<string, unknown> {
  return isPlainObject(value) && value[CONTROL_FRAME_MARKER] === CONTROL_FRAME_VERSION;
}

function validateEnvelope(env: Record<string, unknown>): InboundControlDecodeResult {
  const errors: InboundControlError[] = [];
  const kind = env.kind;
  switch (kind) {
    case "prompt": {
      if (typeof env.text !== "string") {
        errors.push({ code: "bad-prompt-text", message: "control.prompt.text must be a string" });
      }
      if (errors.length > 0) return { ok: false, errors };
      return { ok: true, structured: true, frame: { kind: "prompt", text: env.text as string } };
    }
    case "cancel": {
      if ("reason" in env && typeof env.reason !== "string") {
        errors.push({ code: "bad-cancel-reason", message: "control.cancel.reason must be a string when present" });
      }
      if (errors.length > 0) return { ok: false, errors };
      const frame: CancelControlFrame =
        typeof env.reason === "string" ? { kind: "cancel", reason: env.reason } : { kind: "cancel" };
      return { ok: true, structured: true, frame };
    }
    case "permission": {
      if (typeof env.requestId !== "string" || env.requestId.length === 0) {
        errors.push({
          code: "bad-permission-request-id",
          message: "control.permission.requestId must be a non-empty string",
        });
      }
      if (env.outcome !== "granted" && env.outcome !== "denied") {
        errors.push({
          code: "bad-permission-outcome",
          message: "control.permission.outcome must be 'granted' or 'denied'",
        });
      }
      if (errors.length > 0) return { ok: false, errors };
      return {
        ok: true,
        structured: true,
        frame: {
          kind: "permission",
          requestId: env.requestId as string,
          outcome: env.outcome as PermissionOutcome,
        },
      };
    }
    default: {
      const seen = kind === undefined ? "<missing>" : JSON.stringify(kind);
      return {
        ok: false,
        errors: [
          {
            code: "bad-kind",
            message: `control.kind must be one of prompt|cancel|permission, got ${seen}`,
          },
        ],
      };
    }
  }
}

/**
 * Decode a raw inbound steer chunk into a typed {@link InboundControlFrame}.
 *
 * A chunk tagged as a control envelope is validated and returned as its typed
 * frame (`structured: true`); a tagged-but-malformed envelope (bad/missing
 * discriminant, missing/ill-typed field) is a validation ERROR. Any other chunk
 * — a bare keystroke, a shell line, unrelated JSON — is treated as the legacy
 * raw-byte steer and returned as a `prompt` whose `text` is the chunk verbatim
 * (`structured: false`). See the module header for the full decode order.
 */
export function parseInboundRelayChunk(chunk: string): InboundControlDecodeResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(chunk);
  } catch {
    // Not JSON at all — a raw keystroke/line. Legacy bare-string prompt.
    return { ok: true, structured: false, frame: { kind: "prompt", text: chunk } };
  }
  if (!isInboundControlEnvelope(parsed)) {
    // Valid JSON but not a control envelope (unrelated JSON, or a plain string
    // like "ls\n"): still a legacy bare-string prompt carrying the chunk as-is.
    return { ok: true, structured: false, frame: { kind: "prompt", text: chunk } };
  }
  return validateEnvelope(parsed);
}

/**
 * Encode a typed {@link InboundControlFrame} as its canonical wire chunk — a
 * JSON envelope tagged with {@link CONTROL_FRAME_MARKER}. The result round-trips
 * back through {@link parseInboundRelayChunk} to an equal frame.
 */
export function encodeInboundControlFrame(frame: InboundControlFrame): string {
  const marker = { [CONTROL_FRAME_MARKER]: CONTROL_FRAME_VERSION } as const;
  switch (frame.kind) {
    case "prompt":
      return JSON.stringify({ ...marker, kind: "prompt", text: frame.text });
    case "cancel":
      return JSON.stringify(
        frame.reason === undefined
          ? { ...marker, kind: "cancel" }
          : { ...marker, kind: "cancel", reason: frame.reason },
      );
    case "permission":
      return JSON.stringify({
        ...marker,
        kind: "permission",
        requestId: frame.requestId,
        outcome: frame.outcome,
      });
  }
}
