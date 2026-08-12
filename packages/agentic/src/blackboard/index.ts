/**
 * @nanobpm/agentic-blackboard — the blackboard family for the Nano agentic
 * protocol (ADR 0056, slice S7).
 *
 * Promotes nano-workforce's per-plan blackboard HTTP hook to a first-class,
 * capability-scoped `blackboard` channel-message family: a durable per-scope
 * coordination store ({@link BlackboardStore}) with idempotent `dedupeKey`
 * append, `file-claim` conflict reporting and `since`/cursor incremental reads,
 * plus a self-contained family module ({@link attachBlackboardFamily}) that
 * attaches to the S1 hub through its `registerFamilyHandler(family, handler)`
 * seam — never a shared dispatch switch. Any Urban app gets the blackboard for
 * free by attaching this module.
 *
 * The wire contract lives in `@nanobpm/agentic-protocol`; the hub in
 * `@nanobpm/agentic-channel`. This package builds on both.
 */
export {
  BlackboardStore,
  isUniqueViolation,
  normalizeKind,
  systemClock,
  BLACKBOARD_KINDS,
} from "./store.ts";
export type {
  BlackboardEntry,
  BlackboardInput,
  BlackboardKind,
  BlackboardPage,
  BlackboardStoreOptions,
  ClaimConflict,
  Clock,
  SqliteDb,
} from "./store.ts";

export {
  attachBlackboardFamily,
  BlackboardPayloadError,
  BlackboardScopeError,
} from "./family.ts";
export type { BlackboardFamilyOptions, BlackboardFamilyHandle } from "./family.ts";

export { BLACKBOARD_TABLE, BLACKBOARD_SCHEMA_SQL } from "./schema.ts";
