/**
 * @nanobpm/agentic-transcript — the transcript store for the Nano agentic
 * protocol (ADR 0056, slice S6).
 *
 * Retention-by-lifecycle over the app DataLayer/SQLite ({@link TranscriptStore}):
 * an ephemeral run flushes the S5 relay ring to a durable, readable transcript on
 * job completion; a long-lived stream retains its chunks so a reconnecting
 * consumer can resume-from-offset (reattach). It builds on the S5 relay's
 * resume-from-offset semantics (`@nanobpm/agentic-relay`) and stores through the
 * app DataLayer only — nothing rides the Camunda-8 engine or its transport.
 *
 * The new DB schema ships as the forward-only, additive migration
 * `db/migrations/002_agentic_transcript.sql`, mirrored by {@link TRANSCRIPT_SCHEMA_SQL}
 * and kept in lockstep by a drift-guard test.
 */
export { TranscriptStore, TranscriptCorruptionError, TranscriptLifecycleError, systemClock } from "./store.ts";
export type {
  Clock,
  SqliteDb,
  TranscriptChunk,
  TranscriptContentBlock,
  TranscriptContentType,
  TranscriptLifecycle,
  TranscriptRing,
  TranscriptSlice,
  TranscriptStatus,
  TranscriptStoreOptions,
  TranscriptStream,
  TranscriptToolCall,
  TranscriptTurn,
  TranscriptTurnMetrics,
  TranscriptTurnRole,
} from "./store.ts";

export {
  TRANSCRIPT_CHUNK_TABLE,
  TRANSCRIPT_SCHEMA_SQL,
  TRANSCRIPT_STREAM_TABLE,
  TRANSCRIPT_TURN_SCHEMA_SQL,
  TRANSCRIPT_TURN_TABLE,
} from "./schema.ts";
