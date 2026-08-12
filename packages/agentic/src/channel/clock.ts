/**
 * An injectable monotonic-ish wall clock. The hub and connection registry read
 * time only through a {@link Clock} so liveness/TTL behaviour is deterministic
 * under test (pass a fake clock) without sleeping on the real timer.
 */
export interface Clock {
  /** Current time in epoch milliseconds. */
  now(): number;
}

/** The production clock, backed by {@link Date.now}. */
export const systemClock: Clock = {
  now: () => Date.now(),
};
