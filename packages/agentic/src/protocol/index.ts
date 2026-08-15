/**
 * @nanobpm/agentic/protocol — the wire contract for the Nano agentic protocol
 * (ADR 0056): one app-tier channel carrying agent presence/registry,
 * demand×supply, the blackboard and live terminal relay.
 *
 * This package is the single source of truth every other slice keys off:
 *  - the canonical message-family set ({@link MESSAGE_FAMILIES}),
 *  - the three QoS lanes ({@link QOS_LANES}),
 *  - the frame codec ({@link encodeFrame} / {@link decodeFrame}),
 *  - the routing-token grammar ({@link parseToken}),
 *  - the vocab-artifact schema ({@link validateVocabDocument}), and
 *  - per-family payload contracts ({@link validatePayload}).
 *
 * The shared conformance corpus is published at the
 * `@nanobpm/agentic/protocol/conformance` subpath.
 */
export {
  MESSAGE_FAMILIES,
  FAMILY_CODES,
  familyForCode,
  isMessageFamily,
  type MessageFamily,
} from "./families.ts";

export {
  QOS_LANES,
  LANE_CODES,
  laneForCode,
  lanePriority,
  isQosLane,
  compareFrameOrder,
  type QosLane,
} from "./lanes.ts";

export {
  encodeFrame,
  decodeFrame,
  FrameDecodeError,
  FrameEncodeError,
  FRAME_MAGIC,
  FRAME_VERSION,
  FRAME_HEADER_BYTES,
  MAX_SEQ,
  type Frame,
  type FrameDecodeErrorCode,
  type FrameEncodeErrorCode,
} from "./frame.ts";

export {
  parseToken,
  formatToken,
  isValidToken,
  isSegmentName,
  isSeatLabel,
  TokenParseError,
  type RoutingToken,
  type TokenParseErrorCode,
} from "./token.ts";

export {
  validateVocabDocument,
  type VocabDocument,
  type VocabNetwork,
  type VocabRole,
  type VocabError,
  type VocabValidationResult,
} from "./vocab/schema.ts";

export {
  validatePayload,
  type Capability,
  type RegisterPayload,
  type HeartbeatPayload,
  type DeregisterPayload,
  type ServePayload,
  type DemandPayload,
  type BlackboardPayload,
  type BlackboardOp,
  type RelayPayload,
  type RelayProducePayload,
  type RelaySubscribePayload,
  type RelayCreditPayload,
  type RelaySubscribedPayload,
  type PayloadError,
  type PayloadValidationResult,
} from "./payloads.ts";

export { bytesToHex, hexToBytes } from "./hex.ts";
