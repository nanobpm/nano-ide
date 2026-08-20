// The injectable timer + clock seam shared by every background loop in urban (cron
// triggers, the instance-tracking reconciler) and the app clock/`wait` seam handed to
// worker handlers. Keeping one definition here — rather than a copy per module — means a
// test's fake scheduler drives them all the same way, and the "clamp a far-future delay to
// setTimeout's 32-bit range" rule has a single home.

/** Injectable timer + clock seam so background scheduling is deterministic under test. */
export interface SchedulerDeps {
  setTimer: (fn: () => void, delayMs: number) => unknown;
  clearTimer: (handle: unknown) => void;
  /** Current wall-clock time in ms since epoch. */
  now: () => number;
}

/** Max delay a single `setTimeout` honours before its 32-bit signed overflow (~24.8 days). */
export const MAX_TIMER_DELAY_MS = 2_147_483_647;

function isTimerHandle(handle: unknown): handle is ReturnType<typeof setTimeout> {
  return typeof handle === "number" || (typeof handle === "object" && handle !== null);
}

/** Default (live) scheduler seam, backed by the global timer functions. */
export function defaultScheduler(): SchedulerDeps {
  return {
    setTimer: (fn, ms) => globalThis.setTimeout(fn, ms),
    clearTimer: (h) => {
      if (isTimerHandle(h)) globalThis.clearTimeout(h);
    },
    now: () => Date.now(),
  };
}

/**
 * The app-facing clock/`wait` seam handed to handlers (see `AppApi.now`/`AppApi.wait`).
 * A narrow read-only projection of a {@link SchedulerDeps}: `now()` reads its clock and
 * `wait(ms)` sleeps on its timer. Real wall clock + real timers in production; the
 * virtual clock under the test kit — so time-bounded worker work advances with
 * `advanceTime()` instead of burning real wall-time.
 */
export interface AppClock {
  /** Current time in ms since epoch on the scheduler's clock. */
  now(): number;
  /** Resolve after `ms` have elapsed on the scheduler's clock (armed via its timer seam). */
  wait(ms: number): Promise<void>;
}

/**
 * Derive the app clock/`wait` seam from a scheduler — the single canonical mapping from the
 * runtime's injectable timer seam to the surface handlers use, so worker/trigger/surface
 * handlers doing time-bounded work share the same clock as the background loops (no drift
 * between a handler's budget and the engine's timers). A non-positive/non-finite `wait`
 * delay clamps to fire at the current instant, mirroring the scheduler's own `setTimer`
 * clamp.
 */
export function schedulerClock(sched: SchedulerDeps): AppClock {
  return {
    now: () => sched.now(),
    wait: (ms) =>
      new Promise<void>((resolve) => {
        sched.setTimer(() => resolve(), Number.isFinite(ms) && ms > 0 ? ms : 0);
      }),
  };
}
