/**
 * The `relay` message family — S5's live-terminal relay, attached to the S1 hub
 * as its OWN module via the `registerFamilyHandler(family, handler)` seam. It
 * never edits a shared dispatch switch: {@link registerRelayFamily} claims the
 * `relay` family key (from the S0 {@link MESSAGE_FAMILIES} set) and the hub
 * derives routing from that registration.
 *
 * It composes the three S5 primitives:
 *  - {@link ReplayRing}      — per-stream resume-from-offset store,
 *  - {@link IncarnationFence} — fences stale producers off a stream,
 *  - {@link QosScheduler}    — per-consumer three-lane egress with credit-based
 *                              backpressure (bulk never blocks control).
 *
 * ## Relay sub-protocol (carried in the `relay` family payload)
 *
 * Inbound (peer → hub):
 *  - `{ op: "produce",   stream, incarnation, chunk }` — a producer appends a
 *    chunk; the hub assigns the authoritative offset and fences stale incarnations.
 *  - `{ op: "subscribe", stream, from?, credit? }`     — a consumer (re)attaches
 *    and resumes from `from` (default 0); the retained tail is replayed.
 *  - `{ op: "credit",    stream?, credit }`            — a consumer grants more
 *    bulk credit (backpressure).
 *
 * Outbound (hub → consumer):
 *  - a `data` frame is a pure S0 {@link RelayPayload} `{ stream, offset, chunk }`
 *    on the `bulk` lane;
 *  - a `subscribed` ack rides the `control` lane and reports `{ gap, nextOffset }`.
 */
import { MAX_SEQ } from "@nanobpm/agentic-protocol";
import type { Frame, MessageFamily, RelayPayload } from "@nanobpm/agentic-protocol";
import type { AgenticHub } from "@nanobpm/agentic-channel";
import { IncarnationFence } from "./incarnation.ts";
import { ReplayRing } from "./ring.ts";
import { QosScheduler } from "./scheduler.ts";

/** The relay family key, from the S0 canonical family set (the one source of truth). */
export const RELAY_FAMILY: MessageFamily = "relay";

/**
 * The minimal connection surface the relay module needs. It is a structural
 * subset of the hub's `HubConnection`, so the module is unit-testable with a
 * fake connection and needs no compile dependency on the hub's concrete type.
 */
export interface RelayConnection {
  readonly id: string;
  /** The shared registry — its `has(id)` is the liveness source of truth. */
  readonly registry: { has(id: string): boolean };
  /** Send one already-built frame back on this connection. */
  send(frame: Frame): void;
}

export interface RelayHubOptions {
  /** Retained chunks per stream (resume window). Default 1024. */
  readonly ringCapacity?: number;
  /** Max buffered bulk frames per consumer before oldest is shed. Default 1024. */
  readonly bulkCapacity?: number;
  /** Bulk credit a consumer starts with before it grants its own. Default 0. */
  readonly defaultCredit?: number;
  /** Notified when a producer frame is fenced as a stale incarnation. */
  readonly onFenced?: (stream: string, incarnation: number, current: number) => void;
  /** Notified of a malformed relay message or a send failure. */
  readonly onError?: (err: unknown, connectionId?: string) => void;
}

interface Subscriber {
  readonly conn: RelayConnection;
  readonly scheduler: QosScheduler;
  readonly streams: Set<string>;
  seq: number;
}

const DEFAULT_RING_CAPACITY = 1024;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function nonNegInt(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

/** A parsed, validated inbound relay message. */
type RelayInbound =
  | { readonly op: "produce"; readonly stream: string; readonly incarnation: number; readonly chunk: string }
  | { readonly op: "subscribe"; readonly stream: string; readonly from: number; readonly credit: number }
  | { readonly op: "credit"; readonly credit: number };

/**
 * The hub-side relay state machine: per-stream replay rings + incarnation fence,
 * and per-consumer QoS schedulers. Construct via {@link registerRelayFamily}, or
 * directly for unit testing and then drive with {@link RelayHub.handle}.
 */
export class RelayHub {
  readonly #rings = new Map<string, ReplayRing>();
  readonly #fence = new IncarnationFence();
  readonly #subscribers = new Map<string, Subscriber>();
  readonly #ringCapacity: number;
  readonly #bulkCapacity: number;
  readonly #defaultCredit: number;
  readonly #onFenced: RelayHubOptions["onFenced"];
  readonly #onError: RelayHubOptions["onError"];

  constructor(options: RelayHubOptions = {}) {
    this.#ringCapacity = options.ringCapacity ?? DEFAULT_RING_CAPACITY;
    this.#bulkCapacity = options.bulkCapacity ?? 1024;
    this.#defaultCredit = options.defaultCredit ?? 0;
    this.#onFenced = options.onFenced;
    this.#onError = options.onError;
  }

  /** Number of streams with a replay ring. */
  get streamCount(): number {
    return this.#rings.size;
  }

  /** Number of tracked consumer subscribers. */
  get subscriberCount(): number {
    return this.#subscribers.size;
  }

  /** The replay ring for a stream, if one exists (for inspection/tests). */
  ring(stream: string): ReplayRing | undefined {
    return this.#rings.get(stream);
  }

  /** The incarnation fence (for inspection/tests). */
  get fence(): IncarnationFence {
    return this.#fence;
  }

  /** Whether a connection currently has a subscriber record. */
  hasSubscriber(id: string): boolean {
    return this.#subscribers.has(id);
  }

  /**
   * Handle one inbound `relay` frame from `conn`. This is the function attached
   * to the hub's family seam; it is safe to call directly in tests.
   */
  handle(frame: Frame, conn: RelayConnection): void {
    this.#pruneDead();
    const msg = this.#parse(frame.payload);
    if (msg === null) {
      this.#onError?.(new RelayMessageError(frame.payload), conn.id);
      return;
    }
    switch (msg.op) {
      case "produce":
        this.#onProduce(msg.stream, msg.incarnation, msg.chunk);
        return;
      case "subscribe":
        this.#onSubscribe(conn, msg.stream, msg.from, msg.credit);
        return;
      case "credit":
        this.#onCredit(conn, msg.credit);
        return;
    }
  }

  #onProduce(stream: string, incarnation: number, chunk: string): void {
    if (!this.#fence.admit(stream, incarnation)) {
      this.#onFenced?.(stream, incarnation, this.#fence.current(stream) ?? incarnation);
      return;
    }
    const entry = this.#ringFor(stream).append(chunk);
    for (const sub of this.#subscribers.values()) {
      if (sub.streams.has(stream)) {
        this.#emitData(sub, stream, entry.offset, entry.chunk);
      }
    }
  }

  #onSubscribe(conn: RelayConnection, stream: string, from: number, credit: number): void {
    const sub = this.#subscriberFor(conn);
    sub.streams.add(stream);
    if (credit > 0) {
      sub.scheduler.grantCredit(credit);
    }
    const ring = this.#ringFor(stream);
    const slice = ring.since(from);
    // Control-lane ack: tells the consumer where the resume actually started and
    // whether it lost chunks (gap) — it rides ahead of the replayed bulk tail.
    this.#emit(sub, "control", {
      op: "subscribed",
      stream,
      gap: slice.gap,
      nextOffset: ring.nextOffset,
    });
    for (const entry of slice.entries) {
      this.#emitData(sub, stream, entry.offset, entry.chunk);
    }
  }

  #onCredit(conn: RelayConnection, credit: number): void {
    // A credit grant may arrive before subscribe (pre-loading the consumer's
    // budget); create the subscriber record so the credit is not lost.
    const sub = this.#subscriberFor(conn);
    sub.scheduler.grantCredit(credit);
  }

  #emitData(sub: Subscriber, stream: string, offset: number, chunk: string): void {
    const payload: RelayPayload = { stream, offset, chunk };
    this.#enqueue(sub, "bulk", payload);
  }

  #emit(sub: Subscriber, lane: Frame["lane"], payload: unknown): void {
    this.#enqueue(sub, lane, payload);
  }

  #enqueue(sub: Subscriber, lane: Frame["lane"], payload: unknown): void {
    const frame: Frame = { lane, family: RELAY_FAMILY, seq: sub.seq, payload };
    sub.seq = sub.seq >= MAX_SEQ ? 0 : sub.seq + 1;
    try {
      sub.scheduler.enqueue(frame);
    } catch (err) {
      this.#onError?.(err, sub.conn.id);
    }
  }

  #ringFor(stream: string): ReplayRing {
    let ring = this.#rings.get(stream);
    if (ring === undefined) {
      ring = new ReplayRing({ capacity: this.#ringCapacity });
      this.#rings.set(stream, ring);
    }
    return ring;
  }

  #subscriberFor(conn: RelayConnection): Subscriber {
    let sub = this.#subscribers.get(conn.id);
    if (sub === undefined) {
      sub = {
        conn,
        scheduler: new QosScheduler({
          sink: (frame) => conn.send(frame),
          credit: this.#defaultCredit,
          bulkCapacity: this.#bulkCapacity,
        }),
        streams: new Set(),
        seq: 0,
      };
      this.#subscribers.set(conn.id, sub);
    }
    return sub;
  }

  /**
   * Drop subscriber records whose connection is no longer live (the S1 registry
   * removed it on close). The hub does not surface a per-family close hook, so
   * the registry's `has(id)` is the liveness source of truth and cleanup is
   * lazy — run on every inbound frame.
   */
  #pruneDead(): void {
    for (const [id, sub] of this.#subscribers) {
      if (!sub.conn.registry.has(id)) {
        sub.scheduler.clear();
        this.#subscribers.delete(id);
      }
    }
  }

  #parse(payload: unknown): RelayInbound | null {
    if (!isPlainObject(payload)) {
      return null;
    }
    const op = payload.op;
    if (op === "produce") {
      if (!nonEmptyString(payload.stream) || !nonNegInt(payload.incarnation) || typeof payload.chunk !== "string") {
        return null;
      }
      return { op, stream: payload.stream, incarnation: payload.incarnation, chunk: payload.chunk };
    }
    if (op === "subscribe") {
      if (!nonEmptyString(payload.stream)) {
        return null;
      }
      const from = payload.from === undefined ? 0 : payload.from;
      if (!nonNegInt(from)) {
        return null;
      }
      const credit = payload.credit === undefined ? 0 : payload.credit;
      if (!nonNegInt(credit)) {
        return null;
      }
      return { op, stream: payload.stream, from, credit };
    }
    if (op === "credit") {
      if (!nonNegInt(payload.credit)) {
        return null;
      }
      return { op, credit: payload.credit };
    }
    return null;
  }
}

/** Raised (to `onError`) when an inbound relay payload does not match the sub-protocol. */
export class RelayMessageError extends Error {
  readonly payload: unknown;
  constructor(payload: unknown) {
    super("malformed relay message payload");
    this.name = "RelayMessageError";
    this.payload = payload;
  }
}

/**
 * Attach the `relay` family to a hub via the S1 registration seam and return the
 * {@link RelayHub} driving it. This is the canonical entry point; it does NOT
 * edit any shared dispatch switch — the hub derives routing from this
 * registration, and a second registration of `relay` is rejected by the seam.
 */
export function registerRelayFamily(hub: AgenticHub, options: RelayHubOptions = {}): RelayHub {
  const relay = new RelayHub(options);
  hub.registerFamilyHandler(RELAY_FAMILY, (frame, ctx) => {
    relay.handle(frame, ctx);
  });
  return relay;
}
