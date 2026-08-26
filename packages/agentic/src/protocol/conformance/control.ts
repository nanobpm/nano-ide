import {
  CONTROL_FRAME_MARKER,
  CONTROL_FRAME_VERSION,
  type InboundControlErrorCode,
  type InboundControlFrame,
} from "../control.ts";

/**
 * Shared corpus for the INBOUND control vocabulary (steer-in). These vectors are
 * exported so cross-repo consumers (the c8ctl harness) decode the SAME frames.
 *
 * `chunk` is the raw inbound steer string a peer sends; `frame` is the typed
 * {@link InboundControlFrame} it must decode to; `structured` records whether it
 * is a recognised control envelope (`true`) or the legacy bare-string-as-prompt
 * fall-back (`false`). A `roundTrips: false` vector decodes to `frame` but does
 * NOT re-encode to the same `chunk` (a legacy bare string, or an envelope with
 * extra tolerated fields), so the round-trip test skips re-encoding it.
 */
export interface ValidControlFrame {
  readonly name: string;
  readonly chunk: string;
  readonly frame: InboundControlFrame;
  readonly structured: boolean;
  readonly roundTrips: boolean;
}

const MARKER = { [CONTROL_FRAME_MARKER]: CONTROL_FRAME_VERSION };

export const VALID_CONTROL_FRAMES: readonly ValidControlFrame[] = [
  {
    name: "prompt-structured",
    chunk: JSON.stringify({ ...MARKER, kind: "prompt", text: "run the tests" }),
    frame: { kind: "prompt", text: "run the tests" },
    structured: true,
    roundTrips: true,
  },
  {
    name: "prompt-structured-empty-text",
    chunk: JSON.stringify({ ...MARKER, kind: "prompt", text: "" }),
    frame: { kind: "prompt", text: "" },
    structured: true,
    roundTrips: true,
  },
  {
    name: "cancel-structured",
    chunk: JSON.stringify({ ...MARKER, kind: "cancel" }),
    frame: { kind: "cancel" },
    structured: true,
    roundTrips: true,
  },
  {
    name: "cancel-structured-with-reason",
    chunk: JSON.stringify({ ...MARKER, kind: "cancel", reason: "operator interrupt" }),
    frame: { kind: "cancel", reason: "operator interrupt" },
    structured: true,
    roundTrips: true,
  },
  {
    name: "permission-granted",
    chunk: JSON.stringify({ ...MARKER, kind: "permission", requestId: "req-7", outcome: "granted" }),
    frame: { kind: "permission", requestId: "req-7", outcome: "granted" },
    structured: true,
    roundTrips: true,
  },
  {
    name: "permission-denied",
    chunk: JSON.stringify({ ...MARKER, kind: "permission", requestId: "req-8", outcome: "denied" }),
    frame: { kind: "permission", requestId: "req-8", outcome: "denied" },
    structured: true,
    roundTrips: true,
  },
  // Legacy raw-byte steer: a bare keystroke/line is NOT a control envelope and
  // must decode as a prompt carrying the chunk verbatim — the no-regression path.
  {
    name: "legacy-keystroke-line",
    chunk: "ls -la\n",
    frame: { kind: "prompt", text: "ls -la\n" },
    structured: false,
    roundTrips: false,
  },
  {
    name: "legacy-control-c",
    chunk: "\u0003",
    frame: { kind: "prompt", text: "\u0003" },
    structured: false,
    roundTrips: false,
  },
  {
    name: "legacy-json-number-is-not-a-frame",
    chunk: "42",
    frame: { kind: "prompt", text: "42" },
    structured: false,
    roundTrips: false,
  },
  {
    name: "legacy-untagged-json-object",
    chunk: JSON.stringify({ kind: "prompt", text: "not tagged" }),
    frame: { kind: "prompt", text: JSON.stringify({ kind: "prompt", text: "not tagged" }) },
    structured: false,
    roundTrips: false,
  },
];

/**
 * Adversarial inbound control vectors: a chunk TAGGED as a control envelope but
 * malformed. Each MUST be rejected with the exact {@link InboundControlErrorCode}.
 * A missing tag is NOT here — an untagged chunk is a valid legacy prompt (see
 * {@link VALID_CONTROL_FRAMES}), never an error.
 */
export interface MalformedControlFrame {
  readonly name: string;
  readonly chunk: string;
  readonly expected: InboundControlErrorCode;
}

export const MALFORMED_CONTROL_FRAMES: readonly MalformedControlFrame[] = [
  {
    name: "tagged-missing-kind",
    chunk: JSON.stringify({ ...MARKER, text: "no kind" }),
    expected: "bad-kind",
  },
  {
    name: "tagged-unknown-kind",
    chunk: JSON.stringify({ ...MARKER, kind: "explode" }),
    expected: "bad-kind",
  },
  {
    name: "prompt-missing-text",
    chunk: JSON.stringify({ ...MARKER, kind: "prompt" }),
    expected: "bad-prompt-text",
  },
  {
    name: "prompt-non-string-text",
    chunk: JSON.stringify({ ...MARKER, kind: "prompt", text: 123 }),
    expected: "bad-prompt-text",
  },
  {
    name: "cancel-non-string-reason",
    chunk: JSON.stringify({ ...MARKER, kind: "cancel", reason: 5 }),
    expected: "bad-cancel-reason",
  },
  {
    name: "permission-missing-request-id",
    chunk: JSON.stringify({ ...MARKER, kind: "permission", outcome: "granted" }),
    expected: "bad-permission-request-id",
  },
  {
    name: "permission-bad-outcome",
    chunk: JSON.stringify({ ...MARKER, kind: "permission", requestId: "req-9", outcome: "maybe" }),
    expected: "bad-permission-outcome",
  },
];
