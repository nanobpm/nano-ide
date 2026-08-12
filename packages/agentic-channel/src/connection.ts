/**
 * Transport-agnostic connection contracts.
 *
 * The hub owns connection lifecycle and framing; it speaks to the network only
 * through {@link ChannelTransport} / {@link ChannelConnection}. That keeps the
 * hub deterministically testable over an in-memory transport and lets the real
 * {@link WebSocketChannelTransport} (or any future transport) be a thin adapter.
 *
 * A connection carries opaque, already-encoded protocol frames as bytes — the
 * hub decodes them with the S0 codec (`@nanobpm/agentic-protocol`). This channel
 * is served by the app on its OWN bound port; the Camunda-8 engine transport is
 * a separate connection and is never touched here.
 */

/**
 * Everything the transport learns about a peer at connect time, BEFORE any
 * protocol frame is exchanged. The default authenticator reads the ADR 0028
 * identity token and the capability credential from here (mirroring the
 * `?token=…` pattern nano-workforce's blackboard hook already uses).
 */
export interface HandshakeRequest {
  /** ADR 0028 identity token (typically the `token` query param or a header). */
  readonly token?: string;
  /** Capability credential authorising the peer to enrol. */
  readonly credential?: string;
  /** Remote address, for logging/diagnostics only. */
  readonly remote?: string;
  /** Lower-cased request headers. */
  readonly headers?: Readonly<Record<string, string>>;
  /** Parsed query-string parameters. */
  readonly query?: Readonly<Record<string, string>>;
}

/** Close-status code (WebSocket application range 3000–4999 for our own codes). */
export type CloseCode = number;

/**
 * A single duplex connection to a peer. The hub registers exactly one message
 * and one close listener; a transport may deliver `pong` for keepalive.
 */
export interface ChannelConnection {
  /** Stable per-connection id (unique for the life of the process). */
  readonly id: string;
  /** What the transport captured about the peer at connect time. */
  readonly handshake: HandshakeRequest;
  /** Send one already-encoded frame as binary bytes. */
  send(bytes: Uint8Array): void;
  /** Close the connection with an optional application close code + reason. */
  close(code?: CloseCode, reason?: string): void;
  /** Register the (single) inbound-bytes listener. */
  onMessage(listener: (bytes: Uint8Array) => void): void;
  /** Register the (single) close listener. */
  onClose(listener: (code?: CloseCode, reason?: string) => void): void;
  /** Register a keepalive pong listener, if the transport supports ping/pong. */
  onPong?(listener: () => void): void;
  /** Send a keepalive ping, if the transport supports it. */
  ping?(): void;
}

/**
 * A listening transport, bound to the app's own port. It emits a
 * {@link ChannelConnection} for every accepted, upgraded peer.
 */
export interface ChannelTransport {
  /** Register the handler invoked for each newly accepted connection. */
  onConnection(listener: (conn: ChannelConnection) => void): void;
  /** The bound address once listening, or `null` before/after. */
  readonly address: { readonly port: number } | null;
  /** Stop accepting and release the port. */
  close(): Promise<void>;
}
