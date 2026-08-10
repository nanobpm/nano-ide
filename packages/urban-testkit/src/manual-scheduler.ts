// The deterministic timer + clock seam that makes a whole-app `settle()` possible.
//
// Urban's background loops (cron triggers, the instance-tracking reconciler) arm
// self-rescheduling timers through the injectable `SchedulerDeps` seam. In production
// that seam is backed by real `setTimeout`/`Date.now`; under the test kit it is backed
// by this `ManualScheduler`, which owns a single virtual clock so those loops advance
// only when the test author asks — never on wall-clock time.
//
// The firing semantics deliberately mirror the canonical `fakeScheduler` used across
// urban's own unit tests (`instance-tracking.test.ts`, `triggers.test.ts`): `advance`
// fires every timer due at or before the target time in ascending order, yielding a real
// macrotask (`flush`) between fires so each timer's async follow-on chain (find → engine →
// patch → re-arm) fully drains before the next timer fires. Keeping the same shape means a
// reconciler that is green under urban's tests behaves identically here.

import type { SchedulerDeps } from "@nanobpm/urban/runtime";

// A real-timer macrotask yield. Draining the microtask queue with `await Promise.resolve()`
// a fixed number of times is fragile — the reconcile chain (async find → async engine query →
// async update → re-arm) is arbitrarily deep. A single `setTimeout(0)` runs after *all*
// currently-queued microtasks, so it reliably drains the chain a fired timer kicks off.
const realSetTimeout: typeof setTimeout = globalThis.setTimeout;
const flush = (): Promise<void> => new Promise<void>((resolve) => realSetTimeout(resolve, 0));

interface ScheduledTimer {
  at: number;
  fn: () => void;
}

/** A `SchedulerDeps` backed by a virtual clock the test author advances explicitly. */
export interface ManualScheduler extends SchedulerDeps {
  /** Advance the virtual clock by `ms`, firing every timer due within the interval (in
   *  ascending order) and draining each timer's async follow-on before the next fires. */
  advance(ms: number): Promise<void>;
  /** Fire every timer already due at the current time (no clock movement), draining each
   *  timer's async follow-on. Returns the number of timers fired — a fixpoint signal for
   *  `settle()`: zero means nothing was pending. */
  fireDue(): Promise<number>;
  /** How many timers are currently armed (unfired). */
  pending(): number;
}

/** Create a {@link ManualScheduler} whose virtual clock starts at `epochMs` (default 0). */
export function createManualScheduler(epochMs = 0): ManualScheduler {
  let clock = epochMs;
  let seq = 0;
  const timers = new Map<number, ScheduledTimer>();

  // Fire the earliest timer due at or before `target`, if any; return whether one fired.
  async function fireNextDue(target: number): Promise<boolean> {
    let nextId = -1;
    let nextAt = Number.POSITIVE_INFINITY;
    for (const [id, t] of timers) {
      if (t.at <= target && t.at < nextAt) {
        nextAt = t.at;
        nextId = id;
      }
    }
    if (nextId < 0) return false;
    const t = timers.get(nextId);
    if (!t) return false;
    timers.delete(nextId);
    // Move the clock to the timer's due time so a callback reading `now()` sees the
    // instant it was scheduled for, not the interval's end.
    clock = t.at;
    t.fn();
    await flush();
    return true;
  }

  return {
    now: () => clock,
    setTimer: (fn, delayMs) => {
      const id = ++seq;
      // A non-finite/negative delay would otherwise arm a timer "in the past" and hot-loop;
      // clamp to fire at the current instant, matching the live scheduler's setTimeout(0).
      const at = clock + (Number.isFinite(delayMs) && delayMs > 0 ? delayMs : 0);
      timers.set(id, { at, fn });
      return id;
    },
    clearTimer: (handle) => {
      if (typeof handle === "number") timers.delete(handle);
    },
    pending: () => timers.size,
    fireDue: async () => {
      let fired = 0;
      while (await fireNextDue(clock)) fired += 1;
      return fired;
    },
    advance: async (ms) => {
      const target = clock + Math.max(0, ms);
      while (await fireNextDue(target)) {
        // keep firing until nothing is due within the interval
      }
      clock = target;
    },
  };
}
