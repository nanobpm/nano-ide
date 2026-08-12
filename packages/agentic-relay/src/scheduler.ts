/**
 * The three-lane QoS scheduler — S5's outbound egress for one consumer socket.
 *
 * The channel carries three lanes in STRICT priority: control/facts >
 * interactive > bulk (invariant #5). The relay data plane is high-volume `bulk`
 * traffic; heartbeats, blackboard writes and relay control acks ride control /
 * interactive. The load-bearing guarantee: a bulk-output storm must NEVER
 * head-of-line-block a control or interactive frame.
 *
 * Two mechanisms enforce it:
 *
 *  1. **Strict lane priority.** {@link QosScheduler.flush} drains all control,
 *     then all interactive, then bulk. Control/interactive are never gated, so a
 *     queued heartbeat is emitted ahead of any bulk backlog. Cross-lane order is
 *     DERIVED from S0's {@link compareFrameOrder} (asserted in the tests).
 *
 *  2. **Credit-based backpressure on the bulk lane.** A slow consumer grants
 *     credit for how many bulk frames it can accept; the scheduler emits bulk
 *     only while credit remains. With zero credit, bulk buffers (bounded — see
 *     `bulkCapacity`) while control/interactive still flow freely. The buffered
 *     bulk tail is safe to shed because the {@link ReplayRing} retains it for a
 *     later resume-from-offset.
 */
import { compareFrameOrder, lanePriority } from "@nanobpm/agentic-protocol";
import type { Frame } from "@nanobpm/agentic-protocol";

export interface QosSchedulerOptions {
  /** Where drained frames are emitted (typically the connection's `send`). */
  readonly sink: (frame: Frame) => void;
  /** Initial bulk credit. Default 0 — bulk stays buffered until credit is granted. */
  readonly credit?: number;
  /**
   * Maximum buffered bulk frames before overflow sheds the oldest. Default 1024.
   * Shedding is safe: the replay ring retains evicted chunks for resume. Control
   * and interactive frames are never shed.
   */
  readonly bulkCapacity?: number;
}

const DEFAULT_BULK_CAPACITY = 1024;

export class QosScheduler {
  readonly #sink: (frame: Frame) => void;
  readonly #bulkCapacity: number;
  readonly #control: Frame[] = [];
  readonly #interactive: Frame[] = [];
  // The bulk lane is a fixed-size circular buffer: both overflow shedding and
  // credit-gated draining advance a head index in O(1)/O(k) rather than
  // Array.shift() (O(n) per frame). Under the sustained "bulk storm" this
  // scheduler exists to absorb, shift() would degrade to O(n²). Same eviction
  // discipline as ReplayRing: overwrite the oldest slot, advance the head.
  readonly #bulk: (Frame | undefined)[] = [];
  #bulkHead = 0;
  #bulkCount = 0;
  #credit: number;
  #shed = 0;

  constructor(options: QosSchedulerOptions) {
    if (options.credit !== undefined && (!Number.isInteger(options.credit) || options.credit < 0)) {
      throw new RangeError(`QosScheduler credit must be a non-negative integer, got ${options.credit}`);
    }
    const bulkCapacity = options.bulkCapacity ?? DEFAULT_BULK_CAPACITY;
    if (!Number.isInteger(bulkCapacity) || bulkCapacity < 1) {
      throw new RangeError(`QosScheduler bulkCapacity must be a positive integer, got ${bulkCapacity}`);
    }
    this.#sink = options.sink;
    this.#credit = options.credit ?? 0;
    this.#bulkCapacity = bulkCapacity;
    this.#bulk.length = bulkCapacity;
  }

  /** Remaining bulk credit. */
  get credit(): number {
    return this.#credit;
  }

  /** Frames buffered but not yet emitted (across all lanes). */
  get pending(): number {
    return this.#control.length + this.#interactive.length + this.#bulkCount;
  }

  /** Bulk frames buffered awaiting credit. */
  get pendingBulk(): number {
    return this.#bulkCount;
  }

  /** How many bulk frames have been shed on overflow over this scheduler's life. */
  get shed(): number {
    return this.#shed;
  }

  /**
   * Buffer a frame on its lane and drain what is now eligible. Control and
   * interactive frames drain immediately (never credit-gated); a bulk frame
   * drains only if credit is available, otherwise it waits (or sheds the oldest
   * bulk frame if the bulk buffer is full).
   */
  enqueue(frame: Frame): void {
    switch (frame.lane) {
      case "control":
        this.#control.push(frame);
        break;
      case "interactive":
        this.#interactive.push(frame);
        break;
      case "bulk":
        this.#pushBulk(frame);
        break;
    }
    this.flush();
  }

  /** Grant `n` more bulk credits, then drain any bulk frames that credit now allows. */
  grantCredit(n: number): void {
    if (!Number.isInteger(n) || n < 0) {
      throw new RangeError(`grantCredit requires a non-negative integer, got ${n}`);
    }
    this.#credit += n;
    this.flush();
  }

  /**
   * Drain eligible frames to the sink in strict lane priority: all control, then
   * all interactive, then bulk up to the available credit. Control/interactive
   * are never head-of-line-blocked by bulk backlog or exhausted credit.
   */
  flush(): void {
    // Remove eligible frames up-front, then emit. Removing before the sink call
    // preserves "remove before sink" semantics (a re-entrant flush() from within
    // sink() cannot re-emit an already-taken frame) and keeps the drain O(k) in
    // the number of frames actually emitted, not O(n²): repeated Array.shift()
    // is O(n) per element and degrades on a large bulk burst — exactly the storm
    // this scheduler exists to absorb.
    //
    // Guard each splice with a length check: enqueue() calls flush() on every
    // frame, so in the bulk-storm / zero-credit case the control and interactive
    // lanes are usually empty. splice(0) on an empty array still allocates a new
    // (empty) array, so skipping it keeps the empty-lane hot path allocation-free.
    if (this.#control.length > 0) {
      for (const frame of this.#control.splice(0)) {
        this.#sink(frame);
      }
    }
    if (this.#interactive.length > 0) {
      for (const frame of this.#interactive.splice(0)) {
        this.#sink(frame);
      }
    }
    const take = Math.min(this.#credit, this.#bulkCount);
    if (take > 0) {
      this.#credit -= take;
      const bulkFrames = this.#takeBulk(take);
      for (const bulkFrame of bulkFrames) {
        this.#sink(bulkFrame);
      }
    }
  }

  /** Discard every buffered frame (e.g. on subscriber teardown). */
  clear(): void {
    this.#control.length = 0;
    this.#interactive.length = 0;
    this.#bulk.fill(undefined);
    this.#bulkHead = 0;
    this.#bulkCount = 0;
  }

  /**
   * Append a bulk frame to the circular buffer, shedding the oldest buffered
   * bulk frame first when already at capacity (safe: the ReplayRing retains it
   * for resume). All O(1) — no Array.shift().
   */
  #pushBulk(frame: Frame): void {
    if (this.#bulkCount === this.#bulkCapacity) {
      this.#bulk[this.#bulkHead] = undefined;
      this.#bulkHead = (this.#bulkHead + 1) % this.#bulkCapacity;
      this.#bulkCount -= 1;
      this.#shed += 1;
    }
    this.#bulk[(this.#bulkHead + this.#bulkCount) % this.#bulkCapacity] = frame;
    this.#bulkCount += 1;
  }

  /** Remove and return the oldest `n` bulk frames from the circular buffer. */
  #takeBulk(n: number): Frame[] {
    const frames: Frame[] = [];
    for (let i = 0; i < n; i += 1) {
      const frame = this.#bulk[this.#bulkHead];
      this.#bulk[this.#bulkHead] = undefined;
      this.#bulkHead = (this.#bulkHead + 1) % this.#bulkCapacity;
      this.#bulkCount -= 1;
      if (frame !== undefined) {
        frames.push(frame);
      }
    }
    return frames;
  }
}

/**
 * Re-exported from S0 so callers reason about lane ordering from one source
 * rather than re-deriving priority. The scheduler's drain order (with unlimited
 * credit) is asserted equal to a stable sort by {@link compareFrameOrder}.
 */
export { compareFrameOrder, lanePriority };
