import {
  FAMILY_CODES,
  familyForCode,
  isMessageFamily,
  type MessageFamily,
} from "./families.ts";
import { LANE_CODES, laneForCode, isQosLane, type QosLane } from "./lanes.ts";

/**
 * A single agentic-channel frame: the QoS lane it rides, the message family it
 * belongs to, a monotonic sequence number (used by the relay for
 * resume-from-offset), and a JSON-serialisable family payload.
 *
 * The codec is an ENVELOPE codec — it does not interpret `payload` beyond
 * round-tripping it as JSON. Per-family payload shape is validated separately
 * (see `payloads.ts`).
 */
export interface Frame {
  readonly lane: QosLane;
  readonly family: MessageFamily;
  readonly seq: number;
  readonly payload: unknown;
}

/**
 * Wire layout (all integers big-endian, unsigned):
 *
 *   offset  size  field
 *   0       2     magic       0x4E41 ("NA")
 *   2       1     version     = 1
 *   3       1     lane code   0=control | 1=interactive | 2=bulk
 *   4       1     family code 1..9 (see FAMILY_CODES)
 *   5       4     seq         uint32
 *   9       4     payloadLen  uint32 (bytes of UTF-8 JSON that follow)
 *   13      N     payload     UTF-8 JSON
 */
export const FRAME_MAGIC = 0x4e41;
export const FRAME_VERSION = 1;
export const FRAME_HEADER_BYTES = 13;
export const MAX_SEQ = 0xffffffff;

export type FrameDecodeErrorCode =
  | "empty"
  | "short-header"
  | "bad-magic"
  | "unsupported-version"
  | "unknown-lane"
  | "unknown-family"
  | "truncated-payload"
  | "trailing-bytes"
  | "invalid-payload-json";

export class FrameDecodeError extends Error {
  readonly code: FrameDecodeErrorCode;
  constructor(code: FrameDecodeErrorCode, message: string) {
    super(message);
    this.name = "FrameDecodeError";
    this.code = code;
  }
}

export type FrameEncodeErrorCode =
  | "invalid-lane"
  | "invalid-family"
  | "invalid-seq"
  | "unserialisable-payload";

export class FrameEncodeError extends Error {
  readonly code: FrameEncodeErrorCode;
  constructor(code: FrameEncodeErrorCode, message: string) {
    super(message);
    this.name = "FrameEncodeError";
    this.code = code;
  }
}

export function encodeFrame(frame: Frame): Uint8Array {
  if (!isQosLane(frame.lane)) {
    throw new FrameEncodeError("invalid-lane", `unknown QoS lane: ${String(frame.lane)}`);
  }
  if (!isMessageFamily(frame.family)) {
    throw new FrameEncodeError("invalid-family", `unknown message family: ${String(frame.family)}`);
  }
  if (!Number.isInteger(frame.seq) || frame.seq < 0 || frame.seq > MAX_SEQ) {
    throw new FrameEncodeError("invalid-seq", `seq must be a uint32, got: ${String(frame.seq)}`);
  }

  // Encode `payload` as-is: a top-level `undefined` is NOT valid JSON
  // (`JSON.stringify(undefined) === undefined`), so it is rejected rather than
  // silently coerced to `null` — that keeps the codec invertible and surfaces a
  // caller that forgot to set a payload. A `null` payload is valid JSON and
  // round-trips.
  let json: string | undefined;
  try {
    json = JSON.stringify(frame.payload);
  } catch {
    json = undefined;
  }
  if (json === undefined) {
    throw new FrameEncodeError("unserialisable-payload", "payload is not JSON-serialisable");
  }

  const payloadBytes = new TextEncoder().encode(json);
  const out = new Uint8Array(FRAME_HEADER_BYTES + payloadBytes.length);
  const view = new DataView(out.buffer);
  view.setUint16(0, FRAME_MAGIC);
  view.setUint8(2, FRAME_VERSION);
  view.setUint8(3, LANE_CODES[frame.lane]);
  view.setUint8(4, FAMILY_CODES[frame.family]);
  view.setUint32(5, frame.seq);
  view.setUint32(9, payloadBytes.length);
  out.set(payloadBytes, FRAME_HEADER_BYTES);
  return out;
}

export function decodeFrame(bytes: Uint8Array): Frame {
  if (bytes.length === 0) {
    throw new FrameDecodeError("empty", "cannot decode an empty buffer");
  }
  if (bytes.length < FRAME_HEADER_BYTES) {
    throw new FrameDecodeError(
      "short-header",
      `need at least ${FRAME_HEADER_BYTES} header bytes, got ${bytes.length}`,
    );
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint16(0) !== FRAME_MAGIC) {
    throw new FrameDecodeError("bad-magic", "frame magic mismatch");
  }
  const version = view.getUint8(2);
  if (version !== FRAME_VERSION) {
    throw new FrameDecodeError("unsupported-version", `unsupported frame version: ${version}`);
  }

  const lane = laneForCode(view.getUint8(3));
  if (lane === undefined) {
    throw new FrameDecodeError("unknown-lane", `unknown lane code: ${view.getUint8(3)}`);
  }
  const family = familyForCode(view.getUint8(4));
  if (family === undefined) {
    throw new FrameDecodeError("unknown-family", `unknown family code: ${view.getUint8(4)}`);
  }

  const seq = view.getUint32(5);
  const payloadLen = view.getUint32(9);
  const end = FRAME_HEADER_BYTES + payloadLen;
  if (end > bytes.length) {
    throw new FrameDecodeError(
      "truncated-payload",
      `payload length ${payloadLen} exceeds available ${bytes.length - FRAME_HEADER_BYTES} bytes`,
    );
  }
  if (end < bytes.length) {
    throw new FrameDecodeError(
      "trailing-bytes",
      `${bytes.length - end} trailing byte(s) after payload`,
    );
  }

  const payloadBytes = bytes.subarray(FRAME_HEADER_BYTES, end);
  let payload: unknown;
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(payloadBytes);
    payload = JSON.parse(text);
  } catch {
    throw new FrameDecodeError("invalid-payload-json", "payload is not valid UTF-8 JSON");
  }

  return { lane, family, seq, payload };
}
