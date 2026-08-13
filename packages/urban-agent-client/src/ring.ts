import { QOS_LANES, compareFrameOrder } from "./protocol.ts";
import type { Frame, QosLane } from "./protocol.ts";

/**
 * The worker-side outbound buffer: a bounded, QoS-aware ring that holds frames
 * the worker has produced but not yet handed to the transport. It is the local
 * buffer / flush-on-reconnect store that gives the client its hub-down
 * tolerance (invariant #6) — the worker keeps producing while the hub is gone,
 * and drains in order when the channel comes back.
 *
 * Two properties are load-bearing:
 *
 *  1. **QoS drain order (invariant #5).** Frames drain in strict lane priority —
 *     `control` before `interactive` before `bulk` — and FIFO within a lane.
 *     A bulk-output storm can never head-of-line-block a queued heartbeat or
 *     blackboard write: the heartbeat rides the control lane and drains first.
 *     The ordering is DERIVED from S0's canonical {@link compareFrameOrder}, not
 *     re-specified here (see {@link toArray}'s invariant test).
 *
 *  2. **Overflow sheds the single least important frame.** When the ring is
 *     full, the next enqueue drops the lowest-priority frame among the buffer
 *     AND the incoming frame: the oldest frame from the lowest-priority
 *     non-empty lane is evicted (bulk before interactive before control) —
 *     UNLESS the incoming frame is itself strictly lower priority than
 *     everything buffered, in which case the incoming frame is dropped and the
 *     buffer is left untouched. A higher-priority buffered frame (e.g. control)
 *     is therefore never evicted to admit a lower-priority one (e.g. bulk):
 *     bulk/interactive traffic can never displace buffered control frames. This
 *     bounds memory during a long outage without ever losing liveness/
 *     coordination traffic to a relay storm.
 */
export interface OutboundRingOptions {
  /** Maximum number of buffered frames. Must be a positive integer. */
  readonly capacity: number;
}

export interface EnqueueResult {
  /**
   * The frame shed by this enqueue, or `null` if the ring had spare capacity.
   * Usually the oldest frame from the lowest-priority non-empty lane, evicted to
   * make room; but when the ring is full of strictly higher-priority frames the
   * INCOMING frame is itself the least important — it is dropped rather than
   * displace higher-priority traffic, and is returned here with the buffer left
   * unchanged.
   */
  readonly evicted: Frame | null;
}

// Lanes in strict priority order (highest first). Kept as a local const so the
// bucket walk is O(number-of-lanes) and independent of insertion.
const LANES_BY_PRIORITY: readonly QosLane[] = [...QOS_LANES];
const LANES_BY_EVICTION: readonly QosLane[] = [...QOS_LANES].reverse();

// Priority rank per lane (0 = highest), derived from the canonical QOS_LANES
// order so lane comparison has a single source of truth. A LARGER rank means
// lower priority (evicted sooner).
const LANE_RANK: ReadonlyMap<QosLane, number> = new Map(LANES_BY_PRIORITY.map((lane, index) => [lane, index]));

function laneRank(lane: QosLane): number {
  return LANE_RANK.get(lane) ?? Number.POSITIVE_INFINITY;
}

export class OutboundRing {
  readonly capacity: number;
  private readonly buckets: Map<QosLane, Frame[]>;
  private count = 0;

  constructor(options: OutboundRingOptions) {
    if (!Number.isInteger(options.capacity) || options.capacity < 1) {
      throw new RangeError(`OutboundRing capacity must be a positive integer, got ${options.capacity}`);
    }
    this.capacity = options.capacity;
    this.buckets = new Map(LANES_BY_PRIORITY.map((lane): [QosLane, Frame[]] => [lane, []]));
  }

  /** Number of frames currently buffered. */
  get size(): number {
    return this.count;
  }

  /** True when no frames are buffered. */
  get isEmpty(): boolean {
    return this.count === 0;
  }

  /**
   * Buffer a frame. When the ring is already at capacity, the least important
   * frame among the buffer and this one is shed (see {@link EnqueueResult.evicted}
   * and the class-level overflow contract).
   */
  enqueue(frame: Frame): EnqueueResult {
    return this.admit(frame, false);
  }

  /**
   * Buffer a frame at the FRONT of its lane (drains before frames already
   * queued in that lane). Used to make a reconnect's re-`register` precede any
   * backlog buffered during the outage. Overflow follows the same QoS-correct
   * policy as {@link enqueue}: the incoming frame is dropped rather than
   * displace strictly higher-priority buffered traffic.
   */
  enqueueFront(frame: Frame): EnqueueResult {
    return this.admit(frame, true);
  }

  /**
   * Shared admission path for {@link enqueue} / {@link enqueueFront}.
   *
   * Overflow is QoS-correct: when the ring is full we shed the single
   * least-important frame among the buffer ∪ the incoming frame. If the incoming
   * frame is strictly lower priority than every buffered frame, IT is the least
   * important, so it is dropped (and returned as `evicted`) and the buffer is
   * untouched — a bulk/interactive frame never evicts buffered control traffic.
   * Otherwise the oldest frame from the lowest-priority non-empty lane is
   * evicted to make room.
   */
  private admit(frame: Frame, toFront: boolean): EnqueueResult {
    const bucket = this.buckets.get(frame.lane);
    if (bucket === undefined) {
      throw new RangeError(`unknown QoS lane: ${String(frame.lane)}`);
    }
    let evicted: Frame | null = null;
    if (this.count >= this.capacity) {
      const victimLane = this.lowestNonEmptyLane();
      if (victimLane === undefined || laneRank(frame.lane) > laneRank(victimLane)) {
        // The incoming frame is the least important thing in play — drop it
        // rather than evict a higher-priority buffered frame.
        return { evicted: frame };
      }
      evicted = this.buckets.get(victimLane)?.shift() ?? null;
      if (evicted !== null) {
        this.count -= 1;
      }
    }
    if (toFront) {
      bucket.unshift(frame);
    } else {
      bucket.push(frame);
    }
    this.count += 1;
    return { evicted };
  }

  /** The next frame to drain (highest priority, oldest within its lane) without removing it. */
  peek(): Frame | undefined {
    for (const lane of LANES_BY_PRIORITY) {
      const bucket = this.buckets.get(lane);
      if (bucket !== undefined && bucket.length > 0) {
        return bucket[0];
      }
    }
    return undefined;
  }

  /** Remove and return the next frame to drain, or `undefined` when empty. */
  dequeue(): Frame | undefined {
    for (const lane of LANES_BY_PRIORITY) {
      const bucket = this.buckets.get(lane);
      if (bucket !== undefined && bucket.length > 0) {
        this.count -= 1;
        return bucket.shift();
      }
    }
    return undefined;
  }

  /** Non-destructive snapshot in drain order (priority lane, then FIFO). */
  toArray(): Frame[] {
    const out: Frame[] = [];
    for (const lane of LANES_BY_PRIORITY) {
      const bucket = this.buckets.get(lane);
      if (bucket !== undefined) {
        out.push(...bucket);
      }
    }
    return out;
  }

  /**
   * Remove every buffered frame matching `predicate`, returning the removed
   * frames. Used to coalesce superseded control frames (e.g. an in-flight
   * REGISTER replaced by a newer one) so the drain never emits a stale duplicate.
   */
  remove(predicate: (frame: Frame) => boolean): Frame[] {
    const removed: Frame[] = [];
    for (const lane of LANES_BY_PRIORITY) {
      const bucket = this.buckets.get(lane);
      if (bucket === undefined) {
        continue;
      }
      for (let i = bucket.length - 1; i >= 0; i--) {
        const frame = bucket[i];
        if (frame !== undefined && predicate(frame)) {
          removed.push(frame);
          bucket.splice(i, 1);
          this.count -= 1;
        }
      }
    }
    return removed;
  }

  /** Discard all buffered frames. */
  clear(): void {
    for (const bucket of this.buckets.values()) {
      bucket.length = 0;
    }
    this.count = 0;
  }

  private lowestNonEmptyLane(): QosLane | undefined {
    for (const lane of LANES_BY_EVICTION) {
      const bucket = this.buckets.get(lane);
      if (bucket !== undefined && bucket.length > 0) {
        return lane;
      }
    }
    return undefined;
  }
}

/**
 * The canonical drain comparator, re-exported from S0 so callers that need to
 * reason about ordering derive it from one source rather than re-implementing
 * lane priority. {@link OutboundRing.toArray} is asserted equal to sorting by
 * this comparator in the ring's tests.
 */
export { compareFrameOrder };
