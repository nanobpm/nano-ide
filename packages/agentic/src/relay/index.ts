/**
 * @nanobpm/agentic-relay — the relay ring + QoS scheduler for the Nano agentic
 * protocol (ADR 0056, slice S5).
 *
 * Live terminal relay over the one app-tier channel: a bounded replay ring with
 * resume-from-offset ({@link ReplayRing}), generation/incarnation fencing
 * ({@link IncarnationFence}), a three-lane credit-based QoS scheduler that keeps
 * a bulk-output storm from head-of-line-blocking control/interactive traffic
 * ({@link QosScheduler}), and the `relay` message family ({@link RelayHub}) that
 * composes them.
 *
 * The family attaches to the S1 hub through its `registerFamilyHandler` seam via
 * {@link registerRelayFamily} — its own self-contained module, never a shared
 * dispatch switch. It builds on the S0 contract (`@nanobpm/agentic-protocol`)
 * and the S1 channel (`@nanobpm/agentic-channel`); the Camunda-8 engine
 * transport is a separate connection and is never touched.
 */
export { ReplayRing } from "./ring.ts";
export type { ReplayEntry, ReplayRingOptions, ReplaySlice } from "./ring.ts";

export { IncarnationFence } from "./incarnation.ts";

export { QosScheduler, compareFrameOrder, lanePriority } from "./scheduler.ts";
export type { QosSchedulerOptions } from "./scheduler.ts";

export {
  RelayHub,
  RelayMessageError,
  registerRelayFamily,
  RELAY_FAMILY,
} from "./relay-family.ts";
export type { RelayConnection, RelayHubOptions } from "./relay-family.ts";

export { addSafeInt, isNonNegInt, isPosInt } from "./validate.ts";
