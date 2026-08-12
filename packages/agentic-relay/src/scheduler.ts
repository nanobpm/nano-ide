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
import type { Frame, QosLane } from "@nanobpm/agentic-protocol";

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
  readonly #bulk: Frame[] = [];
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
  }

  /** Remaining bulk credit. */
  get credit(): number {
    return this.#credit;
  }

  /** Frames buffered but not yet emitted (across all lanes). */
  get pending(): number {
    return this.#control.length + this.#interactive.length + this.#bulk.length;
  }

  /** Bulk frames buffered awaiting credit. */
  get pendingBulk(): number {
    return this.#bulk.length;
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
    this.#bucketFor(frame.lane).push(frame);
    if (frame.lane === "bulk" && this.#bulk.length > this.#bulkCapacity) {
      this.#bulk.shift();
      this.#shed += 1;
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
    let frame = this.#control.shift();
    while (frame !== undefined) {
      this.#sink(frame);
      frame = this.#control.shift();
    }
    frame = this.#interactive.shift();
    while (frame !== undefined) {
      this.#sink(frame);
      frame = this.#interactive.shift();
    }
    while (this.#credit > 0 && this.#bulk.length > 0) {
      const bulkFrame = this.#bulk.shift();
      if (bulkFrame === undefined) {
        break;
      }
      this.#credit -= 1;
      this.#sink(bulkFrame);
    }
  }

  /** Discard every buffered frame (e.g. on subscriber teardown). */
  clear(): void {
    this.#control.length = 0;
    this.#interactive.length = 0;
    this.#bulk.length = 0;
  }

  #bucketFor(lane: QosLane): Frame[] {
    switch (lane) {
      case "control":
        return this.#control;
      case "interactive":
        return this.#interactive;
      case "bulk":
        return this.#bulk;
    }
  }
}

/**
 * Re-exported from S0 so callers reason about lane ordering from one source
 * rather than re-deriving priority. The scheduler's drain order (with unlimited
 * credit) is asserted equal to a stable sort by {@link compareFrameOrder}.
 */
export { compareFrameOrder, lanePriority };
