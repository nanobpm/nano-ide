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

// Regression (issue #446 follow-up): a handler parked on `app.wait()` sits on a (virtual) timer that
// no clock advance fires during teardown, so whoever awaits it — the test kit's `engine.close()` —
// hangs forever. `schedulerClock().wait()` now honours an optional shutdown `signal`: a mid-wait
// abort disarms the armed timer and rejects, so the parked handler unwinds at teardown. The live
// scheduler supplies no signal, so this is wholly inert in production.
test("schedulerClock.wait disarms its timer and rejects when the shutdown signal aborts mid-wait", async () => {
  const controller = new AbortController();
  const cleared: unknown[] = [];
  let armed: (() => void) | undefined;
  const sched: SchedulerDeps = {
    now: () => 0,
    signal: controller.signal,
    setTimer: (fn) => {
      armed = fn;
      return 42;
    },
    clearTimer: (h) => cleared.push(h),
  };
  const waiting = schedulerClock(sched).wait(10_000);
  assert.equal(typeof armed, "function", "wait must arm a timer while not aborted");
  controller.abort(new Error("engine shutting down"));
  await assert.rejects(waiting, /engine shutting down/, "an aborted wait must reject with the signal's reason");
  assert.deepEqual(cleared, [42], "the armed timer must be cleared on abort so it cannot fire later");
});

test("schedulerClock.wait rejects immediately (arming no timer) when the signal is already aborted", async () => {
  const controller = new AbortController();
  controller.abort(new Error("already shutting down"));
  let armedCount = 0;
  const sched: SchedulerDeps = {
    now: () => 0,
    signal: controller.signal,
    setTimer: () => {
      armedCount += 1;
      return 0;
    },
    clearTimer: () => {},
  };
  await assert.rejects(schedulerClock(sched).wait(1000), /already shutting down/);
  assert.equal(armedCount, 0, "an already-aborted signal must reject without arming a timer");
});

// A generic teardown error backs a non-Error abort reason, so `wait()` still rejects (never resolves)
// when the caller aborts with a bare value rather than an Error.
test("schedulerClock.wait rejects with a generic teardown error when the abort reason is not an Error", async () => {
  const controller = new AbortController();
  const sched: SchedulerDeps = {
    now: () => 0,
    signal: controller.signal,
    setTimer: () => 0,
    clearTimer: () => {},
  };
  const waiting = schedulerClock(sched).wait(1000);
  controller.abort("not-an-error");
  await assert.rejects(waiting, /scheduler shutting down/);
});
