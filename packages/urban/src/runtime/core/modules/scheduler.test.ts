import assert from "node:assert/strict";
import { test } from "node:test";

import { MAX_TIMER_DELAY_MS, type SchedulerDeps, schedulerClock } from "./scheduler.ts";

// A capturing scheduler that records every delay handed to `setTimer` and fires it
// synchronously, so a test can assert exactly what `schedulerClock().wait()` arms.
function capturingScheduler(): SchedulerDeps & { delays: number[] } {
  const delays: number[] = [];
  return {
    now: () => 0,
    setTimer: (fn, delayMs) => {
      delays.push(delayMs);
      fn();
      return 0;
    },
    clearTimer: () => {},
    delays,
  };
}

// Regression (PR #409 review, suppressed advisory scheduler.ts): `schedulerClock().wait()`
// must clamp a far-future delay to MAX_TIMER_DELAY_MS so `app.wait()` can never pass a value
// > setTimeout's 32-bit range and reintroduce a Node `TimeoutOverflowWarning`. The clamp lives
// only here (the single canonical clock/`wait` seam), so it needs its own guard.
test("schedulerClock.wait clamps a far-future delay to MAX_TIMER_DELAY_MS", async () => {
  const sched = capturingScheduler();
  await schedulerClock(sched).wait(MAX_TIMER_DELAY_MS * 3);
  assert.deepEqual(sched.delays, [MAX_TIMER_DELAY_MS]);
});

test("schedulerClock.wait passes an in-range delay through unchanged", async () => {
  const sched = capturingScheduler();
  await schedulerClock(sched).wait(1234);
  assert.deepEqual(sched.delays, [1234]);
});

test("schedulerClock.wait clamps non-positive / non-finite delays to the current instant", async () => {
  const sched = capturingScheduler();
  await schedulerClock(sched).wait(-5);
  await schedulerClock(sched).wait(Number.NaN);
  await schedulerClock(sched).wait(Number.POSITIVE_INFINITY);
  assert.deepEqual(sched.delays, [0, 0, 0]);
});
