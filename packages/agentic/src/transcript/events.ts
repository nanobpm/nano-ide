/**
 * The transcript EVENT vocabulary + the single derive() fold (ADR 0056, #251).
 *
 * This is the "event-sourced session" layer over the S6 transcript store ({@link ./store.ts}). The
 * store is already append-only and offset-keyed — chunks are appended, never mutated — which is half of
 * the event-sourced-session pattern. The gap it left is that chunks are opaque `TEXT`: every richer
 * view (structured message history, tool cards, per-turn boundaries, token accounting) had to re-parse
 * the raw frame bytes ad hoc, a DRIFT SURFACE (two parsers of the same bytes), which our "Derivation
 * Over Duplication" doctrine forbids.
 *
 * This module closes that gap: the append-only log of TYPED events is the single source of truth, and
 * every higher-level view is a DERIVATION of that one log via a single {@link deriveView} fold — "the
 * log IS the state, so divergence is structurally impossible". A raw terminal chunk is retained
 * verbatim as a `stream-chunk` event (byte-level replay fidelity is preserved); a producer that emits a
 * structured, marker-tagged JSON envelope is decoded into the authoritative typed events (message /
 * tool-call / tool-result / turn / step / lifecycle) the derived views fold over.
 *
 * THE ONE PARSER. {@link parseTranscriptEvent} is the SINGLE place a stored chunk is classified into a
 * typed event; every consumer (cockpit, search, token accounting, export) reads the derived view, not
 * the raw bytes. A drift-guard test (`events.drift.test.ts`) asserts the event marker — and therefore
 * the raw→event parse — appears in exactly this module, so a second parser cannot creep in.
 *
 * MERGE-EXTENSIBLE. The vocabulary is a small core ({@link CORE_TRANSCRIPT_VOCAB}) authors extend in the
 * same schema with {@link mergeTranscriptVocab}, so a new event kind is an additive merge, never a fork
 * of the parser. A downstream app (e.g. nano-workforce#559) registers its own `permission` kind this
 * way without editing this package.
 *
 * BROWSER-SAFE. This module is imported by cockpit code that runs in the BROWSER (the cockpit derive),
 * so it takes no hard dependency on Node's `Buffer` or any Node-only API — {@link utf8ByteLength} uses
 * the Web/Node standard `TextEncoder`. It is pure and side-effect-free: no I/O, and it never touches the
 * engine or a BPMN flow (ADR 0056: app-tier only, advisory).
 */

/**
 * Runtime-safe UTF-8 byte length. The one canonical UTF-8 byte-length implementation the transcript
 * plane derives from. Implemented with `TextEncoder` (a Web/Node standard) rather than Node's `Buffer`,
 * so the single derive fold is portable across the browser (where `Buffer` is not available) and Node.
 */
let cachedTextEncoder: TextEncoder | undefined;
export function utf8ByteLength(text: string): number {
  // Cache one TextEncoder in the hot path (folding many stream-chunk events) to avoid allocating a new
  // encoder — and the GC pressure it creates — on every call.
  cachedTextEncoder ??= new TextEncoder();
  return cachedTextEncoder.encode(text).length;
}

/**
 * The reserved marker field that distinguishes a structured transcript-event envelope from raw
 * terminal bytes. A stored chunk is decoded as a typed event ONLY when it is a JSON object carrying
 * this field set to the schema version — otherwise it is retained verbatim as a raw `stream-chunk`, so
 * a raw ANSI frame that happens to be valid JSON is never mis-classified. Namespaced so it cannot
 * collide with a producer's own payload keys. This is the canonical single source of truth for the
 * whole package family — consumers (e.g. the cockpit) import this identifier, never a private copy.
 */
export const TRANSCRIPT_EVENT_MARKER = "nwfTranscriptEvent" as const;

/** The current transcript-event envelope schema version (the value {@link TRANSCRIPT_EVENT_MARKER} carries). */
export const TRANSCRIPT_EVENT_VERSION = 1 as const;

/** The core, closed set of typed transcript-event kinds. Downstream apps register extra *envelope*
 * kinds via {@link mergeTranscriptVocab}, but those decoders must still return one of these core
 * variants — this union itself does not grow for TypeScript consumers. */
export type TranscriptEventKind =
  | "stream-chunk"
  | "message"
  | "tool-call"
  | "tool-result"
  | "turn"
  | "step"
  | "lifecycle"
  | "permission";

/** The message roles the derived history distinguishes (assistant is authoritative for derivation). */
export type TranscriptRole = "assistant" | "user" | "system" | "tool";

/** Fields every typed event carries: the store offset it was decoded from. */
interface TranscriptEventBase {
  readonly offset: number;
}

/** A raw terminal chunk retained verbatim for byte-level replay fidelity (the default classification). */
export interface StreamChunkEvent extends TranscriptEventBase {
  readonly kind: "stream-chunk";
  /** The exact stored bytes — unmodified, so raw-byte replay stays faithful. */
  readonly chunk: string;
}

/** An assistant/user/system message — authoritative for the derived message history. */
export interface MessageEvent extends TranscriptEventBase {
  readonly kind: "message";
  readonly role: TranscriptRole;
  readonly text: string;
}

/** A tool invocation the agent issued. */
export interface ToolCallEvent extends TranscriptEventBase {
  readonly kind: "tool-call";
  readonly name: string;
  /** A stable id linking this call to its {@link ToolResultEvent}, when the producer supplies one. */
  readonly callId?: string;
  readonly args?: unknown;
}

/** A tool result, paired back to its {@link ToolCallEvent} by `callId` (else the most recent open call). */
export interface ToolResultEvent extends TranscriptEventBase {
  readonly kind: "tool-result";
  readonly callId?: string;
  readonly ok: boolean;
  readonly content?: string;
}

/** A turn boundary — the start of a new request/response cycle. */
export interface TurnEvent extends TranscriptEventBase {
  readonly kind: "turn";
  /** The producer's turn index, when supplied (else derived positionally). */
  readonly index?: number;
}

/** A step boundary within a turn (a tool loop iteration, a sub-agent hop, …). */
export interface StepEvent extends TranscriptEventBase {
  readonly kind: "step";
  readonly label?: string;
}

/** A session lifecycle transition (open → completed, or an explicit exit). */
export interface LifecycleEvent extends TranscriptEventBase {
  readonly kind: "lifecycle";
  readonly phase: "open" | "completed" | "exited";
}

// --- Permission (ACP `session/request_permission`) — core kind (#514, lifted from nano-workforce#559) --
// A `permission` event models ACP's `session/request_permission`: the agent asks the operator to
// allow/deny a proposed action (usually a tool call), and the operator (or an auto policy) resolves it.
// It is decoded here (the ONE parser) and folded here (the ONE fold) into a paired {@link DerivedPermission}.
// ACP's `session/request_permission` is protocol-universal — every Urban app with ACP agents gets
// permission prompts — so it lives beside `tool-call`/`tool-result` in the core vocab, not as an
// app-specific extension. These exported types are the SINGLE SOURCE OF TRUTH every consumer (cockpit
// render, escalation bridge) imports; they must never reinvent a divergent permission shape. The wire
// shape is pinned by `wire:transcript.permission` in nano-workforce's `app/contracts.ts` — do not reshape it.

/**
 * The role's permission policy the PRODUCER tags a request with. `"escalate"` means a human must be
 * asked (the cockpit renders an Allow/Deny prompt, the escalation bridge raises a user task);
 * `"yolo"` means the action is auto-allowed and never prompts a human. Cockpit + bridge branch on this.
 */
export type PermissionPolicy = "escalate" | "yolo";

/** The kind of a permission option — mirrors ACP's option kinds (allow/reject × once/always). */
export type PermissionOptionKind = "allow-once" | "allow-always" | "reject-once" | "reject-always";

/** Pure, canonical: does a permission option kind ALLOW (true) or REJECT (false) the proposed action?
 *  The `allow-*` vs `reject-*` prefix is the single source of truth. This lives beside
 *  {@link PermissionOptionKind} so every consumer (the cockpit render seam and the permission-escalation
 *  bridge) derives allow/deny from ONE implementation — the two paths can never disagree on what a
 *  chosen option means (no drift surface). */
export function optionKindAllows(kind: PermissionOptionKind): boolean {
  return kind === "allow-once" || kind === "allow-always";
}

/** One offered permission option (ACP `options[]` member): a stable id, a label, and its kind. */
export interface PermissionOption {
  readonly optionId: string;
  readonly name: string;
  readonly kind: PermissionOptionKind;
}

/**
 * A permission REQUEST: the agent asks the operator to allow/deny a proposed action. The `callId`
 * pairs the eventual {@link PermissionResolutionEvent} back to this request (mirroring how
 * `tool-call`/`tool-result` pair by `callId`).
 */
export interface PermissionRequestEvent extends TranscriptEventBase {
  readonly kind: "permission";
  readonly phase: "request";
  /** Stable id pairing this request to its resolution. */
  readonly callId: string;
  /** The producer-tagged policy the cockpit + bridge branch on. */
  readonly policy: PermissionPolicy;
  /** The offered options — always at least one (the decoder rejects an empty list). */
  readonly options: readonly PermissionOption[];
  /** The tool the proposed action would invoke, when known. */
  readonly toolName?: string;
  /** A short human-readable title for the prompt. */
  readonly title?: string;
  /** A longer human-readable reason for the prompt. */
  readonly reason?: string;
}

/**
 * A permission RESOLUTION: the operator's (or an auto policy's) decision, carrying the same `callId`,
 * the chosen `optionId`, and whether the action was `allowed`.
 */
export interface PermissionResolutionEvent extends TranscriptEventBase {
  readonly kind: "permission";
  readonly phase: "resolution";
  /** The `callId` of the {@link PermissionRequestEvent} this resolves. */
  readonly callId: string;
  /** The chosen option's id. */
  readonly optionId: string;
  /** True = allowed, false = denied. */
  readonly allowed: boolean;
  /** Provenance of the decision, when supplied. */
  readonly by?: "operator" | "auto";
}

/** The core, closed typed transcript-event union. Merging vocab lets an app decode custom *envelope*
 * kinds, but each decoder returns one of these variants — the union itself does not grow for consumers. */
export type TranscriptEvent =
  | StreamChunkEvent
  | MessageEvent
  | ToolCallEvent
  | ToolResultEvent
  | TurnEvent
  | StepEvent
  | LifecycleEvent
  | PermissionRequestEvent
  | PermissionResolutionEvent;

/** A stored chunk as the store/read path exposes it (mirrors `TranscriptChunk`). */
export interface StoredChunk {
  readonly offset: number;
  readonly chunk: string;
}

/**
 * A decoder for one event kind: given the parsed envelope body and the chunk offset, it returns the
 * typed event (or `undefined` to reject a malformed envelope, which then falls back to `stream-chunk`).
 * A vocabulary is the map kind → decoder; {@link mergeTranscriptVocab} extends it additively.
 */
export type TranscriptEventDecoder = (body: Record<string, unknown>, offset: number) => TranscriptEvent | undefined;

/** A transcript-event vocabulary: the ONE registry of kind → decoder the single parser consults. */
export type TranscriptVocab = Readonly<Record<string, TranscriptEventDecoder>>;

function str(body: Record<string, unknown>, key: string): string | undefined {
  const v = body[key];
  return typeof v === "string" ? v : undefined;
}

function num(body: Record<string, unknown>, key: string): number | undefined {
  const v = body[key];
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

const ROLES: readonly TranscriptRole[] = ["assistant", "user", "system", "tool"];

/** Narrow an arbitrary string to a known {@link TranscriptRole}, defaulting to `assistant`. */
function toRole(value: string | undefined): TranscriptRole {
  return ROLES.find((role) => role === value) ?? "assistant";
}

/** A structural guard: a non-null, non-array object is a plain record of unknown values. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

const PERMISSION_OPTION_KINDS: readonly PermissionOptionKind[] = [
  "allow-once",
  "allow-always",
  "reject-once",
  "reject-always",
];

/**
 * Decode ACP's `options[]` into typed {@link PermissionOption}s, or `undefined` if the array is
 * missing/empty or any member is malformed (so the whole request envelope is rejected → `stream-chunk`).
 */
function decodePermissionOptions(value: unknown): PermissionOption[] | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined;
  const options: PermissionOption[] = [];
  for (const raw of value) {
    if (!isRecord(raw)) return undefined;
    const optionId = str(raw, "optionId");
    const name = str(raw, "name");
    const kindRaw = str(raw, "kind");
    const kind = PERMISSION_OPTION_KINDS.find((k) => k === kindRaw);
    if (optionId === undefined || name === undefined || kind === undefined) return undefined;
    options.push({ optionId, name, kind });
  }
  return options;
}

/**
 * The opinionated core vocabulary — the built-in event kinds every consumer understands out of the
 * box. Authors extend it in the SAME schema via {@link mergeTranscriptVocab}; they never fork the
 * parser. (`stream-chunk` is not decoded here — it is the fallback the parser applies to any chunk
 * that is not a well-formed typed envelope, so raw fidelity needs no decoder.)
 */
export const CORE_TRANSCRIPT_VOCAB: TranscriptVocab = Object.freeze(Object.assign(Object.create(null), {
  message: (body, offset) => {
    const text = str(body, "text");
    if (text === undefined) return undefined;
    const roleRaw = str(body, "role");
    return { kind: "message", offset, role: toRole(roleRaw), text };
  },
  "tool-call": (body, offset) => {
    const name = str(body, "name");
    if (name === undefined) return undefined;
    const event: ToolCallEvent = { kind: "tool-call", offset, name };
    const callId = str(body, "callId");
    return {
      ...event,
      ...(callId !== undefined ? { callId } : {}),
      ...("args" in body ? { args: body.args } : {}),
    };
  },
  "tool-result": (body, offset) => {
    const ok = typeof body.ok === "boolean" ? body.ok : true;
    const event: ToolResultEvent = { kind: "tool-result", offset, ok };
    const callId = str(body, "callId");
    const content = str(body, "content");
    return {
      ...event,
      ...(callId !== undefined ? { callId } : {}),
      ...(content !== undefined ? { content } : {}),
    };
  },
  turn: (body, offset) => {
    const index = num(body, "index");
    return index !== undefined ? { kind: "turn", offset, index } : { kind: "turn", offset };
  },
  step: (body, offset) => {
    const label = str(body, "label");
    return label !== undefined ? { kind: "step", offset, label } : { kind: "step", offset };
  },
  lifecycle: (body, offset) => {
    const phase = str(body, "phase");
    if (phase !== "open" && phase !== "completed" && phase !== "exited") return undefined;
    return { kind: "lifecycle", offset, phase };
  },
  // A single `permission` decoder handles BOTH shapes (never a parser fork), branching on `phase`.
  // Malformed envelopes return `undefined` and fall back to `stream-chunk`, like the other decoders.
  permission: (body, offset) => {
    const callId = str(body, "callId");
    if (callId === undefined) return undefined;
    const phase = str(body, "phase");
    if (phase === "request") {
      const policy = str(body, "policy");
      if (policy !== "escalate" && policy !== "yolo") return undefined;
      const options = decodePermissionOptions(body.options);
      if (options === undefined) return undefined;
      const toolName = str(body, "toolName");
      const title = str(body, "title");
      const reason = str(body, "reason");
      const event: PermissionRequestEvent = { kind: "permission", phase: "request", offset, callId, policy, options };
      return {
        ...event,
        ...(toolName !== undefined ? { toolName } : {}),
        ...(title !== undefined ? { title } : {}),
        ...(reason !== undefined ? { reason } : {}),
      };
    }
    if (phase === "resolution") {
      const optionId = str(body, "optionId");
      if (optionId === undefined) return undefined;
      if (typeof body.allowed !== "boolean") return undefined;
      const by = str(body, "by");
      // Reject a malformed `by` rather than silently dropping it: a present-but-unknown provenance is a
      // producer bug, and swallowing it would make the typed event diverge from the on-wire JSON. This
      // covers BOTH a present-but-non-string `by` (e.g. `by: 123`, where str() coerces to undefined) and
      // a string that isn't a known provenance — either way the on-wire `by` is present but invalid.
      if (body.by !== undefined && by === undefined) return undefined;
      if (by !== undefined && by !== "operator" && by !== "auto") return undefined;
      const event: PermissionResolutionEvent = {
        kind: "permission",
        phase: "resolution",
        offset,
        callId,
        optionId,
        allowed: body.allowed,
      };
      return { ...event, ...(by !== undefined ? { by } : {}) };
    }
    return undefined;
  },
} satisfies TranscriptVocab));

/** The core event kinds the parser decodes from an envelope (every kind except the raw `stream-chunk`
 * fallback). Kept as a runtime list so the drift-guard can assert the single fold handles them all. */
export const CORE_TRANSCRIPT_EVENT_KINDS: readonly Exclude<TranscriptEventKind, "stream-chunk">[] = Object.freeze([
  "message",
  "tool-call",
  "tool-result",
  "turn",
  "step",
  "lifecycle",
  "permission",
]);

/**
 * Extend a vocabulary additively: later entries win on a key clash, so an author can either register a
 * brand-new kind or deliberately override a core decoder. Returns a NEW frozen, NULL-PROTOTYPE vocab —
 * neither input is mutated — so the core stays canonical AND `kind in vocab` / `Object.keys(vocab)`
 * only ever see own decoders (an inherited "toString"/"constructor" key can never masquerade as one).
 * This is the EXTENSION POINT a downstream app uses to add its own kind (e.g. nano-workforce#559's
 * `permission`) without editing this package: one schema, extended by merge, never a second parser.
 */
export function mergeTranscriptVocab(base: TranscriptVocab, ...extensions: TranscriptVocab[]): TranscriptVocab {
  return Object.freeze(Object.assign(Object.create(null), base, ...extensions));
}

/**
 * THE ONE PARSER. Classify a single stored chunk into a typed {@link TranscriptEvent}.
 *
 * A chunk is decoded as a structured event ONLY when it is a JSON object carrying the
 * {@link TRANSCRIPT_EVENT_MARKER} at the current version AND a `kind` the vocab knows AND its decoder
 * accepts the body. Anything else — raw terminal bytes, non-JSON, a JSON value without the marker, an
 * unknown kind, a decoder rejection — is retained verbatim as a `stream-chunk`, so byte-level replay
 * fidelity is never lost. This is the SINGLE point at which raw bytes become typed events; every view
 * folds over the result of this function, so there is exactly one parser of the log.
 */
export function parseTranscriptEvent(
  entry: StoredChunk,
  vocab: TranscriptVocab = CORE_TRANSCRIPT_VOCAB,
): TranscriptEvent {
  const raw: StreamChunkEvent = { kind: "stream-chunk", offset: entry.offset, chunk: entry.chunk };
  const body = decodeEnvelope(entry.chunk);
  if (body === undefined) return raw;
  const kind = typeof body.kind === "string" ? body.kind : undefined;
  if (kind === undefined) return raw;
  // Own-property + typeof-function guard: `kind` is untrusted, so a bare `vocab[kind]` would resolve
  // inherited members like "constructor"/"toString"/"__proto__" up the prototype chain to a
  // non-decoder function and call it — a crashable (DoS) / invariant-breaking path. Only an OWN
  // decoder function is ever invoked; everything else falls back to the raw stream-chunk.
  const decoder = Object.prototype.hasOwnProperty.call(vocab, kind) ? vocab[kind] : undefined;
  if (typeof decoder !== "function") return raw;
  return decoder(body, entry.offset) ?? raw;
}

/**
 * Decode a chunk into a marker-tagged envelope body, or `undefined` when it is not one. Kept private
 * so `JSON.parse` of a chunk lives in exactly one place (the drift-guard depends on this).
 */
function decodeEnvelope(chunk: string): Record<string, unknown> | undefined {
  // Cheap reject before the parse: a valid envelope is a JSON object mentioning the marker key.
  const trimmed = chunk.trimStart();
  if (!trimmed.startsWith("{") || !chunk.includes(TRANSCRIPT_EVENT_MARKER)) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(chunk);
  } catch {
    return undefined;
  }
  if (!isRecord(parsed)) return undefined;
  return parsed[TRANSCRIPT_EVENT_MARKER] === TRANSCRIPT_EVENT_VERSION ? parsed : undefined;
}

/**
 * Encode a typed event into the stored-chunk wire form a structured producer appends. The inverse of
 * {@link parseTranscriptEvent} for every non-raw kind (a `stream-chunk` is stored as its own raw bytes,
 * so it is returned verbatim). Provided so producers and tests speak the one envelope grammar rather
 * than hand-rolling the marker — the derivation-over-duplication rule applied to the write side too.
 */
export function encodeTranscriptEvent(event: TranscriptEvent): string {
  if (event.kind === "stream-chunk") return event.chunk;
  const { offset: _offset, ...rest } = event;
  return JSON.stringify({ [TRANSCRIPT_EVENT_MARKER]: TRANSCRIPT_EVENT_VERSION, ...rest });
}

/** A derived tool card: a tool-call paired with its result (result absent while the call is pending). */
export interface DerivedTool {
  readonly name: string;
  readonly callId?: string;
  readonly args?: unknown;
  readonly offset: number;
  readonly result?: { readonly ok: boolean; readonly content?: string; readonly offset: number };
}

/** A derived message in the folded history. */
export interface DerivedMessage {
  readonly role: TranscriptRole;
  readonly text: string;
  readonly offset: number;
}

/**
 * A derived permission: a permission REQUEST paired with its RESOLUTION by `callId` (resolution absent
 * while the request is still pending), mirroring how {@link DerivedTool} pairs a call with its result.
 * The cockpit and the escalation bridge read THIS — they never re-parse the log.
 */
export interface DerivedPermission {
  readonly callId: string;
  readonly policy: PermissionPolicy;
  readonly options: readonly PermissionOption[];
  readonly toolName?: string;
  readonly title?: string;
  readonly reason?: string;
  readonly offset: number;
  /** The resolution, once present (pending request → `undefined`). */
  readonly resolved?: {
    readonly allowed: boolean;
    readonly optionId: string;
    readonly by?: "operator" | "auto";
    readonly offset: number;
  };
}

/** A derived turn: the messages, tool cards and step count folded within one turn boundary. */
export interface DerivedTurn {
  readonly index: number;
  readonly startOffset: number;
  readonly messages: readonly DerivedMessage[];
  readonly tools: readonly DerivedTool[];
  readonly permissions: readonly DerivedPermission[];
  readonly steps: number;
}

/** The single derived view every higher-level consumer reads instead of re-parsing raw bytes. */
export interface DerivedView {
  /** The per-turn structure (a turn is opened implicitly before the first turn event when typed content — a message, tool-call or step — precedes it; raw `stream-chunk`s alone open no turn). */
  readonly turns: readonly DerivedTurn[];
  /** Every message across all turns, in offset order (the flat derived history). */
  readonly messages: readonly DerivedMessage[];
  /** Every tool card across all turns, in offset order. */
  readonly tools: readonly DerivedTool[];
  /** Every permission across all turns, in offset order (each request paired to its resolution by `callId`). */
  readonly permissions: readonly DerivedPermission[];
  /** Total retained raw bytes (UTF-8) across `stream-chunk` events — the byte-replay fidelity accounting. */
  readonly rawByteLength: number;
  /** Number of retained raw chunks. */
  readonly rawChunkCount: number;
  /** The session lifecycle as the last lifecycle event reports it (defaults to `open`). */
  readonly lifecycle: "open" | "completed" | "exited";
  /** Number of events folded — every event in the log, including raw `stream-chunk`s. */
  readonly eventCount: number;
}

interface MutableTurn {
  index: number;
  startOffset: number;
  messages: DerivedMessage[];
  tools: DerivedTool[];
  permissions: DerivedPermission[];
  steps: number;
}

/** A pending (result-less) tool call, remembered by where it lives in both the flat `tools` list and its
 * owning turn's `tools` list. Recording those positions at call time lets a later `tool-result` replace the
 * pending card in both lists in O(1), instead of re-scanning every turn/tool per result (which made result
 * pairing O(n²) on long transcripts). Array positions are stable because both lists only ever grow by push
 * and are updated by in-place index assignment — never spliced. */
interface PendingTool {
  tool: DerivedTool;
  toolsIndex: number;
  turn: MutableTurn;
  turnToolIndex: number;
}

/** A pending (unresolved) permission request, remembered by where it lives in both the flat `permissions`
 * list and its owning turn's list — so a later resolution replaces the pending card in both lists in O(1),
 * mirroring {@link PendingTool}. */
interface PendingPermission {
  permission: DerivedPermission;
  permissionsIndex: number;
  turn: MutableTurn;
  turnPermissionIndex: number;
}

/**
 * THE SINGLE FOLD. Derive every higher-level view from the typed event log — "the log IS the state".
 *
 * Folds the events (assumed in offset order — the store's append order) into per-turn structure, a flat
 * message history, tool cards (each call paired to its result by `callId`, else the most recent open
 * call), raw-byte accounting for replay fidelity, and the session lifecycle. It is a pure reduction of
 * one log: the cockpit, search, token accounting and export all read THIS, so there is never a second
 * parser of the same bytes. Typed content — a message, tool-call or step — that precedes the first
 * explicit `turn` event opens an implicit turn 0, so a producer that never emits turn boundaries still
 * derives a coherent single-turn view. Raw `stream-chunk` events alone open no turn (they only feed the
 * byte-replay accounting), so a log of only chunks derives zero turns.
 */
export function deriveView(events: Iterable<TranscriptEvent>): DerivedView {
  const turns: MutableTurn[] = [];
  const messages: DerivedMessage[] = [];
  const tools: DerivedTool[] = [];
  const permissions: DerivedPermission[] = [];
  const openTools = new Map<string, PendingTool>();
  let anonymousTool: PendingTool | undefined;
  const openPermissions = new Map<string, PendingPermission>();
  let rawByteLength = 0;
  let rawChunkCount = 0;
  let lifecycle: "open" | "completed" | "exited" = "open";
  let eventCount = 0;
  let current: MutableTurn | undefined;

  const ensureTurn = (offset: number): MutableTurn => {
    if (current === undefined) {
      current = { index: turns.length, startOffset: offset, messages: [], tools: [], permissions: [], steps: 0 };
      turns.push(current);
    }
    return current;
  };

  for (const event of events) {
    eventCount++;
    switch (event.kind) {
      case "turn": {
        current = { index: event.index ?? turns.length, startOffset: event.offset, messages: [], tools: [], permissions: [], steps: 0 };
        turns.push(current);
        break;
      }
      case "step": {
        ensureTurn(event.offset).steps++;
        break;
      }
      case "message": {
        const msg: DerivedMessage = { role: event.role, text: event.text, offset: event.offset };
        messages.push(msg);
        ensureTurn(event.offset).messages.push(msg);
        break;
      }
      case "tool-call": {
        const tool: DerivedTool = {
          name: event.name,
          offset: event.offset,
          ...(event.callId !== undefined ? { callId: event.callId } : {}),
          ...(event.args !== undefined ? { args: event.args } : {}),
        };
        const toolsIndex = tools.push(tool) - 1;
        const turn = ensureTurn(event.offset);
        const turnToolIndex = turn.tools.push(tool) - 1;
        const pending: PendingTool = { tool, toolsIndex, turn, turnToolIndex };
        if (event.callId !== undefined) openTools.set(event.callId, pending);
        else anonymousTool = pending;
        break;
      }
      case "tool-result": {
        const pending = event.callId !== undefined ? openTools.get(event.callId) : anonymousTool;
        if (pending !== undefined) {
          const resolved = withResult(pending.tool, event);
          tools[pending.toolsIndex] = resolved;
          pending.turn.tools[pending.turnToolIndex] = resolved;
          if (event.callId !== undefined) openTools.delete(event.callId);
          else anonymousTool = undefined;
        }
        break;
      }
      case "permission": {
        // A `permission` event is one of two phases (same discriminant `kind`); branch on `phase`. A
        // REQUEST opens a pending DerivedPermission (paired to its turn); a RESOLUTION folds back into
        // the open request by `callId` in O(1) — mirroring the tool-call/tool-result pending-map pairing.
        if (event.phase === "request") {
          const permission: DerivedPermission = {
            policy: event.policy,
            options: event.options,
            offset: event.offset,
            callId: event.callId,
            ...(event.toolName !== undefined ? { toolName: event.toolName } : {}),
            ...(event.title !== undefined ? { title: event.title } : {}),
            ...(event.reason !== undefined ? { reason: event.reason } : {}),
          };
          const permissionsIndex = permissions.push(permission) - 1;
          const turn = ensureTurn(event.offset);
          const turnPermissionIndex = turn.permissions.push(permission) - 1;
          openPermissions.set(event.callId, { permission, permissionsIndex, turn, turnPermissionIndex });
        } else {
          const pending = openPermissions.get(event.callId);
          if (pending !== undefined) {
            const resolved = withResolution(pending.permission, event);
            permissions[pending.permissionsIndex] = resolved;
            pending.turn.permissions[pending.turnPermissionIndex] = resolved;
            openPermissions.delete(event.callId);
          }
        }
        break;
      }
      case "lifecycle": {
        lifecycle = event.phase;
        break;
      }
      case "stream-chunk": {
        rawByteLength += utf8ByteLength(event.chunk);
        rawChunkCount++;
        break;
      }
    }
  }

  return {
    turns: turns.map((t) => ({ index: t.index, startOffset: t.startOffset, messages: t.messages, tools: t.tools, permissions: t.permissions, steps: t.steps })),
    messages,
    tools,
    permissions,
    rawByteLength,
    rawChunkCount,
    lifecycle,
    eventCount,
  };
}

/** Replace a pending tool with its result: a new resolved card that carries the result payload. */
function withResult(tool: DerivedTool, result: ToolResultEvent): DerivedTool {
  return {
    ...tool,
    result: { ok: result.ok, offset: result.offset, ...(result.content !== undefined ? { content: result.content } : {}) },
  };
}

/** Replace a pending permission with its resolution: a new card carrying the operator's decision. */
function withResolution(permission: DerivedPermission, resolution: PermissionResolutionEvent): DerivedPermission {
  return {
    ...permission,
    resolved: {
      allowed: resolution.allowed,
      optionId: resolution.optionId,
      offset: resolution.offset,
      ...(resolution.by !== undefined ? { by: resolution.by } : {}),
    },
  };
}

/**
 * Convenience: parse a run of stored chunks into typed events through {@link parseTranscriptEvent} (the
 * one parser) and fold them with {@link deriveView} in a single call — the entry point a consumer uses
 * to go from stored bytes to a derived view without ever touching a second parser.
 */
export function deriveViewFromChunks(chunks: Iterable<StoredChunk>, vocab: TranscriptVocab = CORE_TRANSCRIPT_VOCAB): DerivedView {
  function* parsed(): Generator<TranscriptEvent> {
    for (const entry of chunks) yield parseTranscriptEvent(entry, vocab);
  }
  return deriveView(parsed());
}
