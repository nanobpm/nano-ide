/**
 * Generation / incarnation fencing for relay streams.
 *
 * A relay stream (e.g. a worker's terminal) may be produced by a succession of
 * incarnations: a worker restarts, a job is retried on a fresh runner, a new
 * process takes over the same logical stream. Each producer stamps its frames
 * with an `incarnation` (a monotonically increasing generation number). Once a
 * newer incarnation has taken over a stream, frames from an older incarnation
 * are STALE and must be fenced off — otherwise a zombie producer could interleave
 * bytes into a stream a live successor now owns, corrupting the transcript.
 *
 * The fence keeps, per stream, the highest incarnation seen so far and admits a
 * frame only when its incarnation is `>=` that high-water mark. A strictly
 * higher incarnation advances the mark (the takeover); a strictly lower one is
 * fenced. This mirrors the classic storage/leader fencing token pattern.
 */
import { isNonNegInt } from "./validate.ts";

export class IncarnationFence {
  readonly #current = new Map<string, number>();

  /** The current (highest admitted) incarnation for `stream`, or `undefined`. */
  current(stream: string): number | undefined {
    return this.#current.get(stream);
  }

  /**
   * Decide whether a producer at `incarnation` may write to `stream`.
   *
   * Returns `true` and advances the high-water mark when `incarnation` is `>=`
   * the current mark (a first producer, the same producer, or a takeover by a
   * newer one). Returns `false` — fenced — when `incarnation` is strictly lower
   * than a mark already established by a newer incarnation, leaving the mark
   * untouched.
   */
  admit(stream: string, incarnation: number): boolean {
    if (!isNonNegInt(incarnation)) {
      throw new RangeError(`incarnation must be a non-negative integer, got ${incarnation}`);
    }
    const mark = this.#current.get(stream);
    if (mark !== undefined && incarnation < mark) {
      return false;
    }
    if (mark === undefined || incarnation > mark) {
      this.#current.set(stream, incarnation);
    }
    return true;
  }

  /** Forget a stream's incarnation mark (e.g. when the stream is fully torn down). */
  forget(stream: string): void {
    this.#current.delete(stream);
  }
}
