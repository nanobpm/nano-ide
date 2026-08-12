import type { FrameDecodeErrorCode } from "../frame.ts";

/**
 * Malformed frame vectors: adversarial byte sequences that MUST be rejected,
 * each paired with the exact {@link FrameDecodeErrorCode} the decoder must
 * raise. A shared prose spec does not stop divergence — shared adversarial
 * vectors do. Both this decoder and the c8ctl client are held to these.
 */
export interface MalformedFrame {
  readonly name: string;
  /** The raw bytes to feed the decoder, as a lowercase hex string (may be ""). */
  readonly hex: string;
  readonly expected: FrameDecodeErrorCode;
}

export const MALFORMED_FRAMES: readonly MalformedFrame[] = [
  { name: "empty-buffer", hex: "", expected: "empty" },
  { name: "short-header", hex: "4e410100", expected: "short-header" },
  {
    name: "bad-magic",
    hex: "ffff01000200000000000000177b22696e7374616e6365223a22772d616263313233227d",
    expected: "bad-magic",
  },
  {
    name: "unsupported-version",
    hex: "4e4102000200000000000000177b22696e7374616e6365223a22772d616263313233227d",
    expected: "unsupported-version",
  },
  {
    name: "unknown-lane",
    hex: "4e4101090200000000000000177b22696e7374616e6365223a22772d616263313233227d",
    expected: "unknown-lane",
  },
  {
    name: "unknown-family",
    hex: "4e4101006300000000000000177b22696e7374616e6365223a22772d616263313233227d",
    expected: "unknown-family",
  },
  {
    name: "truncated-payload",
    hex: "4e4101000200000000000000177b",
    expected: "truncated-payload",
  },
  {
    name: "trailing-bytes",
    hex: "4e4101000200000000000000177b22696e7374616e6365223a22772d616263313233227d00",
    expected: "trailing-bytes",
  },
  {
    name: "invalid-payload-json-nonjson",
    hex: "4e4101000200000000000000027a7a",
    expected: "invalid-payload-json",
  },
  {
    name: "invalid-payload-json-bad-utf8",
    hex: "4e410100020000000000000001ff",
    expected: "invalid-payload-json",
  },
];
