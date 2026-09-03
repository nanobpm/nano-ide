/**
 * @nanobpm/agentic/client — the blessed client-side ownership-frame emit client.
 *
 * The emit-side counterpart to the protocol keystone: one multiplexed host
 * connection that N instances share, emitting `register`/`heartbeat`/
 * `deregister`, `claim`/`release`, and per-instance `transcript` frames — each
 * carrying `instance` explicitly, never inferred from the connection id — with
 * automatic reconnect resync and additive version negotiation.
 *
 * Co-located with the frame definitions it emits (`../protocol`) so there is a
 * single source of truth for the wire contract and no cross-package drift.
 */
export {
  AgenticEmitClient,
  transcriptStreamKey,
  TRANSCRIPT_STREAM_SEPARATOR,
} from "./emit-client.ts";
export type {
  AgenticEmitClientOptions,
  HostSocket,
  HostSocketFactory,
  ResyncScheduler,
} from "./emit-client.ts";
