// The injectable timer + clock seam shared by every background loop in urban (cron
// triggers, the instance-tracking reconciler). Keeping one definition here — rather
// than a copy per module — means a test's fake scheduler drives them all the same
// way, and the "clamp a far-future delay to setTimeout's 32-bit range" rule has a
// single home.

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
