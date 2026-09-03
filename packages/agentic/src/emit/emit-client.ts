/**
 * The client-side ownership/presence EMIT client — the emit-side counterpart of
 * the S2/ownership protocol keystone (#543 shipped the *definitions*; this ships
 * the blessed client that *sends* them).
 *
 * One {@link AgenticEmitClient} owns ONE multiplexed host connection that N
 * distinct instances share, and emits every worker→hub ownership/presence frame
 * — `register` / `heartbeat` / `deregister` / `claim` / `release` and the
 * `relay` transcript sink — tagging the OWNING `instance` EXPLICITLY in each
 * frame (never `conn.id`). That explicit tag is what lets a single supervisor
 * connection multiplex the ownership frames of many workers; it is the emit
 * capability the low-level `protocol/frame` + `protocol/payloads` primitives and
 * the server-side `channel` registry never provided.
 *
 * Three invariants make it the single source of truth a supervisor can build a
 * concrete `AgenticEndpoint` on without hand-rolling a parallel client layer:
 *
 *  - **Multiplexed presence.** register/heartbeat/deregister and claim/release
 *    all carry `instance` per frame, so one socket carries the whole fleet.
 *  - **Reconnect resync.** On every (re)connect the client re-`register`s all
 *    known instances and re-`claim`s all in-flight jobs BEFORE it fires
 *    {@link AgenticEmitClientOptions.onOpen} — the hook where the caller resumes
 *    transcript. claim/release are idempotent (a duplicate `{instance, jobKey}`
 *    is a no-op re-assertion), so re-asserting on reconnect is always safe.
 *  - **Additive / version-negotiated.** The client negotiates against the peer's
 *    advertisement ({@link negotiate}); a family the far end can't decode (e.g. a
 *    legacy hub with no `claim`/`release`) degrades that emit to a silent no-op
 *    instead of putting an `unknown-family` frame on the wire.
 *
 * Transport- and timer-injected exactly like the cockpit relay client: the
 * socket comes from an {@link EmitSocketFactory} and reconnect scheduling from an
 * injected {@link Scheduler}, so the whole register→claim→reconnect→resync path
 * is exercised deterministically over an in-memory socket — no real timers, no
 * real network, no test retries.
 */
import {
  encodeFrame,
  MAX_SEQ,
  negotiate,
  LOCAL_ADVERTISEMENT,
  type Capability,
  type Frame,
  type MessageFamily,
  type NegotiatedProtocol,
  type ProtocolAdvertisement,
  type QosLane,
} from "../protocol/index.ts";

/**
 * The minimal duplex socket the emit client drives. A browser `WebSocket`, a
 * `ws` socket, or an in-memory test double all adapt to this — the client never
 * depends on a concrete transport.
 */
export interface EmitSocket {
  /** Send one already-encoded frame as binary bytes. */
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
export type EmitSocketFactory = () => EmitSocket;

/** Schedules a reconnect attempt. Injected so tests can run it synchronously. */
export type Scheduler = (run: () => void) => void;

/** Identifies one transcript/relay stream: an `instance` and its named `stream`. */
export interface TranscriptRef {
  /** The owning instance the stream belongs to. */
  readonly instance: string;
  /** The instance-local stream name (e.g. `stdout`, `stderr`, a session id). */
  readonly stream: string;
}

export interface AgenticEmitClientOptions {
  /** Opens a fresh socket for each (re)connect. */
  readonly connect: EmitSocketFactory;
  /**
   * The peer's protocol advertisement, if known at construction (e.g. captured
   * at the handshake). Negotiation runs against it so an emit for a family the
   * far end can't decode degrades to a no-op. When omitted, the client assumes a
   * peer that supports everything this build does (full support) until
   * {@link AgenticEmitClient.setPeerAdvertisement} is called. May be a raw,
   * untrusted value off the wire — it is parsed defensively.
   */
  readonly peerAdvertisement?: ProtocolAdvertisement | unknown;
  /** This build's own advertisement. Defaults to {@link LOCAL_ADVERTISEMENT}. */
  readonly localAdvertisement?: ProtocolAdvertisement;
  /** Fired on every (re)connect AFTER resync — the caller resumes transcript here. */
  readonly onOpen?: () => void;
  /** Fired when the socket drops (before a reconnect is scheduled). */
  readonly onClose?: () => void;
  /** Notified of a send/encode error. A bad frame never wedges the client. */
  readonly onError?: (err: unknown) => void;
  /** Reconnect scheduler. Default `setTimeout(run, 0)`. */
  readonly schedule?: Scheduler;
  /** Reconnect automatically on close. Default true. */
  readonly autoReconnect?: boolean;
}

const CONTROL_LANE: QosLane = "control";
const BULK_LANE: QosLane = "bulk";

const REGISTER: MessageFamily = "register";
const HEARTBEAT: MessageFamily = "heartbeat";
const DEREGISTER: MessageFamily = "deregister";
const CLAIM: MessageFamily = "claim";
const RELEASE: MessageFamily = "release";
const RELAY: MessageFamily = "relay";

function defaultSchedule(run: () => void): void {
  setTimeout(run, 0);
}

/**
 * Compose the per-instance relay stream id for a {@link TranscriptRef}. The
 * length-prefix makes the encoding injective: no two distinct `{instance,
 * stream}` pairs can ever map to the same id (so two instances' streams never
 * cross), regardless of what delimiter characters an instance or stream name
 * contains. This is the isolation guarantee the transcript sink rests on.
 */
export function composeStreamId(instance: string, stream: string): string {
  return `${instance.length}:${instance}/${stream}`;
}

/**
 * A first-class client that owns ONE multiplexed connection and emits the
 * ownership/presence/transcript frames of N instances over it, each tagging its
 * `instance` explicitly. Construct once per supervisor connection; drive its
 * lifecycle with {@link open}/{@link close} and emit through the per-instance
 * methods.
 */
export class AgenticEmitClient {
  readonly #connect: EmitSocketFactory;
  readonly #local: ProtocolAdvertisement;
  readonly #onOpen: AgenticEmitClientOptions["onOpen"];
  readonly #onClose: AgenticEmitClientOptions["onClose"];
  readonly #onError: AgenticEmitClientOptions["onError"];
  readonly #schedule: Scheduler;
  readonly #autoReconnect: boolean;

  /** Known instances and their last-declared enrolment capability. */
  readonly #instances = new Map<string, Capability>();
  /** In-flight (claimed, not yet released) jobs per instance. */
  readonly #inFlight = new Map<string, Set<string>>();

  #negotiated: NegotiatedProtocol;
  #socket: EmitSocket | undefined;
  #seq = 0;
  /**
   * Producer generation, stamped as the relay `incarnation`. It bumps on every
   * (re)connect so a resumed producer strictly outranks the connection it
   * replaced and the hub fences the stale predecessor.
   */
  #generation = 0;
  #hasConnected = false;
  #closed = false;
  #reconnectRunning = false;
  #reconnectPending = false;

  constructor(options: AgenticEmitClientOptions) {
    this.#connect = options.connect;
    this.#local = options.localAdvertisement ?? LOCAL_ADVERTISEMENT;
    this.#onOpen = options.onOpen;
    this.#onClose = options.onClose;
    this.#onError = options.onError;
    this.#schedule = options.schedule ?? defaultSchedule;
    this.#autoReconnect = options.autoReconnect ?? true;
    const peer = options.peerAdvertisement ?? this.#local;
    this.#negotiated = negotiate(this.#local, peer);
  }

  /** True once {@link close} has been called (no further reconnects). */
  get isClosed(): boolean {
    return this.#closed;
  }

  /** The protocol negotiated with the peer — the families/features safe to emit. */
  get protocol(): NegotiatedProtocol {
    return this.#negotiated;
  }

  /** Instances currently known to the client (registered, not yet deregistered). */
  get instances(): readonly string[] {
    return [...this.#instances.keys()];
  }

  /** The in-flight (claimed, un-released) job keys for an instance. */
  inFlight(instance: string): readonly string[] {
    const jobs = this.#inFlight.get(instance);
    return jobs ? [...jobs] : [];
  }

  /**
   * Update the peer advertisement and re-derive the negotiated protocol. Call
   * this when a fresh handshake reveals a different peer (e.g. after a reconnect
   * to a hub that has since been upgraded). Accepts a raw, untrusted value.
   */
  setPeerAdvertisement(advertisement: ProtocolAdvertisement | unknown): void {
    this.#negotiated = negotiate(this.#local, advertisement ?? this.#local);
  }

  /** Open the first socket and wire its lifecycle. Idempotent while connected. */
  open(): void {
    if (this.#closed || this.#socket !== undefined) return;
    let socket: EmitSocket;
    try {
      socket = this.#connect();
    } catch (err) {
      this.#onError?.(err);
      if (!this.#closed && this.#autoReconnect) this.#scheduleReconnect();
      return;
    }
    this.#socket = socket;
    socket.onMessage(() => {
      // The emit client is an emitter; it holds no inbound sub-protocol of its
      // own. Inbound frames (acks, hub-side facts) are the consumer surface's
      // concern — ignore them here so an inbound frame can never wedge emit.
    });
    socket.onOpen(() => this.#handleOpen());
    socket.onClose(() => this.#handleClose());
  }

  /** Enrol `instance` with its capability. Tracked for reconnect re-registration. */
  register(instance: string, capability: Capability): void {
    this.#instances.set(instance, capability);
    this.#emit(CONTROL_LANE, REGISTER, { instance, capability });
  }

  /** Refresh `instance` liveness. */
  heartbeat(instance: string): void {
    this.#emit(CONTROL_LANE, HEARTBEAT, { instance });
  }

  /**
   * Withdraw `instance`. Drops it (and any of its in-flight jobs) from the
   * tracked set so a later reconnect does not resurrect a departed worker.
   */
  deregister(instance: string, reason?: string): void {
    this.#instances.delete(instance);
    this.#inFlight.delete(instance);
    const payload = reason === undefined ? { instance } : { instance, reason };
    this.#emit(CONTROL_LANE, DEREGISTER, payload);
  }

  /**
   * `instance` now OWNS `jobKey`. Idempotent: a duplicate claim for the same
   * `{instance, jobKey}` re-asserts ownership and is a no-op on the hub. Tracked
   * as in-flight so a reconnect re-claims it. A no-op if the negotiated peer
   * can't decode the `claim` family (legacy degradation).
   */
  claim(instance: string, jobKey: string): void {
    let jobs = this.#inFlight.get(instance);
    if (jobs === undefined) {
      jobs = new Set<string>();
      this.#inFlight.set(instance, jobs);
    }
    jobs.add(jobKey);
    this.#emit(CONTROL_LANE, CLAIM, { instance, jobKey });
  }

  /**
   * `instance` has RELEASED `jobKey`. Idempotent: a late/duplicate release — even
   * with no preceding claim — is a no-op. Stops tracking the job so a reconnect
   * does not re-claim a finished job. A no-op if the negotiated peer can't decode
   * the `release` family (legacy degradation).
   */
  release(instance: string, jobKey: string): void {
    const jobs = this.#inFlight.get(instance);
    if (jobs !== undefined) {
      jobs.delete(jobKey);
      if (jobs.size === 0) this.#inFlight.delete(instance);
    }
    this.#emit(CONTROL_LANE, RELEASE, { instance, jobKey });
  }

  /**
   * Append a transcript `chunk` to a `{instance, stream}` relay stream. The
   * stream id is composed per-instance ({@link composeStreamId}) so two
   * instances' transcripts can never cross. Rides the `bulk` lane and stamps the
   * current producer {@link #generation} as the `incarnation`, so a resumed
   * producer fences its stale predecessor. Emits nothing if not yet connected.
   */
  transcript(ref: TranscriptRef, chunk: string): void {
    this.#emit(BULK_LANE, RELAY, {
      op: "produce",
      stream: composeStreamId(ref.instance, ref.stream),
      incarnation: this.#generation,
      chunk,
    });
  }

  /** Close for good — no reconnect will follow. */
  close(): void {
    this.#closed = true;
    const socket = this.#socket;
    this.#socket = undefined;
    socket?.close();
  }

  #handleOpen(): void {
    // Bump the producer generation on every reconnect (not the very first
    // connect) so resumed transcript producers strictly outrank the predecessor.
    if (this.#hasConnected) this.#generation += 1;
    this.#hasConnected = true;

    // Resync BEFORE handing control back to the caller: re-register every known
    // instance and re-claim every in-flight job so hub state is whole again
    // before any transcript resumes. Ordering is the contract — presence and
    // ownership first, transcript (driven from onOpen) after.
    for (const [instance, capability] of this.#instances) {
      this.#emit(CONTROL_LANE, REGISTER, { instance, capability });
    }
    for (const [instance, jobs] of this.#inFlight) {
      for (const jobKey of jobs) {
        this.#emit(CONTROL_LANE, CLAIM, { instance, jobKey });
      }
    }

    try {
      this.#onOpen?.();
    } catch (err) {
      this.#onError?.(err);
    }
  }

  #handleClose(): void {
    this.#socket = undefined;
    try {
      this.#onClose?.();
    } catch (err) {
      this.#onError?.(err);
    }
    if (this.#closed || !this.#autoReconnect) return;
    this.#scheduleReconnect();
  }

  /**
   * Schedule a reconnect through the injected scheduler. A re-entrancy guard
   * flattens recursion into iteration: while a reconnect is already running, a
   * nested request (e.g. `connect()` throwing again under a *synchronous*
   * scheduler) is coalesced into one more loop turn in {@link #runReconnect}
   * instead of a nested call, so repeated close→reconnect cycles cannot grow the
   * stack unboundedly regardless of the scheduler's timing.
   */
  #scheduleReconnect(): void {
    if (this.#closed || !this.#autoReconnect) return;
    if (this.#reconnectRunning) {
      this.#reconnectPending = true;
      return;
    }
    this.#schedule(() => this.#runReconnect());
  }

  #runReconnect(): void {
    if (this.#reconnectRunning) {
      this.#reconnectPending = true;
      return;
    }
    this.#reconnectRunning = true;
    try {
      do {
        this.#reconnectPending = false;
        this.#reconnect();
      } while (this.#reconnectPending && !this.#closed && this.#autoReconnect);
    } finally {
      this.#reconnectRunning = false;
    }
  }

  #reconnect(): void {
    if (this.#closed || this.#socket !== undefined) return;
    this.open();
  }

  /**
   * Encode and send one frame — but only if the negotiated peer can decode this
   * family. A family outside the shared subset (a legacy peer that never learned
   * `claim`/`release`) degrades to a silent no-op rather than an `unknown-family`
   * frame on the wire. A send/encode fault is routed to `onError`, never thrown.
   */
  #emit(lane: QosLane, family: MessageFamily, payload: unknown): void {
    if (!this.#negotiated.supportsFamily(family)) return;
    const socket = this.#socket;
    if (socket === undefined) return;
    const frame: Frame = { lane, family, seq: this.#nextSeq(), payload };
    try {
      socket.send(encodeFrame(frame));
    } catch (err) {
      this.#onError?.(err);
    }
  }

  #nextSeq(): number {
    const seq = this.#seq;
    this.#seq = this.#seq >= MAX_SEQ ? 0 : this.#seq + 1;
    return seq;
  }
}
