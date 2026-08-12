/**
 * Single import point for the S0 wire contract.
 *
 * We import from the package's `./source` export (raw `.ts`) rather than the
 * bare entry (`dist`) on purpose: the CI `conformance` job runs
 * `npm run test:conformance` with **no build step**, so every module this client
 * touches must be runnable straight from source under
 * `node --experimental-strip-types`. The Urban stack ships source `.ts` and runs
 * under strip-types (ADR 0052/0053), so a published consumer resolves the same
 * source. Keeping the import in one module gives a single swap point.
 *
 * The contract itself is owned by `@nanobpm/agentic/protocol` (S0, #126) — this
 * client imports it, it never redefines it.
 */
export {
  MESSAGE_FAMILIES,
  isMessageFamily,
  QOS_LANES,
  isQosLane,
  compareFrameOrder,
  encodeFrame,
  decodeFrame,
  FrameDecodeError,
  FrameEncodeError,
  MAX_SEQ,
  parseToken,
  isValidToken,
  validatePayload,
  bytesToHex,
  hexToBytes,
} from "@nanobpm/agentic/source/protocol";

export type {
  MessageFamily,
  QosLane,
  Frame,
  FrameDecodeErrorCode,
  Capability,
  RegisterPayload,
  HeartbeatPayload,
  DeregisterPayload,
  ServePayload,
  RelayPayload,
  BlackboardPayload,
  DemandPayload,
} from "@nanobpm/agentic/source/protocol";
