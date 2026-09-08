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

/**
 * The transcript EVENT vocabulary + the single derive() fold (ADR 0056, #251) — the canonical,
 * merge-extensible typed event grammar every Urban app consumes and extends (rather than forking).
 * The marker + version constants and {@link parseTranscriptEvent} are the single source of truth the
 * whole package family (e.g. the cockpit's structured-stream detection) imports from here.
 */
export {
  CORE_TRANSCRIPT_EVENT_KINDS,
  CORE_TRANSCRIPT_VOCAB,
  TRANSCRIPT_EVENT_MARKER,
  TRANSCRIPT_EVENT_VERSION,
  deriveView,
  deriveViewFromChunks,
  encodeTranscriptEvent,
  mergeTranscriptVocab,
  optionKindAllows,
  parseTranscriptEvent,
  utf8ByteLength,
} from "./events.ts";
export type {
  DerivedMessage,
  DerivedPermission,
  DerivedTool,
  DerivedTurn,
  DerivedView,
  LifecycleEvent,
  MessageEvent,
  MessageMode,
  PermissionOption,
  PermissionOptionKind,
  PermissionPolicy,
  PermissionRequestEvent,
  PermissionResolutionEvent,
  StepEvent,
  StoredChunk,
  StreamChunkEvent,
  ToolCallEvent,
  ToolResultEvent,
  TranscriptEvent,
  TranscriptEventDecoder,
  TranscriptEventKind,
  TranscriptRole,
  TranscriptVocab,
  TurnEvent,
} from "./events.ts";

/**
 * The ordered display derivation (#566) — the canonical projection that coalesces transport-fragmented
 * message deltas back into logical blocks and interleaves them chronologically with tool cards and
 * permission prompts. The cockpit and downstream consumers (nano-workforce) render THIS instead of the
 * raw per-event groups, so a split word reconstructs into one block and ordering never scrambles. The
 * raw log, its offsets and byte-faithful replay are untouched.
 */
export { createDisplayProjection, deriveDisplay } from "./display.ts";
export type {
  DisplayApplyResult,
  DisplayBlock,
  DisplayGapBlock,
  DisplayPermissionBlock,
  DisplayProjection,
  DisplayTextBlock,
  DisplayToolBlock,
} from "./display.ts";
