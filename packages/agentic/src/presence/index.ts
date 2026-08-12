/**
 * @nanobpm/agentic-presence — the presence & registry family for the Nano
 * agentic protocol (ADR 0056, slice S2).
 *
 * Owns the `register` / `heartbeat` / `deregister` message families: a durable
 * presence registry over the app DataLayer/SQLite ({@link PresenceStore}) plus
 * a self-contained family module ({@link attachPresenceFamily}) that attaches to
 * the S1 hub through its `registerFamilyHandler(family, handler)` seam — never a
 * shared dispatch switch. S1 owns connection liveness; this slice layers durable
 * presence rows with their own heartbeat-refreshed TTL on top.
 *
 * The wire contract lives in `@nanobpm/agentic-protocol`; the hub in
 * `@nanobpm/agentic-channel`. This package builds on both.
 */
export { PresenceOwnershipError, PresenceStore } from "./store.ts";
export type {
  PresenceRow,
  PresenceStoreOptions,
  RegisterInput,
  SqliteDb,
} from "./store.ts";

export { attachPresenceFamily, PresencePayloadError } from "./family.ts";
export type { PresenceFamilyOptions, PresenceFamilyHandle } from "./family.ts";

export { PRESENCE_TABLE, PRESENCE_SCHEMA_SQL } from "./schema.ts";
