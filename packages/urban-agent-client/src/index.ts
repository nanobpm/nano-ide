/**
 * `@nanobpm/urban-agent-client` — the worker-side client for the Nano agentic
 * channel (ADR 0056, slice S9).
 *
 * A worker uses it on a connection SEPARATE from the C8 job protocol to:
 *  - `REGISTER` a capability and receive its resolved `SERVE` tokens,
 *  - `heartbeat` / `deregister` for presence & liveness,
 *  - produce `relay` bytes (live terminal / command-stream output), and
 *  - keep producing across a hub outage — everything is buffered in a bounded,
 *    QoS-aware {@link OutboundRing} and drained, control-before-bulk, on
 *    reconnect (hub-down tolerance, invariant #6).
 *
 * The wire contract itself is owned by `@nanobpm/agentic/protocol` (S0); this
 * package imports and is held to it (including its shared conformance corpus),
 * never redefining it.
 *
 * @example
 * ```ts
 * import { connectAgenticChannel } from "@nanobpm/urban-agent-client";
 *
 * const agent = connectAgenticChannel({ url: process.env.AGENTIC_CHANNEL_URL! });
 * const { serve } = await agent.register({
 *   capability: { cognition: "high", weight: 3, family: "opus", host: "cli" },
 * });
 * agent.heartbeat();
 * agent.relay("stdout", "hello\n");
 * // …later…
 * agent.deregister("done");
 * ```
 */

export {
  AgenticClient,
  connectAgenticChannel,
  isMessageFamily,
} from "./client.ts";
export type {
  AgenticClientOptions,
  AgenticClientState,
  ReconnectOptions,
  RegisterResult,
} from "./client.ts";

export { OutboundRing, compareFrameOrder } from "./ring.ts";
export type { EnqueueResult, OutboundRingOptions } from "./ring.ts";

export { websocketTransport, normaliseIncoming } from "./transport.ts";
export type {
  Transport,
  TransportCloseInfo,
  TransportFactory,
  TransportHooks,
} from "./transport.ts";

// Re-export the S0 contract surface a worker needs so consumers can build and
// inspect frames without a second dependency line. Sourced from
// @nanobpm/agentic/protocol (the single source of truth).
export {
  MESSAGE_FAMILIES,
  QOS_LANES,
  encodeFrame,
  decodeFrame,
  parseToken,
  isValidToken,
  validatePayload,
} from "./protocol.ts";
export type {
  Capability,
  Frame,
  MessageFamily,
  QosLane,
  RegisterPayload,
  HeartbeatPayload,
  DeregisterPayload,
  ServePayload,
  RelayPayload,
  RelayProducePayload,
} from "./protocol.ts";
