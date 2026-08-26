/**
 * Shared conformance corpus for the Nano agentic protocol.
 *
 * Exported so cross-repo tests (this repo AND jwulf/c8ctl-plugin-nano) consume
 * the SAME golden frames, malformed vectors, vocab documents and token vectors.
 * Import it and hold your codec/client to it:
 *
 *   import { GOLDEN_FRAMES, MALFORMED_FRAMES } from "./index.ts";
 */
export {
  GOLDEN_FRAMES,
  type GoldenFrame,
} from "./frames.ts";
export {
  MALFORMED_FRAMES,
  type MalformedFrame,
} from "./malformed.ts";
export {
  VALID_VOCABS,
  INVALID_VOCABS,
  type ValidVocab,
  type InvalidVocab,
} from "./vocab.ts";
export {
  VALID_TOKENS,
  INVALID_TOKENS,
  type ValidToken,
  type InvalidToken,
} from "./tokens.ts";
export {
  VALID_CONTROL_FRAMES,
  MALFORMED_CONTROL_FRAMES,
  type ValidControlFrame,
  type MalformedControlFrame,
} from "./control.ts";
