/**
 * The browser-side relay channel client — S8.
 *
 * Ties one relay stream's {@link TerminalSession} to a live WebSocket-style
 * connection: it encodes the session's outbound relay messages into S0 frames
 * ({@link encodeFrame}) on the control lane, decodes inbound frames
 * ({@link decodeFrame}) and routes `relay`-family payloads back to the session,
 * and — critically for "survives a cockpit reconnect" — re-opens the socket when
 * it drops and fires {@link RelayChannelClientOptions.onOpen} on **every**
 * (re)connect, so the caller re-attaches the session and resumes from its last
 * offset.
 *
 * It is transport- and timer-injected: the socket comes from a
 * {@link SocketFactory} and reconnect scheduling from an injected
 * {@link Scheduler}, so the whole reconnect→resume path is exercised
 * deterministically in tests with a fake socket and a manual scheduler — no real
 * timers, no real network (AGENTS.md: no flaky tests, no test retries).
 */
import { isNonNegInt, RELAY_FAMILY } from "@nanobpm/agentic-relay";
import { decodeFrame, encodeFrame, MAX_SEQ } from "@nanobpm/agentic-protocol";
import type { Frame, RelayPayload } from "@nanobpm/agentic-protocol";
import type { RelayInbound, RelayOutbound } from "./terminal-session.ts";

/** The minimal socket surface the client drives (a browser `WebSocket` adapts to this). */
export interface RawSocket {
  /** Send one binary frame. */
  send(bytes: Uint8Array): void;
  /** Close the socket. */
  close(): void;
  /** Register the inbound-binary-frame listener. */
  onMessage(listener: (bytes: Uint8Array) => void): void;
  /** Register the open listener (fired once per successful connect). */
  onOpen(listener: () => void): void;
  /** Register the close listener (fired once when the socket drops). */
  onClose(listener: () => void): void;
}

/** Opens a fresh socket. Called once per (re)connect. */
export type SocketFactory = () => RawSocket;

/** Schedules a reconnect attempt. Injected so tests can run it synchronously. */
export type Scheduler = (run: () => void) => void;

export interface RelayChannelClientOptions {
  /** Opens a fresh socket for each (re)connect. */
  readonly connect: SocketFactory;
  /** Receives every inbound `relay`-family payload (data chunk or resume ack). */
  readonly onRelay: (message: RelayInbound) => void;
  /** Fired on every (re)connect — the caller re-attaches the session here. */
  readonly onOpen?: () => void;
  /** Fired when the socket drops (before a reconnect is scheduled). */
  readonly onClose?: () => void;
  /** Notified of a decode/dispatch error on an inbound frame. */
  readonly onError?: (err: unknown) => void;
  /** Reconnect scheduler. Default `setTimeout(run, 0)`. */
  readonly schedule?: Scheduler;
  /** Reconnect automatically on close. Default true. */
  readonly autoReconnect?: boolean;
}

const CONTROL_LANE: Frame["lane"] = "control";

function defaultSchedule(run: () => void): void {
  setTimeout(run, 0);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Narrow a decoded `relay`-family payload to the inbound sub-protocol without an
 * unchecked cast (the repo bans `as`): a data chunk `{ stream, offset, chunk }`
 * or a resume ack `{ op: "subscribed", stream, gap, nextOffset }`. Any payload
 * carrying an `op` field is treated as an op-message and rejected unless it is a
 * well-formed known op, so a malformed/unknown op can never fall through and be
 * mistaken for a data chunk.
 */
function asRelayInbound(payload: unknown): RelayInbound | null {
  if (!isRecord(payload)) return null;
  if ("op" in payload) {
    if (
      payload.op === "subscribed" &&
      typeof payload.stream === "string" &&
      typeof payload.gap === "boolean" &&
      isNonNegInt(payload.nextOffset)
    ) {
      return { op: "subscribed", stream: payload.stream, gap: payload.gap, nextOffset: payload.nextOffset };
    }
    return null;
  }
  if (typeof payload.stream === "string" && isNonNegInt(payload.offset) && typeof payload.chunk === "string") {
    const data: RelayPayload = { stream: payload.stream, offset: payload.offset, chunk: payload.chunk };
    return data;
  }
  return null;
}

/**
 * Manages one relay socket with automatic resume-on-reconnect. Construct once
 * per drill-in and pair with a {@link TerminalSession}: wire the session's
 * `send` to {@link sendRelay}, feed {@link RelayChannelClientOptions.onRelay} to
 * `session.handle`, and call `session.attach()` from `onOpen`.
 */
export class RelayChannelClient {
  readonly #connect: SocketFactory;
  readonly #onRelay: RelayChannelClientOptions["onRelay"];
  readonly #onOpen: RelayChannelClientOptions["onOpen"];
  readonly #onClose: RelayChannelClientOptions["onClose"];
  readonly #onError: RelayChannelClientOptions["onError"];
  readonly #schedule: Scheduler;
  readonly #autoReconnect: boolean;
  #socket: RawSocket | undefined;
  #seq = 0;
  #closed = false;

  constructor(options: RelayChannelClientOptions) {
    this.#connect = options.connect;
    this.#onRelay = options.onRelay;
    this.#onOpen = options.onOpen;
    this.#onClose = options.onClose;
    this.#onError = options.onError;
    this.#schedule = options.schedule ?? defaultSchedule;
    this.#autoReconnect = options.autoReconnect ?? true;
  }

  /** True once {@link close} has been called (no further reconnects). */
  get isClosed(): boolean {
    return this.#closed;
  }

  /** Open the first socket and wire its lifecycle. Idempotent while connected. */
  open(): void {
    if (this.#closed || this.#socket !== undefined) return;
    // Guard the injected factory: connect() can throw synchronously (e.g. the
    // browser adapter's WebSocket constructor on an invalid URL / CSP block).
    // An unguarded throw here escapes open()/#reconnect() and kills the
    // reconnect→resume loop with no error surfaced. Route it to onError and, if
    // autoReconnect is enabled, schedule a retry so the loop survives a
    // transient connect failure — the same way #handleClose recovers a drop.
    let socket: RawSocket;
    try {
      socket = this.#connect();
    } catch (err) {
      this.#onError?.(err);
      if (!this.#closed && this.#autoReconnect) this.#schedule(() => this.#reconnect());
      return;
    }
    this.#socket = socket;
    socket.onMessage((bytes) => this.#receive(bytes));
    // Guard the consumer callback the same way #receive() does: a consumer
    // onOpen handler can throw, and an unguarded throw escapes the socket open
    // callback. Route it to onError so a bad handler can't wedge the client.
    socket.onOpen(() => {
      try {
        this.#onOpen?.();
      } catch (err) {
        this.#onError?.(err);
      }
    });
    socket.onClose(() => this.#handleClose());
  }

  /** Encode and send one outbound relay message on the control lane. */
  sendRelay(message: RelayOutbound): void {
    const socket = this.#socket;
    if (socket === undefined) return;
    const frame: Frame = { lane: CONTROL_LANE, family: RELAY_FAMILY, seq: this.#nextSeq(), payload: message };
    try {
      socket.send(encodeFrame(frame));
    } catch (err) {
      this.#onError?.(err);
    }
  }

  /** Close for good — no reconnect will follow. */
  close(): void {
    this.#closed = true;
    const socket = this.#socket;
    this.#socket = undefined;
    socket?.close();
  }

  #nextSeq(): number {
    const seq = this.#seq;
    this.#seq = this.#seq >= MAX_SEQ ? 0 : this.#seq + 1;
    return seq;
  }

  #receive(bytes: Uint8Array): void {
    let frame: Frame;
    try {
      frame = decodeFrame(bytes);
    } catch (err) {
      this.#onError?.(err);
      return;
    }
    if (frame.family !== RELAY_FAMILY) return;
    const message = asRelayInbound(frame.payload);
    if (message === null) {
      this.#onError?.(new Error("malformed relay payload"));
      return;
    }
    // Guard the consumer the same way decode/malformed errors are guarded: a
    // handler (e.g. TerminalSession.handle) can throw on an unsafe offset via
    // addSafeInt, and an unguarded throw here escapes the socket message
    // callback and can wedge the relay client / page. Route it to onError.
    try {
      this.#onRelay(message);
    } catch (err) {
      this.#onError?.(err);
    }
  }

  #handleClose(): void {
    this.#socket = undefined;
    // Guard the consumer onClose: if it throws, an unguarded exception here
    // skips the reconnect scheduling below and breaks the "survives reconnect"
    // invariant for reasons unrelated to transport. Route it to onError, then
    // continue with reconnect regardless.
    try {
      this.#onClose?.();
    } catch (err) {
      this.#onError?.(err);
    }
    if (this.#closed || !this.#autoReconnect) return;
    this.#schedule(() => this.#reconnect());
  }

  #reconnect(): void {
    if (this.#closed || this.#socket !== undefined) return;
    this.open();
  }
}
