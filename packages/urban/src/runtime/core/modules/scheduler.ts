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
  /** Optional shutdown signal. When it aborts, a pending {@link schedulerClock} `wait()` clears its
   *  armed timer and rejects, so a handler parked on the (virtual) clock unwinds at teardown instead
   *  of wedging whoever awaits it. Under the test kit this is the engine's shutdown signal: a worker
   *  handler parked on `app.wait()` sits on a virtual timer that no `advanceTime` will fire during
   *  `engine.close()`, so without this its promise never settles and `close()` hangs (the issue #446
   *  follow-up — the virtual-timer sibling of the real-time use-after-free). Absent on the live
   *  scheduler, where real timers always fire on wall-clock time, so `wait()` never rejects there. */
  readonly signal?: AbortSignal;
}

/** The rejection surfaced to a `wait()` cancelled by a shutdown {@link SchedulerDeps.signal}: the
 *  signal's `reason` when it is an {@link Error}, else a generic teardown error. Reusing the reason
 *  keeps a caller's fail-loud message (e.g. "WasmEngineClient closing") intact. */
function schedulerAbortError(signal: AbortSignal): Error {
  const reason: unknown = signal.reason;
  return reason instanceof Error ? reason : new Error("app.wait aborted: scheduler shutting down");
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
 * delay clamps to fire at the current instant, and a far-future delay clamps to
 * {@link MAX_TIMER_DELAY_MS} — matching the same clamp the background loops apply to their
 * `setTimer` delays (see `mountTriggers`/`mountInstanceTracking`) — so `app.wait()` can
 * never reintroduce a Node `TimeoutOverflowWarning`.
 */
export function schedulerClock(sched: SchedulerDeps): AppClock {
  return {
    now: () => sched.now(),
    wait: (ms) =>
      new Promise<void>((resolve, reject) => {
        const signal = sched.signal;
        // Already shutting down: reject immediately rather than arm a timer that would outlive the
        // teardown (and, under the virtual clock, never fire).
        if (signal?.aborted) {
          reject(schedulerAbortError(signal));
          return;
        }
        const delay = Number.isFinite(ms) && ms > 0 ? Math.min(ms, MAX_TIMER_DELAY_MS) : 0;
        let settled = false;
        let onAbort: (() => void) | undefined;
        const handle = sched.setTimer(() => {
          settled = true;
          if (onAbort && signal) signal.removeEventListener("abort", onAbort);
          resolve();
        }, delay);
        // When a shutdown signal is present, a mid-wait abort disarms the timer and rejects, so a
        // handler parked here unwinds at teardown instead of wedging its awaiter. Inert (no listener,
        // no behaviour change) on the live scheduler, which supplies no signal.
        //
        // `settled` guards the synchronous-timer case: this seam permits `setTimer` to invoke its
        // callback synchronously (the test `capturingScheduler` does exactly that), which resolves
        // the wait *before* we get here. Installing an abort listener on that already-settled promise
        // would leak its closure until the signal fires (and have shutdown clear an already-fired
        // handle), so skip it entirely when the callback already ran.
        if (signal && !settled) {
          onAbort = () => {
            sched.clearTimer(handle);
            reject(schedulerAbortError(signal));
          };
          signal.addEventListener("abort", onAbort, { once: true });
          // Re-entrant seam: `setTimer` above is injectable and may abort `signal` *synchronously*
          // without firing the timer callback (so `settled` is still false). An abort event is not
          // replayed to a listener added after the fact, so the listener just registered would never
          // run and the wait would hang until the runner timeout. Re-check and drive the abort path
          // by hand — removing the (now-inert) listener first so it cannot also fire and double-reject.
          if (signal.aborted && !settled) {
            signal.removeEventListener("abort", onAbort);
            onAbort();
          }
        }
      }),
  };
}
