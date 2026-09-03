/**
 * @nanobpm/agentic/emit — the blessed client-side ownership/presence EMIT client.
 *
 * The emit-side counterpart of the S2/ownership protocol keystone: one
 * multiplexed host connection that N instances share, emitting `register` /
 * `heartbeat` / `deregister` / `claim` / `release` and the `relay` transcript
 * sink with an EXPLICIT `instance` per frame, with reconnect resync and additive
 * version negotiation. This is the single blessed emitter a supervisor builds a
 * concrete `AgenticEndpoint` on — no hand-rolled parallel client-ownership layer.
 *
 * The wire contract lives in `@nanobpm/agentic/protocol`; this client builds on
 * it (frame codec, per-family payload shapes, capability negotiation) so there
 * is no cross-package drift between the frame definitions and their emitter.
 */
export {
  AgenticEmitClient,
  composeStreamId,
} from "./emit-client.ts";
export type {
  AgenticEmitClientOptions,
  EmitSocket,
  EmitSocketFactory,
  Scheduler,
  TranscriptRef,
} from "./emit-client.ts";
