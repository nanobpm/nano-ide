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
 *  2. **Overflow drops the least important frame.** When the ring is full, the
 *     next enqueue evicts the oldest frame from the LOWEST-priority non-empty
 *     lane (bulk, then interactive, then control). Bulk backlog is shed first;
 *     a control-lane frame is only ever dropped when nothing less important is
 *     buffered. This bounds memory during a long outage without silently losing
 *     liveness/coordination traffic to a relay storm.
 */
export interface OutboundRingOptions {
  /** Maximum number of buffered frames. Must be a positive integer. */
  readonly capacity: number;
}

export interface EnqueueResult {
  /** The frame evicted to make room, or `null` if the ring had spare capacity. */
  readonly evicted: Frame | null;
}

// Lanes in strict priority order (highest first). Kept as a local const so the
// bucket walk is O(number-of-lanes) and independent of insertion.
const LANES_BY_PRIORITY: readonly QosLane[] = [...QOS_LANES];
const LANES_BY_EVICTION: readonly QosLane[] = [...QOS_LANES].reverse();

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
   * Buffer a frame. When the ring is already at capacity, the oldest frame from
   * the lowest-priority non-empty lane is evicted first (bulk before
   * interactive before control) and returned in {@link EnqueueResult.evicted}.
   */
  enqueue(frame: Frame): EnqueueResult {
    let evicted: Frame | null = null;
    if (this.count >= this.capacity) {
      evicted = this.evictLowest();
    }
    const bucket = this.buckets.get(frame.lane);
    if (bucket === undefined) {
      // Restore the just-evicted frame rather than lose it to a bad lane.
      if (evicted !== null) {
        this.buckets.get(evicted.lane)?.unshift(evicted);
        this.count += 1;
      }
      throw new RangeError(`unknown QoS lane: ${String(frame.lane)}`);
    }
    bucket.push(frame);
    this.count += 1;
    return { evicted };
  }

  /**
   * Buffer a frame at the FRONT of its lane (drains before frames already
   * queued in that lane). Used to make a reconnect's re-`register` precede any
   * backlog buffered during the outage. Overflow still evicts the
   * lowest-priority oldest frame.
   */
  enqueueFront(frame: Frame): EnqueueResult {
    let evicted: Frame | null = null;
    if (this.count >= this.capacity) {
      evicted = this.evictLowest();
    }
    const bucket = this.buckets.get(frame.lane);
    if (bucket === undefined) {
      if (evicted !== null) {
        this.buckets.get(evicted.lane)?.unshift(evicted);
        this.count += 1;
      }
      throw new RangeError(`unknown QoS lane: ${String(frame.lane)}`);
    }
    bucket.unshift(frame);
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

  private evictLowest(): Frame | null {
    for (const lane of LANES_BY_EVICTION) {
      const bucket = this.buckets.get(lane);
      if (bucket !== undefined && bucket.length > 0) {
        this.count -= 1;
        return bucket.shift() ?? null;
      }
    }
    return null;
  }
}

/**
 * The canonical drain comparator, re-exported from S0 so callers that need to
 * reason about ordering derive it from one source rather than re-implementing
 * lane priority. {@link OutboundRing.toArray} is asserted equal to sorting by
 * this comparator in the ring's tests.
 */
export { compareFrameOrder };
