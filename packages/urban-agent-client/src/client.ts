import { OutboundRing } from "./ring.ts";
import {
  MAX_SEQ,
  decodeFrame,
  encodeFrame,
  isMessageFamily,
  validatePayload,
} from "./protocol.ts";
import type {
  Capability,
  DeregisterPayload,
  Frame,
  HeartbeatPayload,
  MessageFamily,
  QosLane,
  RegisterPayload,
  RelayPayload,
  ServePayload,
} from "./protocol.ts";
import { websocketTransport } from "./transport.ts";
import type { Transport, TransportCloseInfo, TransportFactory } from "./transport.ts";

/**
 * The lane each outbound family rides. Presence, coordination and vocab are
 * control/facts; relay bytes are bulk. This is the client's contribution to
 * invariant #5 — a relay storm on the bulk lane can never head-of-line-block a
 * heartbeat or deregister on the control lane.
 */
const OUTBOUND_LANE: Record<"register" | "heartbeat" | "deregister" | "relay", QosLane> = {
  register: "control",
  heartbeat: "control",
  deregister: "control",
  relay: "bulk",
};

const DEFAULT_BUFFER_CAPACITY = 1024;
const DEFAULT_SERVE_TIMEOUT_MS = 30_000;
const DEFAULT_RECONNECT = {
  enabled: true,
  initialDelayMs: 250,
  maxDelayMs: 10_000,
  factor: 2,
} as const;

/**
 * Guard a resolved timing/backoff option. Node's setTimeout/setInterval coerce a
 * negative or NaN delay to 0, which would turn a misconfigured heartbeat or
 * reconnect backoff into a tight, event-loop-saturating loop. Reject such values
 * at construction — the same fail-fast contract OutboundRing applies to capacity —
 * instead of silently degrading into a hot loop at runtime.
 */
function assertFiniteAtLeast(name: string, value: number, min: number): void {
  if (!Number.isFinite(value) || value < min) {
    throw new RangeError(`${name} must be a finite number >= ${min}, got ${value}`);
  }
}

export interface ReconnectOptions {
  readonly enabled?: boolean;
  readonly initialDelayMs?: number;
  readonly maxDelayMs?: number;
  readonly factor?: number;
}

export interface AgenticClientOptions {
  /**
   * The agentic channel URL (the app's own bound port). Always passed through
   * to the transport factory as its first argument; only the default WebSocket
   * transport requires it, so a custom `transport` may ignore it.
   */
  readonly url: string;
  /** Stable instance id, carried on every presence frame. Defaults to a random UUID. */
  readonly instance?: string;
  /**
   * Capability declared at REGISTER. Stored so a reconnect re-registers
   * automatically. May be supplied here or later via {@link AgenticClient.register}.
   */
  readonly capability?: Capability;
  /** Transport factory; defaults to a binary WebSocket. Injected in tests. */
  readonly transport?: TransportFactory;
  /** Outbound buffer size in frames (hub-down tolerance). Default 1024. */
  readonly bufferCapacity?: number;
  /** Auto-heartbeat period in ms; 0/undefined disables the timer (call {@link AgenticClient.heartbeat} manually). */
  readonly heartbeatIntervalMs?: number;
  /** How long {@link AgenticClient.register} waits for its SERVE before rejecting. Default 30s. */
  readonly serveTimeoutMs?: number;
  /** Reconnect/backoff policy. Enabled by default. */
  readonly reconnect?: ReconnectOptions;
  /** Injectable scheduler for reconnect backoff (tests). Defaults to setTimeout. */
  readonly schedule?: (fn: () => void, ms: number) => void;
}

export interface RegisterResult {
  /** The resolved leaf routing tokens from the vocab handshake (S3). */
  readonly serve: readonly string[];
}

export type AgenticClientState = "idle" | "connecting" | "open" | "closed";

type Listener<T> = (value: T) => void;
/** Listener for value-less events (channel open, buffer drained). */
type VoidListener = () => void;

interface PendingServe {
  resolve: (result: RegisterResult) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout> | undefined;
}

/**
 * Worker-side client for the Nano agentic channel (S9).
 *
 * Speaks the S0 wire contract on a connection SEPARATE from the C8 job protocol
 * (invariants #1/#2): it registers a capability, receives its resolved `SERVE`
 * tokens, heartbeats/deregisters, and produces relay bytes. Everything the
 * worker produces goes through a bounded {@link OutboundRing}, so the worker
 * keeps producing across a hub outage and drains — in strict QoS order — on
 * reconnect (invariants #5/#6). Capability is an enrolment attribute, never a
 * routing token (invariant #3).
 */
export class AgenticClient {
  readonly instance: string;
  private readonly url: string;
  private readonly transportFactory: TransportFactory;
  private readonly ring: OutboundRing;
  private readonly heartbeatIntervalMs: number;
  private readonly serveTimeoutMs: number;
  private readonly reconnectPolicy: Required<ReconnectOptions>;
  private readonly schedule: (fn: () => void, ms: number) => void;

  private capability: Capability | undefined;
  private transport: Transport | undefined;
  private state: AgenticClientState = "idle";
  private seq = 0;
  private reconnectDelay: number;
  private reconnecting = false;
  private closedByCaller = false;
  private closeHandled = false;
  private heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  private pendingServe: PendingServe | undefined;
  private lastServe: readonly string[] = [];
  private readonly relayOffsets = new Map<string, number>();

  private readonly serveListeners = new Set<Listener<ServePayload>>();
  private readonly frameListeners = new Set<Listener<Frame>>();
  private readonly openListeners = new Set<VoidListener>();
  private readonly closeListeners = new Set<Listener<TransportCloseInfo>>();
  private readonly errorListeners = new Set<Listener<Error>>();
  private readonly drainListeners = new Set<VoidListener>();

  constructor(options: AgenticClientOptions) {
    this.url = options.url;
    this.instance = options.instance ?? crypto.randomUUID();
    this.capability = options.capability;
    this.transportFactory = options.transport ?? websocketTransport;
    this.ring = new OutboundRing({ capacity: options.bufferCapacity ?? DEFAULT_BUFFER_CAPACITY });
    this.heartbeatIntervalMs = options.heartbeatIntervalMs ?? 0;
    this.serveTimeoutMs = options.serveTimeoutMs ?? DEFAULT_SERVE_TIMEOUT_MS;
    this.reconnectPolicy = {
      enabled: options.reconnect?.enabled ?? DEFAULT_RECONNECT.enabled,
      initialDelayMs: options.reconnect?.initialDelayMs ?? DEFAULT_RECONNECT.initialDelayMs,
      maxDelayMs: options.reconnect?.maxDelayMs ?? DEFAULT_RECONNECT.maxDelayMs,
      factor: options.reconnect?.factor ?? DEFAULT_RECONNECT.factor,
    };
    this.reconnectDelay = this.reconnectPolicy.initialDelayMs;
    // Reject timing/backoff options that Node would coerce into a 0ms hot loop.
    assertFiniteAtLeast("heartbeatIntervalMs", this.heartbeatIntervalMs, 0);
    assertFiniteAtLeast("serveTimeoutMs", this.serveTimeoutMs, 0);
    assertFiniteAtLeast("reconnect.initialDelayMs", this.reconnectPolicy.initialDelayMs, 0);
    assertFiniteAtLeast("reconnect.maxDelayMs", this.reconnectPolicy.maxDelayMs, 0);
    assertFiniteAtLeast("reconnect.factor", this.reconnectPolicy.factor, 1);
    this.schedule =
      options.schedule ??
      ((fn, ms) => {
        // Match the serve-timeout and heartbeat timers: an auto-reconnect backoff
        // timer must not keep the Node event loop alive on its own.
        const timer = setTimeout(fn, ms);
        if (typeof timer.unref === "function") {
          timer.unref();
        }
      });
  }

  /** Current connection state. */
  get connectionState(): AgenticClientState {
    return this.state;
  }

  /** True when the transport is open and draining live. */
  get connected(): boolean {
    return this.state === "open";
  }

  /** Number of frames currently buffered awaiting a live channel. */
  get buffered(): number {
    return this.ring.size;
  }

  /** The most recently resolved SERVE token set (empty until the first SERVE). */
  get serve(): readonly string[] {
    return this.lastServe;
  }

  /** Open the transport. Safe to call once; reconnects are automatic. A no-op after close() (terminal). */
  connect(): void {
    // A caller-initiated close() is terminal: once closed, connect() is a no-op
    // so a shut-down client never silently reopens (and never re-drains frames
    // buffered before the shutdown). Manual reconnect after a passive drop is
    // still available from the "idle" state (reconnect disabled).
    if (this.state === "connecting" || this.state === "open" || this.state === "closed") {
      return;
    }
    this.closedByCaller = false;
    this.openTransport();
  }

  /**
   * Declare a capability and await the resolved SERVE tokens.
   *
   * The REGISTER frame is buffered like any other outbound frame, so calling
   * `register` while the hub is down does not fail — it enqueues and resolves
   * once the channel comes back and the hub answers with SERVE. Capability is an
   * enrolment attribute; it never becomes part of a routing token (invariant #3).
   */
  register(input?: { capability?: Capability }): Promise<RegisterResult> {
    // A closed client is terminal: its buffer is released and the transport can
    // never reopen, so a register here could only create a pending promise that
    // never resolves and buffer a frame that never drains. Fail fast instead.
    if (this.isClosed) {
      return Promise.reject(new Error("register on a closed client"));
    }
    const capability = input?.capability ?? this.capability;
    if (capability === undefined) {
      return Promise.reject(new Error("register requires a capability (pass one, or set it in the client options)"));
    }
    this.capability = capability;

    // A fresh register supersedes any in-flight one: reject the prior promise
    // AND drop any REGISTER still buffered in the ring, so a reconnect drains
    // only the newest capability (and never a stale duplicate ahead of it).
    this.rejectPendingServe(new Error("superseded by a newer register"));
    this.removeBuffered("register");

    const promise = new Promise<RegisterResult>((resolve, reject) => {
      const timer =
        this.serveTimeoutMs > 0
          ? setTimeout(() => {
              this.pendingServe = undefined;
              reject(new Error(`SERVE not received within ${this.serveTimeoutMs}ms`));
            }, this.serveTimeoutMs)
          : undefined;
      if (timer !== undefined && typeof timer.unref === "function") {
        timer.unref();
      }
      this.pendingServe = { resolve, reject, timer };
    });

    this.enqueueRegister(capability);
    if (this.state === "idle") {
      this.connect();
    }
    if (this.heartbeatIntervalMs > 0) {
      this.startHeartbeatTimer();
    }
    return promise;
  }

  /** Produce a single liveness heartbeat (control lane). Ages out on TTL if it stops (S2). */
  heartbeat(): void {
    if (this.refuseWhenClosed("heartbeat")) {
      return;
    }
    // A heartbeat is point-in-time liveness, not durable state: only the newest
    // one matters. Coalesce any heartbeat still buffered from a prior tick before
    // enqueuing this one, so at most a single heartbeat is ever buffered. Without
    // this, an auto-heartbeat timer running through a long outage would pile
    // never-evicted control-lane heartbeats into the bounded ring and shed the
    // buffered bulk relay (worker output) via the QoS overflow policy.
    this.removeBuffered("heartbeat");
    const payload: HeartbeatPayload = { instance: this.instance };
    this.enqueue("heartbeat", OUTBOUND_LANE.heartbeat, payload);
  }

  /**
   * Produce relay bytes on the bulk lane. `chunk` is the terminal/command output
   * for `stream`; the client tracks a monotonic per-stream byte offset so the
   * hub-side ring can resume-from-offset after a consumer reconnect (S5). Bytes
   * are UTF-8-encoded on the wire as the payload's `chunk` string.
   */
  relay(stream: string, chunk: string): void {
    // Terminal client: refuse before touching the per-stream offset map (which
    // close() already released) so a post-close relay neither re-grows that map
    // nor buffers a frame that can never drain.
    if (this.refuseWhenClosed("relay")) {
      return;
    }
    const offset = this.relayOffsets.get(stream) ?? 0;
    const payload: RelayPayload = { stream, offset, chunk };
    // Advance the per-stream offset only if the frame was actually accepted
    // for sending. A rejected relay (invalid payload) must not consume offset
    // space, or every subsequent relay's offset would be inconsistent with the
    // bytes the hub actually received.
    if (this.enqueue("relay", OUTBOUND_LANE.relay, payload)) {
      this.relayOffsets.set(stream, offset + byteLength(chunk));
    }
  }

  /**
   * Deregister and close. Sends a deregister frame best-effort — only when the
   * channel is currently open. `close()` is terminal and releases the buffer, so
   * a deregister enqueued while disconnected could never drain; enqueuing it then
   * would just pin an unsendable frame until close() drops it. When the channel
   * is down we therefore skip the frame and tear down directly, without
   * reconnecting.
   */
  deregister(reason?: string): void {
    if (this.state === "open") {
      const payload: DeregisterPayload = reason === undefined ? { instance: this.instance } : { instance: this.instance, reason };
      this.enqueue("deregister", OUTBOUND_LANE.deregister, payload);
    }
    this.close();
  }

  /** Tear down the client: stop the heartbeat, close the transport, stop reconnecting. */
  close(): void {
    this.closedByCaller = true;
    this.stopHeartbeatTimer();
    this.rejectPendingServe(new Error("client closed"));
    // Best-effort transport close, then own the state transition + close event
    // ourselves. A real transport's close is asynchronous (a WebSocket fires its
    // own onClose on a later tick), and it may never surface a close at all, so
    // we drive handleClose directly to guarantee onClose fires. handleClose is
    // idempotent per connection attempt, so it de-duplicates against any onClose
    // the transport also fires.
    // Terminal: the outbound ring and per-stream relay offsets can never be
    // drained again, so release them here rather than pinning a large outage
    // backlog (buffered frames, many relay streams) in memory for the lifetime
    // of the now-dead client. Clear BEFORE anything can fire the close event —
    // both the transport (an injectable seam that may legally fire onClose
    // synchronously from close(), as FakeTransport does when open) and our own
    // handleClose below emit onClose synchronously. A subscriber that reads
    // `buffered` (or the relay-offset state) must observe the released,
    // self-consistent terminal state that close() documents — not a stale
    // non-zero backlog — regardless of which path surfaces the close first.
    this.ring.clear();
    this.relayOffsets.clear();
    const transport = this.transport;
    this.transport = undefined;
    try {
      transport?.close();
    } catch {
      // An already-broken transport may throw on close; the teardown proceeds.
    }
    this.handleClose({ local: true });
  }

  /** Subscribe to resolved SERVE tokens (fires on every SERVE, including reconnects). */
  onServe(listener: Listener<ServePayload>): () => void {
    this.serveListeners.add(listener);
    return () => this.serveListeners.delete(listener);
  }

  /** Subscribe to every validated inbound frame. */
  onFrame(listener: Listener<Frame>): () => void {
    this.frameListeners.add(listener);
    return () => this.frameListeners.delete(listener);
  }

  /** Subscribe to channel-open events (fires on first connect and each reconnect). */
  onOpen(listener: VoidListener): () => void {
    this.openListeners.add(listener);
    return () => this.openListeners.delete(listener);
  }

  /** Subscribe to channel-close events. */
  onClose(listener: Listener<TransportCloseInfo>): () => void {
    this.closeListeners.add(listener);
    return () => this.closeListeners.delete(listener);
  }

  /** Subscribe to transport / decode / validation errors (never thrown; always non-fatal). */
  onError(listener: Listener<Error>): () => void {
    this.errorListeners.add(listener);
    return () => this.errorListeners.delete(listener);
  }

  /** Subscribe to buffer-drained events (fires when the outbound ring empties after sending). */
  onDrain(listener: VoidListener): () => void {
    this.drainListeners.add(listener);
    return () => this.drainListeners.delete(listener);
  }

  // ---- internals -----------------------------------------------------------

  private openTransport(): void {
    this.state = "connecting";
    this.closeHandled = false;
    try {
      this.transport = this.transportFactory(this.url, {
        onOpen: () => this.handleOpen(),
        onFrame: (bytes) => this.handleFrame(bytes),
        onClose: (info) => this.handleClose(info),
        onError: (error) => this.emitError(error),
      });
    } catch (error) {
      // A transport factory can throw synchronously — e.g. the default
      // websocketTransport when no global WebSocket is available. Without this
      // guard the exception escapes openTransport() and the client wedges in
      // "connecting" with no transport and no signal. Surface it as a non-fatal
      // error and drive handleClose so the client leaves "connecting" the same
      // way a failed connection would: scheduling a reconnect when enabled, or
      // going idle/closed otherwise.
      this.transport = undefined;
      this.emitError(error instanceof Error ? error : new Error(String(error)));
      this.handleClose({ reason: "transport factory failed" });
    }
  }

  private handleOpen(): void {
    this.state = "open";
    this.reconnectDelay = this.reconnectPolicy.initialDelayMs;
    // Re-announce presence first so a reconnect re-registers before draining
    // any buffered relay backlog. Coalesce any REGISTER already buffered
    // (possibly behind other control-lane frames a caller queued during the
    // outage, e.g. a heartbeat) and enqueue a fresh one at the front of the
    // control lane, so it drains ahead of the entire backlog — never behind a
    // heartbeat and never as a stale duplicate.
    if (this.capability !== undefined) {
      this.removeBuffered("register");
      this.enqueueRegister(this.capability, true);
      // A capability set in options auto-registers here without register() ever
      // being called, so start the documented auto-heartbeat timer on open too
      // — otherwise heartbeatIntervalMs would silently no-op for auto-register
      // consumers. startHeartbeatTimer() is idempotent, so an explicit
      // register() that already started it is unaffected.
      if (this.heartbeatIntervalMs > 0) {
        this.startHeartbeatTimer();
      }
    }
    this.emitOpen();
    this.pump();
  }

  private handleClose(info: TransportCloseInfo): void {
    // Idempotent per connection attempt: a send failure may route us here
    // directly AND the transport may still fire its own onClose. Handle once.
    if (this.closeHandled) {
      return;
    }
    this.closeHandled = true;
    this.transport = undefined;
    if (this.closedByCaller) {
      this.state = "closed";
    } else if (this.reconnectPolicy.enabled) {
      this.state = "connecting";
    } else {
      // No auto-reconnect: go idle so the caller can reconnect manually.
      this.state = "idle";
    }
    // Emit exactly once per handled close (the closeHandled guard above makes
    // this once-per-connection-attempt). Fire regardless of whether we reached
    // "open": a caller-initiated close while still "connecting" must notify
    // onClose just like a remote drop while connecting already does — otherwise
    // onClose is silent for `connect()` immediately followed by `close()`.
    this.emitClose(info);
    if (!this.closedByCaller && this.reconnectPolicy.enabled) {
      this.scheduleReconnect();
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnecting) {
      return;
    }
    this.reconnecting = true;
    const delay = this.reconnectDelay;
    this.reconnectDelay = Math.min(this.reconnectDelay * this.reconnectPolicy.factor, this.reconnectPolicy.maxDelayMs);
    this.schedule(() => {
      this.reconnecting = false;
      if (!this.closedByCaller) {
        this.openTransport();
      }
    }, delay);
  }

  private handleFrame(bytes: Uint8Array): void {
    let frame: Frame;
    try {
      frame = decodeFrame(bytes);
    } catch (error) {
      // Malformed input from the wire must never crash the worker — surface it
      // and keep the channel alive. This is what the conformance corpus's
      // malformed vectors exercise.
      this.emitError(asError(error, "failed to decode inbound frame"));
      return;
    }
    const check = validatePayload(frame.family, frame.payload);
    if (!check.ok) {
      this.emitError(new Error(`inbound ${frame.family} payload failed validation: ${check.errors.map((e) => e.code).join(",")}`));
      return;
    }
    this.emitFrame(frame);
    if (frame.family === "serve") {
      this.handleServe(frame.payload);
    }
  }

  private handleServe(payload: unknown): void {
    if (!isServePayload(payload) || payload.instance !== this.instance) {
      return;
    }
    this.lastServe = payload.tokens;
    if (this.pendingServe !== undefined) {
      const pending = this.pendingServe;
      this.pendingServe = undefined;
      if (pending.timer !== undefined) {
        clearTimeout(pending.timer);
      }
      pending.resolve({ serve: payload.tokens });
    }
    this.emitServe(payload);
  }

  private enqueueRegister(capability: Capability, front = false): void {
    const payload: RegisterPayload = { instance: this.instance, capability };
    const invalid = this.rejectInvalidOutbound("register", payload);
    if (invalid) {
      return;
    }
    if (front) {
      const frame: Frame = { lane: OUTBOUND_LANE.register, family: "register", seq: this.nextSeq(), payload };
      this.ring.enqueueFront(frame);
      this.pump();
      return;
    }
    this.enqueue("register", OUTBOUND_LANE.register, payload);
  }

  private enqueue(family: MessageFamily, lane: QosLane, payload: unknown): boolean {
    if (this.refuseWhenClosed(family)) {
      return false;
    }
    if (this.rejectInvalidOutbound(family, payload)) {
      return false;
    }
    const frame: Frame = { lane, family, seq: this.nextSeq(), payload };
    this.ring.enqueue(frame);
    this.pump();
    return true;
  }

  /** True once close() has been called — the terminal state (see {@link close}). */
  private get isClosed(): boolean {
    return this.state === "closed";
  }

  /**
   * Categorical guard for every outbound-producing surface: once the client is
   * closed (terminal), the transport can never reopen and the buffer has been
   * released, so any frame produced here can never drain. Rather than silently
   * re-grow the ring close() emptied — and mislead the caller — refuse and
   * surface the misuse via onError. Returns true when the call was refused.
   */
  private refuseWhenClosed(family: MessageFamily): boolean {
    if (!this.isClosed) {
      return false;
    }
    this.emitError(new Error(`cannot ${family} on a closed client`));
    return true;
  }

  /**
   * Validate an outbound payload against the S0 contract before it is buffered.
   * An unsendable frame is never enqueued (so it can't silently occupy buffer
   * space and then be dropped at encode time); the error is surfaced and, when
   * it is the REGISTER we are awaiting a SERVE for, the register promise is
   * failed fast instead of hanging until the serve timeout (or forever when the
   * timeout is disabled). Returns true when the payload was rejected.
   */
  private rejectInvalidOutbound(family: MessageFamily, payload: unknown): boolean {
    const check = validatePayload(family, payload);
    if (check.ok) {
      return false;
    }
    const error = new Error(
      `outbound ${family} payload failed validation: ${check.errors.map((e) => e.code).join(",")}`,
    );
    if (family === "register") {
      this.rejectPendingServe(error);
    }
    this.emitError(error);
    return true;
  }

  /** Drain the ring to the transport in strict QoS order until it empties or a send fails. */
  private pump(): void {
    if (this.state !== "open" || this.transport === undefined) {
      return;
    }
    let sentAny = false;
    while (!this.ring.isEmpty) {
      const frame = this.ring.peek();
      if (frame === undefined) {
        break;
      }
      let bytes: Uint8Array;
      try {
        bytes = encodeFrame(frame);
      } catch (error) {
        // An unencodable frame can never be sent — drop it rather than wedge the
        // drain, and report it. If it was the REGISTER we are awaiting a SERVE
        // for, fail that promise fast instead of leaving it pending until (or
        // beyond) the serve timeout.
        this.ring.dequeue();
        const err = asError(error, "failed to encode outbound frame; dropped");
        if (frame.family === "register") {
          this.rejectPendingServe(err);
        }
        this.emitError(err);
        continue;
      }
      try {
        this.transport.send(bytes);
      } catch (error) {
        // The channel went away mid-drain: leave the frame buffered and stop.
        // The transport is not required to also fire onClose (the send contract
        // only mandates a synchronous throw), so drive the disconnect/reconnect
        // ourselves rather than relying on an onClose that may never arrive —
        // otherwise a throw-only transport wedges the client with a full buffer.
        this.emitError(asError(error, "transport send failed; reconnecting"));
        this.forceReconnect({ local: false });
        break;
      }
      this.ring.dequeue();
      sentAny = true;
    }
    if (sentAny && this.ring.isEmpty) {
      this.emitDrain();
    }
  }

  /**
   * Drop every buffered frame of `family` from the ring, returning them. The
   * single source of truth for outbound coalescing: register coalescing (a
   * superseding `register()` and a reconnect's `handleOpen()`) and heartbeat
   * coalescing both use it so the drain never emits a stale or duplicate frame.
   */
  private removeBuffered(family: MessageFamily): Frame[] {
    return this.ring.remove((frame) => frame.family === family);
  }

  /**
   * Tear down the current transport and route through the normal close/reconnect
   * path when a send throws but the transport does not (or has not yet) fired its
   * own onClose. `handleClose` is idempotent for this connection attempt, so if
   * the transport DOES also emit onClose the second pass is a no-op.
   */
  private forceReconnect(info: TransportCloseInfo): void {
    const transport = this.transport;
    this.transport = undefined;
    // Drive the close with the intended `info` FIRST, then tear down the
    // transport. `handleClose` is idempotent per connection attempt, so if
    // closing the transport synchronously fires its own onClose (the bundled
    // FakeTransport does, with `{ local: true }`), that second pass is a no-op
    // and cannot misreport this remote drop / send failure as a local close.
    this.handleClose(info);
    try {
      transport?.close();
    } catch {
      // A transport that is already broken may throw on close; ignore it.
    }
  }

  private nextSeq(): number {
    const value = this.seq;
    this.seq = this.seq >= MAX_SEQ ? 0 : this.seq + 1;
    return value;
  }

  private startHeartbeatTimer(): void {
    if (this.heartbeatTimer !== undefined || this.heartbeatIntervalMs <= 0) {
      return;
    }
    const timer = setInterval(() => this.heartbeat(), this.heartbeatIntervalMs);
    if (typeof timer.unref === "function") {
      timer.unref();
    }
    this.heartbeatTimer = timer;
  }

  private stopHeartbeatTimer(): void {
    if (this.heartbeatTimer !== undefined) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = undefined;
    }
  }

  private rejectPendingServe(error: Error): void {
    if (this.pendingServe !== undefined) {
      const pending = this.pendingServe;
      this.pendingServe = undefined;
      if (pending.timer !== undefined) {
        clearTimeout(pending.timer);
      }
      pending.reject(error);
    }
  }

  /**
   * Fan a value out to a set of subscribers, isolating each one's failures.
   *
   * A subscriber that throws must never break dispatch to the remaining
   * subscribers, and — critically — must never propagate out of internal
   * plumbing that emits events. `emitError` in particular runs inside error
   * handling (e.g. a malformed inbound frame), so an `onError` subscriber that
   * throws would otherwise escape that handler and can take the worker down.
   * Containing throws here is the single canonical dispatch contract for every
   * `emit*` below, so no individual emitter can reintroduce that failure mode.
   */
  private dispatch<T>(listeners: Set<Listener<T>>, value: T): void {
    for (const listener of listeners) {
      try {
        listener(value);
      } catch {
        // A subscriber's failure is its own problem; contain it so event
        // reporting can neither break sibling subscribers nor crash internal
        // handling. We deliberately do not re-emit onError here — an onError
        // subscriber that throws must not trigger unbounded re-entry.
      }
    }
  }

  private emitServe(value: ServePayload): void {
    this.dispatch(this.serveListeners, value);
  }

  private emitFrame(value: Frame): void {
    this.dispatch(this.frameListeners, value);
  }

  private emitOpen(): void {
    this.dispatch(this.openListeners, undefined);
  }

  private emitClose(value: TransportCloseInfo): void {
    this.dispatch(this.closeListeners, value);
  }

  private emitError(value: Error): void {
    this.dispatch(this.errorListeners, value);
  }

  private emitDrain(): void {
    this.dispatch(this.drainListeners, undefined);
  }
}


/**
 * Connect a worker to the Nano agentic channel and return the client. The
 * transport begins connecting immediately; because everything the worker
 * produces is buffered, callers may `register`/`relay` straight away even before
 * the channel is open (invariant #6).
 */
export function connectAgenticChannel(options: AgenticClientOptions): AgenticClient {
  const client = new AgenticClient(options);
  client.connect();
  return client;
}

const utf8Encoder = new TextEncoder();

function byteLength(text: string): number {
  return utf8Encoder.encode(text).length;
}

function isServePayload(payload: unknown): payload is ServePayload {
  if (typeof payload !== "object" || payload === null) {
    return false;
  }
  if (!("instance" in payload) || !("tokens" in payload)) {
    return false;
  }
  const { instance, tokens } = payload;
  return (
    typeof instance === "string" &&
    Array.isArray(tokens) &&
    tokens.every((token: unknown) => typeof token === "string")
  );
}

function asError(error: unknown, fallback: string): Error {
  if (error instanceof Error) {
    return error;
  }
  return new Error(fallback);
}

/** Re-exported so `isMessageFamily` is available to callers narrowing frames. */
export { isMessageFamily };
