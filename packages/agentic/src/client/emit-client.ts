/**
 * The client-side ownership-frame emit client — the emit-side counterpart of the
 * protocol keystone (#543 shipped the `claim`/`release` families + server read;
 * this ships the blessed client that *emits* them).
 *
 * One {@link AgenticEmitClient} owns a SINGLE multiplexed host connection that N
 * distinct instances share, and emits the presence/ownership/transcript frames
 * with an EXPLICIT `instance` per frame — never inferred from the connection id.
 * That explicit tagging is what lets one supervisor connection multiplex the
 * frames of N workers, and is why the harness (jwulf/c8ctl-plugin-nano#160) can
 * stop hand-rolling a parallel client-ownership layer out of `protocol/frame` +
 * `protocol/payloads` primitives (the drift surface AGENTS.md forbids). The
 * client is co-located with the frame definitions it emits — single source of
 * truth, no cross-package drift.
 *
 * Guarantees:
 *  - **Multiplex** — `register`/`heartbeat`/`deregister`, `claim`/`release`, and
 *    a `transcript` sink, each carrying `instance` explicitly, over one socket.
 *    Multiplexing more than one instance requires the peer to negotiate the
 *    `multi-instance` feature; against a peer that hasn't (including after a
 *    downgrade), every outbound instance-tagged frame for a non-primary instance
 *    degrades to a no-op + `onError` so a legacy peer never misattributes it.
 *  - **Idempotent ownership** — `claim`/`release` are safe to re-assert; the
 *    reconnect resync re-asserts every in-flight claim.
 *  - **Reconnect resync** — on every (re)connect the client re-`register`s all
 *    instances and re-`claim`s all in-flight jobs BEFORE resuming transcript, so
 *    a hub that lost the connection's presence recovers the full ownership set.
 *  - **Per-instance transcript isolation** — transcript streams are namespaced
 *    by `instance`, so two instances' identically-named streams never cross.
 *  - **Additive / version-negotiated** — every emit is gated on the negotiated
 *    shared protocol; against a legacy peer that never learned a family/feature
 *    the corresponding emit degrades to a no-op rather than sending an
 *    undecodable frame.
 *
 * Like the cockpit relay client, transport and scheduling are injected (a
 * {@link HostSocketFactory} + a {@link ResyncScheduler}), so the whole
 * reconnect→resync path runs deterministically in tests with a fake socket and a
 * manual scheduler — no real timers, no real network (AGENTS.md: no flaky tests).
 */
import { encodeFrame, decodeFrame, MAX_SEQ } from "../protocol/index.ts";
import type { Frame, Capability, MessageFamily } from "../protocol/index.ts";
import {
  LOCAL_ADVERTISEMENT,
  negotiate,
  type NegotiatedProtocol,
  type ProtocolAdvertisement,
} from "../protocol/index.ts";

/**
 * The minimal transport surface the client drives. A browser `WebSocket`, a
 * `ws` socket, or an in-memory test double all adapt to this — the client only
 * needs to push binary frames and observe open/close/message.
 */
export interface HostSocket {
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

/** Opens a fresh multiplexed host socket. Called once per (re)connect. */
export type HostSocketFactory = () => HostSocket;

/** Schedules a reconnect attempt. Injected so tests can run it synchronously. */
export type ResyncScheduler = (run: () => void) => void;

/** The character separating an instance from its stream name on the wire. Using
 * the ASCII unit separator (rare in payloads) keeps the composed key readable;
 * the per-instance isolation guarantee itself comes from {@link encodeKeyPart}
 * escaping the separator (and its own escape char) out of both components before
 * the join, so the separator can never appear inside either part. */
export const TRANSCRIPT_STREAM_SEPARATOR = "\u001f";

/** The escape char {@link encodeKeyPart} uses to make the join injective. */
const TRANSCRIPT_STREAM_ESCAPE = "\\";

/** Escape a key component so it contains neither the separator nor the escape
 * char verbatim, making {@link transcriptStreamKey} injective on `(instance,
 * stream)` even when a component itself contains the separator. The escape char
 * is doubled and the separator is rendered as `\u`, so distinct inputs always
 * yield distinct encodings. */
function encodeKeyPart(part: string): string {
  return part
    .replaceAll(TRANSCRIPT_STREAM_ESCAPE, `${TRANSCRIPT_STREAM_ESCAPE}${TRANSCRIPT_STREAM_ESCAPE}`)
    .replaceAll(TRANSCRIPT_STREAM_SEPARATOR, `${TRANSCRIPT_STREAM_ESCAPE}u`);
}

/** Compose the on-wire relay stream for an instance's logical transcript stream.
 * Both components are escaped ({@link encodeKeyPart}) before joining so the
 * separator can never leak in from a payload — this injective join is the
 * per-instance isolation guarantee. */
export function transcriptStreamKey(instance: string, stream: string): string {
  return `${encodeKeyPart(instance)}${TRANSCRIPT_STREAM_SEPARATOR}${encodeKeyPart(stream)}`;
}

export interface AgenticEmitClientOptions {
  /** Opens a fresh multiplexed host socket for each (re)connect. */
  readonly connect: HostSocketFactory;
  /** This build's own advertisement. Defaults to {@link LOCAL_ADVERTISEMENT}. */
  readonly local?: ProtocolAdvertisement;
  /** The peer's advertisement, exchanged at the handshake. Until known, the
   * client negotiates against its own advertisement (all local families/features
   * assumed supported); call {@link AgenticEmitClient.applyRemoteAdvertisement}
   * once the real one arrives to degrade unsupported emits to no-ops. */
  readonly remote?: ProtocolAdvertisement | unknown;
  /** Fired on every (re)connect AFTER the resync frames have been emitted. */
  readonly onResync?: () => void;
  /** Fired when the socket drops (before a reconnect is scheduled). */
  readonly onClose?: () => void;
  /** Receives every decoded inbound frame (e.g. `serve`/`demand`). */
  readonly onFrame?: (frame: Frame) => void;
  /** Notified of a decode/dispatch/send error. */
  readonly onError?: (err: unknown) => void;
  /** Reconnect scheduler. Default `setTimeout(run, 0)`. */
  readonly schedule?: ResyncScheduler;
  /** Reconnect automatically on close. Default true. */
  readonly autoReconnect?: boolean;
}

const CONTROL_LANE: Frame["lane"] = "control";
const BULK_LANE: Frame["lane"] = "bulk";

function defaultSchedule(run: () => void): void {
  setTimeout(run, 0);
}

interface InstanceState {
  capability: Capability;
  /** In-flight job keys this instance owns — re-claimed verbatim on reconnect. */
  readonly claims: Set<string>;
}

/**
 * One multiplexed host connection shared by N instances. Construct once per
 * supervisor process; {@link register} each instance, drive its lifecycle with
 * {@link heartbeat} / {@link claim} / {@link release} / {@link transcript}, and
 * {@link deregister} on departure. {@link open} the socket to start; the client
 * reconnects and re-asserts the full presence+ownership set automatically.
 */
export class AgenticEmitClient {
  readonly #connect: HostSocketFactory;
  readonly #local: ProtocolAdvertisement;
  readonly #onResync: AgenticEmitClientOptions["onResync"];
  readonly #onClose: AgenticEmitClientOptions["onClose"];
  readonly #onFrame: AgenticEmitClientOptions["onFrame"];
  readonly #onError: AgenticEmitClientOptions["onError"];
  readonly #schedule: ResyncScheduler;
  readonly #autoReconnect: boolean;
  readonly #instances = new Map<string, InstanceState>();
  #negotiated: NegotiatedProtocol;
  #socket: HostSocket | undefined;
  #seq = 0;
  /** Producer generation, bumped on every (re)connect so a hub fences a stale
   * predecessor: a resumed transcript takes over with a strictly higher
   * incarnation than the connection that dropped. */
  #generation = 0;
  #closed = false;

  constructor(options: AgenticEmitClientOptions) {
    this.#connect = options.connect;
    this.#local = options.local ?? LOCAL_ADVERTISEMENT;
    this.#onResync = options.onResync;
    this.#onClose = options.onClose;
    this.#onFrame = options.onFrame;
    this.#onError = options.onError;
    this.#schedule = options.schedule ?? defaultSchedule;
    this.#autoReconnect = options.autoReconnect ?? true;
    // Only an ABSENT remote (`undefined`) means "peer unknown — negotiate
    // optimistically against our own advertisement until the real one arrives".
    // An explicit `remote` (including `null` or any malformed value) is passed
    // straight through to the garbage-tolerant negotiate() — consistent with
    // applyRemoteAdvertisement() — so a caller that hands us `null` safely
    // degrades to the shared subset instead of assuming full peer support and
    // emitting frames the peer can't decode.
    this.#negotiated = negotiate(this.#local, options.remote === undefined ? this.#local : options.remote);
  }

  /** True once {@link close} has been called (no further reconnects). */
  get isClosed(): boolean {
    return this.#closed;
  }

  /** The shared protocol currently in force. Emits for a family/feature outside
   * this set degrade to no-ops. */
  get negotiated(): NegotiatedProtocol {
    return this.#negotiated;
  }

  /** The current producer generation (incarnation) — bumped on each connect. */
  get generation(): number {
    return this.#generation;
  }

  /** The set of instances currently registered on this connection. */
  instances(): readonly string[] {
    return [...this.#instances.keys()];
  }

  /** The in-flight job keys an instance currently owns. */
  claimsOf(instance: string): readonly string[] {
    const state = this.#instances.get(instance);
    return state ? [...state.claims] : [];
  }

  /**
   * Re-negotiate against a (possibly untrusted / future / legacy) peer
   * advertisement. Recomputes the shared subset; emits for families/features the
   * peer lacks become no-ops from here on. Safe to call at any time (e.g. from a
   * handshake frame).
   */
  applyRemoteAdvertisement(remote: ProtocolAdvertisement | unknown): NegotiatedProtocol {
    this.#negotiated = negotiate(this.#local, remote);
    if (this.#instances.size > 1 && !this.#negotiated.supportsFeature("multi-instance")) {
      this.#onError?.(
        this.#multiInstanceUnsupportedError(`the ${this.#instances.size} instances already registered on this connection`),
      );
    }
    return this.#negotiated;
  }

  /** Open the first socket and wire its lifecycle. Idempotent while connected. */
  open(): void {
    if (this.#closed || this.#socket !== undefined) return;
    let socket: HostSocket;
    try {
      socket = this.#connect();
    } catch (err) {
      this.#onError?.(err);
      if (!this.#closed && this.#autoReconnect) this.#schedule(() => this.#reconnect());
      return;
    }
    this.#socket = socket;
    socket.onMessage((bytes) => this.#receive(bytes));
    socket.onOpen(() => this.#resync());
    socket.onClose(() => this.#handleClose());
  }

  /**
   * Enrol an instance on the shared connection and emit its `register` frame.
   * Re-registering an already-known instance updates its capability (its
   * in-flight claims are preserved). The instance is tracked so a reconnect can
   * re-assert it.
   *
   * If the peer never negotiated `multi-instance`, registering a SECOND distinct
   * instance degrades to a no-op (surfaced via {@link AgenticEmitClientOptions.onError}):
   * the peer can only attribute one instance per connection, so emitting the
   * second `register` would make it misattribute/overwrite the instance it
   * already knows. This mirrors how every other emit outside the negotiated set
   * degrades to a no-op; the caller must open a separate connection for the
   * extra instance.
   */
  register(instance: string, capability: Capability): void {
    const existing = this.#instances.get(instance);
    if (existing === undefined && this.#instances.size >= 1 && !this.#negotiated.supportsFeature("multi-instance")) {
      // The peer negotiated away `multi-instance`, so it can't uphold
      // per-instance presence/ownership for more than one worker on this shared
      // connection. Emitting a second `register` would make the peer
      // misattribute/overwrite the single instance it knows about, so degrade to
      // a no-op — consistent with every other emit outside the negotiated set —
      // and surface the contract violation (non-fatal) so the caller can open a
      // separate connection for the extra instance.
      this.#onError?.(this.#multiInstanceUnsupportedError(`multiplexing a second instance ${JSON.stringify(instance)}`));
      return;
    }
    if (existing) {
      this.#instances.set(instance, { capability, claims: existing.claims });
    } else {
      this.#instances.set(instance, { capability, claims: new Set<string>() });
    }
    if (this.#gateInstanceOffWire(instance)) return;
    this.#emit("register", CONTROL_LANE, { instance, capability });
  }

  /** Build the (non-fatal, onError-surfaced) error raised when this connection
   * is asked to carry multiple instances but the peer never negotiated the
   * `multi-instance` feature — the peer can't uphold per-instance semantics, so
   * continuing risks ambiguous presence/ownership attribution. Surfaced, not
   * thrown, so a legacy path degrades with a signal instead of hard-crashing. */
  #multiInstanceUnsupportedError(context: string): Error {
    return new Error(
      `peer has not negotiated the "multi-instance" feature; ${context} risks ambiguous per-instance presence/ownership attribution on this shared connection`,
    );
  }

  /**
   * Whether frames tagged for `instance` may go on the wire. When the peer has
   * negotiated `multi-instance` every instance is allowed. Otherwise — including
   * after {@link applyRemoteAdvertisement} downgrades a connection that already
   * multiplexed several instances — only the PRIMARY (first-registered) instance
   * may emit: a legacy peer attributes every instance-tagged frame to the single
   * instance it can track, so a frame for any other instance would
   * misattribute/overwrite its presence/ownership. This is the single source of
   * truth for the outbound multi-instance gate — both the public emit methods and
   * the reconnect resync derive their gating from it, so the two never drift.
   */
  #instanceAllowedOnWire(instance: string): boolean {
    if (this.#negotiated.supportsFeature("multi-instance")) return true;
    const primary = this.#instances.keys().next().value;
    return primary === undefined || primary === instance;
  }

  /** Gate an instance-tagged emit off the wire when {@link #instanceAllowedOnWire}
   * forbids it, surfacing the (non-fatal) contract violation via onError — the
   * same degrade-to-no-op strategy as {@link register}. Returns `true` when the
   * caller must skip the emit. */
  #gateInstanceOffWire(instance: string): boolean {
    if (this.#instanceAllowedOnWire(instance)) return false;
    this.#onError?.(
      this.#multiInstanceUnsupportedError(`emitting an instance-tagged frame for a second instance ${JSON.stringify(instance)}`),
    );
    return true;
  }

  /** Emit a liveness `heartbeat` for a registered instance. */
  heartbeat(instance: string): void {
    if (this.#gateInstanceOffWire(instance)) return;
    this.#emit("heartbeat", CONTROL_LANE, { instance });
  }

  /**
   * Withdraw an instance from the connection and emit its `deregister` frame.
   * Drops the instance and its tracked claims so a subsequent reconnect no longer
   * re-asserts them.
   */
  deregister(instance: string, reason?: string): void {
    // Compute the gate BEFORE untracking, so deregistering the primary itself is
    // not misclassified as a second-instance emit once it leaves the map.
    const gated = this.#gateInstanceOffWire(instance);
    this.#instances.delete(instance);
    if (gated) return;
    const payload = reason === undefined ? { instance } : { instance, reason };
    this.#emit("deregister", CONTROL_LANE, payload);
  }

  /**
   * Assert that `instance` OWNS `jobKey`. Idempotent — re-claiming an already
   * owned job re-emits the (idempotent) frame; the claim is tracked so a
   * reconnect re-asserts it. A `claim` for an unregistered instance still emits
   * but is not tracked for resync.
   */
  claim(instance: string, jobKey: string): void {
    if (this.#gateInstanceOffWire(instance)) return;
    this.#instances.get(instance)?.claims.add(jobKey);
    this.#emit("claim", CONTROL_LANE, { instance, jobKey });
  }

  /**
   * Release `instance`'s ownership of `jobKey`. Idempotent — releasing an
   * unheld job is a no-op re-assertion. Drops the claim from the resync set.
   */
  release(instance: string, jobKey: string): void {
    if (this.#gateInstanceOffWire(instance)) return;
    this.#instances.get(instance)?.claims.delete(jobKey);
    this.#emit("release", CONTROL_LANE, { instance, jobKey });
  }

  /**
   * Append `chunk` to an instance's transcript `stream`. The wire stream is
   * namespaced by `instance` ({@link transcriptStreamKey}) so two instances'
   * identically-named streams never cross, and stamped with the current
   * {@link generation} as its producer incarnation so a reconnect fences the
   * stale predecessor.
   */
  transcript(instance: string, stream: string, chunk: string): void {
    if (this.#gateInstanceOffWire(instance)) return;
    this.#emit("relay", BULK_LANE, {
      op: "produce",
      stream: transcriptStreamKey(instance, stream),
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

  /**
   * On every (re)connect: bump the producer generation, then re-assert the full
   * presence+ownership set — every instance's `register`, then every in-flight
   * `claim` — BEFORE any transcript resumes. The strict order (presence →
   * ownership → transcript) is what lets a hub that lost this connection recover
   * before a single transcript byte references an instance it hasn't re-seen.
   */
  #resync(): void {
    this.#generation += 1;
    for (const [instance, state] of this.#instances) {
      // Skip instances the peer can no longer attribute (post-downgrade): re-
      // asserting a non-primary instance on the wire is the very misattribution
      // the outbound gate exists to prevent. Silent here — the caller was already
      // signalled at register/downgrade time; a resync is internal machinery.
      if (!this.#instanceAllowedOnWire(instance)) continue;
      this.#emit("register", CONTROL_LANE, { instance, capability: state.capability });
    }
    for (const [instance, state] of this.#instances) {
      if (!this.#instanceAllowedOnWire(instance)) continue;
      for (const jobKey of state.claims) {
        this.#emit("claim", CONTROL_LANE, { instance, jobKey });
      }
    }
    try {
      this.#onResync?.();
    } catch (err) {
      this.#onError?.(err);
    }
  }

  #emit(family: MessageFamily, lane: Frame["lane"], payload: unknown): void {
    // Version negotiation: never send a family the far end can't decode. A
    // legacy peer that never learned `claim`/`release` (or the gating feature)
    // degrades this emit to a no-op instead of a protocol error.
    if (!this.#negotiated.supportsFamily(family)) return;
    if ((family === "claim" || family === "release") && !this.#negotiated.supportsFeature("claim-release")) {
      return;
    }
    const socket = this.#socket;
    if (socket === undefined) return;
    const frame: Frame = { lane, family, seq: this.#nextSeq(), payload };
    let bytes: Uint8Array;
    try {
      bytes = encodeFrame(frame);
    } catch (err) {
      this.#onError?.(err);
      return;
    }
    try {
      socket.send(bytes);
    } catch (err) {
      this.#onError?.(err);
    }
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
    try {
      this.#onFrame?.(frame);
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
    this.#schedule(() => this.#reconnect());
  }

  #reconnect(): void {
    if (this.#closed || this.#socket !== undefined) return;
    this.open();
  }
}
