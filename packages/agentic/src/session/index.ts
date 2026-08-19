/**
 * `@nanobpm/agentic/session` — the canonical agent-session contract (ADR 0062,
 * slice 1). The foundation the two ingestion backends (ACP, normalisers) and the
 * nano-workforce world-restore all code against in parallel.
 *
 * Exports, in the order a consumer meets them:
 *  - the canonical {@link SessionEvent} union every harness dialect normalises
 *    into, plus {@link parseSessionEvent} (the untyped-storage boundary);
 *  - the three-method {@link SessionAdapter} interface (emit/checkpoint/restore)
 *    with its {@link ActivationKey}, {@link SessionCheckpoint} and
 *    {@link SessionSeed} types;
 *  - the {@link SessionLog} port and its two backends — the in-memory reference
 *    ({@link InMemorySessionLog}, the stub) and the durable, authoritative
 *    {@link SqliteSessionLog} that promotes the ADR 0056 §12 relay ring + fence;
 *  - {@link SessionBackend} (the one adapter implementation) and the
 *    {@link openInMemorySession} / {@link openSqliteSession} factories.
 *
 * The new DB schema ships as the forward-only migration
 * `db/migrations/005_agentic_session.sql`, mirrored by {@link SESSION_SCHEMA_SQL}
 * and kept in lockstep by a drift-guard test. Nothing here rides the Camunda-8
 * engine — the log is app-tier (ADR 0056 boundary preserved).
 */
export type {
  AppendedSessionEvent,
  AssistantMessageEvent,
  CompactionEvent,
  ReasoningEvent,
  SessionEvent,
  SessionEventEnvelope,
  SessionEventType,
  SystemMessageEvent,
  ToolCallEvent,
  ToolResultEvent,
  TurnEndEvent,
  TurnStartEvent,
  UsageEvent,
  UserMessageEvent,
} from "./events.ts";
export { parseSessionEvent, SESSION_EVENT_TYPES, SessionEventShapeError } from "./events.ts";

export type {
  ActivationKey,
  EffectEntry,
  EffectLedger,
  SessionAdapter,
  SessionCheckpoint,
  SessionSeed,
} from "./adapter.ts";
export { activationKeyString, StaleIncarnationError } from "./adapter.ts";

export type { Clock, SessionLog, SqliteDb } from "./log.ts";
export {
  InMemorySessionLog,
  SessionLogCorruptionError,
  SqliteSessionLog,
  systemClock,
} from "./log.ts";

export type { SessionBackendOptions } from "./backend.ts";
export { openInMemorySession, openSqliteSession, SessionBackend } from "./backend.ts";

export {
  SESSION_CHECKPOINT_TABLE,
  SESSION_EVENT_TABLE,
  SESSION_LOG_TABLE,
  SESSION_SCHEMA_SQL,
} from "./schema.ts";
