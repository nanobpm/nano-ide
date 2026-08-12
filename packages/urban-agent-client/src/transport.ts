/**
 * The transport seam. The client is written against a minimal, injectable
 * transport so it can be exercised without a live hub (hub-down tolerance is a
 * first-class, unit-tested property) and so a host can supply any framing
 * (a real WebSocket, an in-process pipe, a test double).
 *
 * A transport carries WHOLE encoded frames as binary messages — one
 * {@link Uint8Array} in, one {@link Uint8Array} out. It never interprets the
 * bytes; the client owns encode/decode via the S0 codec.
 */

export interface TransportHooks {
  /** The channel is open and ready to send. */
  onOpen(): void;
  /** One binary frame arrived from the hub. */
  onFrame(bytes: Uint8Array): void;
  /** The channel closed (cleanly or otherwise). */
  onClose(info: TransportCloseInfo): void;
  /** A transport-level error occurred. Non-fatal on its own; a close follows. */
  onError(error: Error): void;
}

export interface TransportCloseInfo {
  readonly code?: number;
  readonly reason?: string;
  /** True when the close was requested by the client (a deregister / shutdown). */
  readonly local?: boolean;
}

export interface Transport {
  /**
   * Send one encoded frame. Implementations MUST throw synchronously if the
   * channel is not open, so the client can re-buffer the frame and stop
   * draining until the next reconnect.
   */
  send(bytes: Uint8Array): void;
  /** Close the channel. Idempotent. */
  close(code?: number, reason?: string): void;
}

/**
 * Builds a transport for a URL, wiring the hub's events into `hooks`. Called
 * once per connection attempt (a reconnect calls it again).
 */
export type TransportFactory = (url: string, hooks: TransportHooks) => Transport;

/**
 * The default transport: a binary WebSocket over the app's bound port. Each
 * agentic frame is one WebSocket binary message. Incoming messages are
 * normalised to {@link Uint8Array} regardless of whether the runtime delivers
 * an `ArrayBuffer`, a typed array, or a Node `Buffer`.
 *
 * Uses the global `WebSocket` (Node >= 22 provides one). A host on an older
 * runtime, or one that wants a different framing, passes its own
 * {@link TransportFactory} to `connectAgenticChannel`.
 */
export const websocketTransport: TransportFactory = (url, hooks) => {
  if (typeof WebSocket !== "function") {
    throw new Error(
      "No global WebSocket is available. Run on Node >= 22.6 (which provides a global WebSocket) " +
        "or pass a custom `transport` factory to connectAgenticChannel().",
    );
  }

  const socket = new WebSocket(url);
  socket.binaryType = "arraybuffer";
  let localClose = false;

  socket.addEventListener("open", () => hooks.onOpen());
  socket.addEventListener("message", (event) => deliverIncoming(event.data, hooks));
  socket.addEventListener("error", (event) => {
    // Preserve the underlying error event as the cause so callers (tests,
    // operational logs) can inspect the transport-level failure rather than
    // only seeing a generic message.
    hooks.onError(new Error("agentic channel transport error", { cause: event }));
  });
  socket.addEventListener("close", (event) => {
    hooks.onClose({ code: event.code, reason: event.reason, local: localClose });
  });

  return {
    send(bytes: Uint8Array): void {
      if (socket.readyState !== WebSocket.OPEN) {
        throw new Error("agentic channel is not open");
      }
      socket.send(bytes);
    },
    close(code?: number, reason?: string): void {
      localClose = true;
      socket.close(code, reason);
    },
  };
};

/**
 * Route one inbound transport message: a binary frame goes to `onFrame`; a
 * non-binary message (a protocol violation under the "one binary frame per
 * message" contract) is surfaced via `onError` rather than silently dropped, so
 * the client never hangs seeing no frames yet no error. This is the single
 * source of truth for the transport's message-dispatch branch.
 */
export function deliverIncoming(data: unknown, hooks: Pick<TransportHooks, "onFrame" | "onError">): void {
  const bytes = normaliseIncoming(data);
  if (bytes !== undefined) {
    hooks.onFrame(bytes);
    return;
  }
  hooks.onError(new Error("agentic channel received a non-binary message; expected one binary frame per message"));
}

/** Normalise a WebSocket message payload to bytes, or `undefined` if it is text. */
export function normaliseIncoming(data: unknown): Uint8Array | undefined {
  if (data instanceof Uint8Array) {
    return data;
  }
  if (data instanceof ArrayBuffer) {
    return new Uint8Array(data);
  }
  if (ArrayBuffer.isView(data)) {
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  }
  return undefined;
}
