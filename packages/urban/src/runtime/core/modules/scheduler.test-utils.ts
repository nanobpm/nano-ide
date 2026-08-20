// Shared test-only fake for the injectable {@link SchedulerDeps} timer/clock seam. A single
// canonical virtual-clock scheduler for every time-based test (workers, triggers, the
// instance-tracking reconciler) so their virtual-time behavior can't drift apart — the drift
// surface three per-file copies used to create. Excluded from the published build via the
// `**/*.test-utils.ts` rule in tsconfig.build.json.

import type { SchedulerDeps } from "./scheduler.ts";

// A real-timer flush drains the entire pending microtask chain each time a fake timer fires —
// deeper than a fixed number of `await Promise.resolve()`s, so an async follow-on chain (find →
// engine → update, or a worker loop's next iteration) fully settles before the next timer fires.
const realSetTimeout = globalThis.setTimeout;
const flush = (): Promise<void> => new Promise<void>((resolve) => realSetTimeout(resolve, 0));

/** A deterministic virtual-clock {@link SchedulerDeps}: timers fire only when the clock is advanced
 *  past their deadline. `advance(ms)` fires every timer due within the interval in order, draining
 *  microtasks between fires so an async loop's follow-on chain settles before the next fire, then
 *  parks the clock at the target. `pending()` reports the number of armed timers. A non-positive /
 *  non-finite delay clamps to fire at the current instant, mirroring the production
 *  `schedulerClock` / `setTimer` clamp. Lets a test bound time-based work over virtual time without
 *  touching the real wall clock. */
export function fakeScheduler(
  startMs = 0,
): SchedulerDeps & { advance: (ms: number) => Promise<void>; pending: () => number } {
  let clock = startMs;
  let seq = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  return {
    now: () => clock,
    setTimer: (fn, delayMs) => {
      const id = ++seq;
      timers.set(id, { at: clock + (Number.isFinite(delayMs) && delayMs > 0 ? delayMs : 0), fn });
      return id;
    },
    clearTimer: (h) => {
      if (typeof h === "number") timers.delete(h);
    },
    pending: () => timers.size,
    advance: async (ms) => {
      const target = clock + Math.max(0, ms);
      // Fire due timers one at a time; a timer's callback may schedule a new one.
      for (;;) {
        let nextId = -1;
        let nextAt = Number.POSITIVE_INFINITY;
        for (const [id, t] of timers) {
          if (t.at <= target && t.at < nextAt) {
            nextAt = t.at;
            nextId = id;
          }
        }
        if (nextId < 0) break;
        const t = timers.get(nextId);
        if (!t) break;
        timers.delete(nextId);
        clock = t.at;
        t.fn();
        await flush();
      }
      clock = target;
    },
  };
}
