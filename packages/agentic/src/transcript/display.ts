/**
 * THE ORDERED DISPLAY DERIVATION (#566) — the canonical projection that turns the typed transcript-event
 * log into the sequence of display blocks a human transcript renders, top to bottom.
 *
 * WHY THIS EXISTS. The raw log is transport-fragmented: a single logical assistant message arrives as
 * many `message` deltas ("I", "not", "ice I am act", …) because a transport boundary is NOT a message
 * boundary. {@link deriveView} (the store-level fold) is deliberately faithful to that — it emits one
 * {@link DerivedMessage} per event and keeps `messages` / `tools` / `permissions` as SEPARATE arrays,
 * so a consumer that renders those groups loses both the message identity (one card per fragment) AND
 * the chronological interleaving of text, tool cards and permission prompts. This module is the
 * DEDICATED display projection that fixes both, WITHOUT changing the raw log, {@link deriveView}, or the
 * event-count semantics anything else depends on. It is the single source of truth for "what the
 * transcript looks like"; the cockpit (this repo) and nano-workforce consume it rather than forking a
 * grammar.
 *
 * WHAT IT GUARANTEES.
 *  - COALESCING IS EXACT. Adjacent same-speaker text deltas of the same logical message concatenate with
 *    NO injected space, trim or rewrite — Unicode, paragraphs and code formatting survive byte-for-byte,
 *    so fragments that spell a word reconstruct into exactly that word.
 *  - ORDER IS CHRONOLOGICAL. Text blocks, tool cards and permission prompts appear in offset order, so a
 *    tool call issued mid-message renders between the text before and after it (never hoisted into a
 *    separate group).
 *  - BOUNDARIES ARE HONOURED, NOT GUESSED. A tool call, a permission interaction, a role change, an
 *    explicit message `start`/`final`, a `turn` boundary, a changed `messageId`, or a retention `gap`
 *    all CLOSE the active text block so the next delta starts a fresh one. Absent producer metadata, the
 *    fallback is purely structural (adjacent + same speaker) — never a timing or punctuation heuristic.
 *  - SNAPSHOTS REPLACE, DELTAS APPEND. A `mode:"snapshot"` message REPLACES the block's accumulated text
 *    with its cumulative value; a delta appends. A snapshot is never treated as a delta (which would
 *    double the text).
 *  - REPLAY IS IDEMPOTENT. Offsets are the idempotency key: re-feeding an already-applied offset
 *    (reconnect, pagination overlap, a duplicated chunk) is a no-op, so replayed text never doubles.
 *  - A GAP STAYS VISIBLE. A retention gap is a first-class {@link DisplayGapBlock} in the sequence, so a
 *    reattach that dropped chunks renders a break instead of implying the surrounding text is continuous.
 *
 * INCREMENTAL-FRIENDLY. {@link createDisplayProjection} keeps the ordered blocks as mutable state and
 * returns, from each {@link DisplayProjection.apply}, exactly which block was touched — so a consumer can
 * update the one active block's DOM node in place instead of re-rendering the whole transcript on every
 * delta. When opening the first block after a {@link DisplayProjection.noteGap} also anchors that gap's
 * `beforeOffset`, the same result reports the now-anchored gap as its secondary `anchored` block, so a
 * consumer that already rendered the gap patches it too. {@link deriveDisplay} is the pure batch
 * convenience over the same fold.
 *
 * BROWSER-SAFE, like {@link ./events.ts}: no Node-only API, no I/O, never touches the engine. NOT pure:
 * {@link createDisplayProjection} is deliberately stateful (it keeps the ordered blocks as mutable state),
 * and the non-cloneable `tool.args` fallback freezes the caller's args object in place ({@link freezeArgs}).
 * {@link deriveDisplay} is the pure batch convenience layered over the stateful fold.
 */
import type {
  DerivedPermission,
  DerivedTool,
  MessageEvent,
  PermissionRequestEvent,
  PermissionResolutionEvent,
  ToolCallEvent,
  ToolResultEvent,
  TranscriptEvent,
  TranscriptRole,
} from "./events.ts";

/** A coalesced run of same-speaker, same-message text — the reconstructed logical message block. */
export interface DisplayTextBlock {
  readonly kind: "text";
  /** Stable identity: `text:<startOffset>`. Keyed by the first fragment's offset, which never changes as
   *  the block grows, so a consumer can find-and-update the same DOM node across deltas. */
  readonly id: string;
  readonly role: TranscriptRole;
  /** The producer's message identity, when one was supplied (else this is a fallback-coalesced block). */
  readonly messageId?: string;
  /** The exactly-concatenated (or snapshot-replaced) text so far. */
  readonly text: string;
  /** Offset of the FIRST fragment folded into this block (its stable identity + top of its offset range). */
  readonly startOffset: number;
  /** Offset of the LAST fragment folded into this block (grows as deltas arrive). */
  readonly endOffset: number;
  /** `true` once an explicit `final`, or any coalescing-breaking boundary, has closed the block. */
  readonly complete: boolean;
}

/** A tool card in the ordered display — the call, paired to its result once it arrives (without hiding
 *  that it is still pending until then). Wraps a deep-frozen snapshot clone of the canonical
 *  {@link DerivedTool} (its nested `result` is cloned + frozen too), so mutating it cannot reach back
 *  into the projection's internal state. */
export interface DisplayToolBlock {
  readonly kind: "tool";
  /** Stable identity `tool:<startOffset>`. */
  readonly id: string;
  readonly tool: DerivedTool;
  /** The tool-call offset (position of the card in the transcript). */
  readonly startOffset: number;
  /** The result offset once paired, else the call offset (the card's live extent). */
  readonly endOffset: number;
}

/** A permission prompt in the ordered display — the request, paired to its resolution once it arrives.
 *  Wraps a deep-frozen snapshot clone of the canonical {@link DerivedPermission} (its nested `options`
 *  and `resolved` are cloned + frozen too), so mutating it cannot reach back into projection state. */
export interface DisplayPermissionBlock {
  readonly kind: "permission";
  /** Stable identity `permission:<startOffset>`. */
  readonly id: string;
  readonly permission: DerivedPermission;
  readonly startOffset: number;
  readonly endOffset: number;
}

/**
 * A visible retention gap: chunks the consumer asked for were already evicted (the S6
 * {@link TranscriptSlice.gap} signal). It is a real block in the sequence so the transcript renders a
 * break rather than implying the text on either side is continuous. `beforeOffset` is the offset of the
 * first block AFTER the gap when known (else `undefined` for a leading gap).
 */
export interface DisplayGapBlock {
  readonly kind: "gap";
  /** Stable identity `gap:<ordinal>` — a gap has no natural offset, so it is keyed by insertion order. */
  readonly id: string;
  readonly beforeOffset?: number;
}

/** One block in the ordered, human-facing transcript display. */
export type DisplayBlock = DisplayTextBlock | DisplayToolBlock | DisplayPermissionBlock | DisplayGapBlock;

/** What a single {@link DisplayProjection.apply} did — so an incremental consumer can update just the
 *  touched block(s) instead of re-rendering everything. `changed` is the block that was created or mutated
 *  (undefined when the event was a no-op: an ignored kind, or a duplicate/stale offset). `appended` is
 *  `true` when `changed` is a brand-new block at the end (a consumer appends a node) versus an in-place
 *  update of an existing block (a consumer patches that node's content/attributes). `anchored` is a
 *  SECOND, previously-emitted block this same apply also mutated in place, so a consumer patches it too:
 *  currently only the pending retention gap from {@link DisplayProjection.noteGap}, whose `beforeOffset`
 *  is unknown when emitted and becomes known when the first post-gap block opens — the apply that opens
 *  that block reports the now-anchored gap here. `undefined` when nothing secondary changed. */
export interface DisplayApplyResult {
  readonly changed?: DisplayBlock;
  readonly appended: boolean;
  readonly anchored?: DisplayBlock;
}

const NOOP: DisplayApplyResult = Object.freeze({ appended: false });

/** Internal mutable text block; the public {@link DisplayTextBlock} is a frozen snapshot of it. */
interface MutableText {
  readonly kind: "text";
  role: TranscriptRole;
  messageId?: string;
  text: string;
  readonly startOffset: number;
  endOffset: number;
  complete: boolean;
}

interface MutableTool {
  readonly kind: "tool";
  tool: DerivedTool;
  readonly startOffset: number;
  endOffset: number;
}

interface MutablePermission {
  readonly kind: "permission";
  permission: DerivedPermission;
  readonly startOffset: number;
  endOffset: number;
}

interface MutableGap {
  readonly kind: "gap";
  readonly ordinal: number;
  beforeOffset?: number;
}

type MutableBlock = MutableText | MutableTool | MutablePermission | MutableGap;

/** Recursively freeze a value already owned exclusively by the caller (a fresh clone), so no consumer
 *  can mutate it at any depth. Idempotent, and a no-op for primitives and already-frozen objects. A
 *  `seen` set guards against cyclic references so an arbitrarily-shaped `args` payload with a cycle
 *  freezes without recursing forever. */
function deepFreeze(value: unknown, seen: WeakSet<object> = new WeakSet()): void {
  if (value === null || typeof value !== "object" || Object.isFrozen(value) || seen.has(value)) return;
  seen.add(value);
  Object.freeze(value);
  for (const nested of Object.values(value)) deepFreeze(nested, seen);
}

/** Decouple a producer-owned, arbitrarily-shaped `args` value from projection state: deep clone it (so
 *  the returned snapshot shares no mutable reference) then deep-freeze the clone. When `structuredClone`
 *  is unavailable or `args` is non-cloneable (e.g. it contains functions), fall back to deep-freezing
 *  `args` *in place* rather than returning it unfrozen: a shared-by-reference fallback would let a
 *  consumer mutate `tool.args` back into the projection's internals, so freezing the shared object is
 *  what preserves the "cannot reach back" guarantee even when cloning fails. */
function freezeArgs(args: unknown): unknown {
  if (args === null || typeof args !== "object") return args;
  let cloned: unknown;
  try {
    cloned = structuredClone(args);
  } catch {
    deepFreeze(args);
    return args;
  }
  deepFreeze(cloned);
  return cloned;
}

/** Deep-freeze a {@link DerivedTool} into a snapshot decoupled from the projection's mutable internals:
 *  a shallow clone whose nested `result` is itself cloned + frozen and whose producer-owned `args` is
 *  deep cloned + frozen ({@link freezeArgs}), so a consumer that mutates the returned `tool` (or
 *  `tool.result` / `tool.args`) cannot reach back into projection state. */
function freezeTool(tool: DerivedTool): DerivedTool {
  return Object.freeze({
    ...tool,
    ...(tool.args !== undefined ? { args: freezeArgs(tool.args) } : {}),
    ...(tool.result !== undefined ? { result: Object.freeze({ ...tool.result }) } : {}),
  });
}

/** Deep-freeze a {@link DerivedPermission} into a snapshot decoupled from the projection's mutable
 *  internals: a shallow clone whose nested `options` (and each option) and `resolved` are cloned +
 *  frozen, so a consumer cannot mutate projection state through the returned `permission`. */
function freezePermission(permission: DerivedPermission): DerivedPermission {
  return Object.freeze({
    ...permission,
    options: Object.freeze(permission.options.map((option) => Object.freeze({ ...option }))),
    ...(permission.resolved !== undefined ? { resolved: Object.freeze({ ...permission.resolved }) } : {}),
  });
}

function freezeBlock(block: MutableBlock): DisplayBlock {
  switch (block.kind) {
    case "text":
      return Object.freeze({
        kind: "text",
        id: `text:${block.startOffset}`,
        role: block.role,
        ...(block.messageId !== undefined ? { messageId: block.messageId } : {}),
        text: block.text,
        startOffset: block.startOffset,
        endOffset: block.endOffset,
        complete: block.complete,
      });
    case "tool":
      return Object.freeze({
        kind: "tool",
        id: `tool:${block.startOffset}`,
        tool: freezeTool(block.tool),
        startOffset: block.startOffset,
        endOffset: block.endOffset,
      });
    case "permission":
      return Object.freeze({
        kind: "permission",
        id: `permission:${block.startOffset}`,
        permission: freezePermission(block.permission),
        startOffset: block.startOffset,
        endOffset: block.endOffset,
      });
    case "gap":
      return Object.freeze({
        kind: "gap",
        id: `gap:${block.ordinal}`,
        ...(block.beforeOffset !== undefined ? { beforeOffset: block.beforeOffset } : {}),
      });
  }
}

/** A pending tool call, remembered so its later result updates the SAME block in place (O(1)), paired by
 *  `callId` (else the most recent anonymous call) — mirroring {@link deriveView}'s pairing. */
interface PendingTool {
  block: MutableTool;
}

interface PendingPermission {
  block: MutablePermission;
}

function toolFromCall(event: ToolCallEvent): DerivedTool {
  return {
    name: event.name,
    offset: event.offset,
    ...(event.callId !== undefined ? { callId: event.callId } : {}),
    ...(event.args !== undefined ? { args: event.args } : {}),
  };
}

function toolWithResult(tool: DerivedTool, result: ToolResultEvent): DerivedTool {
  return {
    ...tool,
    result: {
      ok: result.ok,
      offset: result.offset,
      ...(result.content !== undefined ? { content: result.content } : {}),
    },
  };
}

function permissionFromRequest(event: PermissionRequestEvent): DerivedPermission {
  return {
    callId: event.callId,
    policy: event.policy,
    options: event.options,
    offset: event.offset,
    ...(event.toolName !== undefined ? { toolName: event.toolName } : {}),
    ...(event.title !== undefined ? { title: event.title } : {}),
    ...(event.reason !== undefined ? { reason: event.reason } : {}),
  };
}

function permissionWithResolution(
  permission: DerivedPermission,
  resolution: PermissionResolutionEvent,
): DerivedPermission {
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
 * A STATEFUL, incremental display projection: feed it offset-ordered transcript events and it maintains
 * the ordered {@link DisplayBlock} sequence, reporting from each {@link apply} exactly which block was
 * created or mutated so a consumer can update that one block's DOM in place. Idempotent on offset, so
 * replay / reconnect / pagination overlap never doubles text. Constructing one per drilled stream gives
 * each its own display.
 */
export interface DisplayProjection {
  /** Fold one event; returns what changed (or a no-op result for an ignored/duplicate event). */
  apply(event: TranscriptEvent): DisplayApplyResult;
  /** Fold many events in order (convenience over {@link apply}). */
  applyAll(events: Iterable<TranscriptEvent>): void;
  /**
   * Record a retention gap at the current tail: the consumer resumed from an offset older than the
   * oldest retained chunk (the S6 `gap` signal), so the events that follow are NOT continuous with what
   * precedes. Closes the active text block and appends a visible {@link DisplayGapBlock}. Call it BEFORE
   * feeding the post-gap events; the gap's `beforeOffset` is filled in from the next block that opens and
   * surfaced to a consumer as that {@link apply}'s {@link DisplayApplyResult.anchored}.
   */
  noteGap(): DisplayApplyResult;
  /** A frozen snapshot of the ordered display blocks as they stand now. */
  blocks(): readonly DisplayBlock[];
}

export function createDisplayProjection(): DisplayProjection {
  const blocks: MutableBlock[] = [];
  const openTools = new Map<string, PendingTool>();
  let anonymousTool: PendingTool | undefined;
  const openPermissions = new Map<string, PendingPermission>();
  // The append-order idempotency key: the highest offset ever folded. Any event at or below it was
  // already applied (a replayed/duplicated chunk), so it is a no-op — this is what keeps replay,
  // reconnect and pagination overlap from doubling text. Starts at -1 so offset 0 applies.
  let lastOffset = -1;
  // A pending gap awaiting the offset of the next block, so a consumer can anchor the break.
  let pendingGapBlock: MutableGap | undefined;
  let gapOrdinal = 0;

  /** The active text block a delta may extend: the LAST block, iff it is an open text block. Any other
   *  trailing block (a tool card, a permission, a gap) means there is no open text run to coalesce into. */
  const activeText = (): MutableText | undefined => {
    const tail = blocks[blocks.length - 1];
    return tail !== undefined && tail.kind === "text" && !tail.complete ? tail : undefined;
  };

  const closeActiveText = (): void => {
    const active = activeText();
    if (active !== undefined) active.complete = true;
  };

  /** Anchor a not-yet-anchored gap to the first block that opens after it, returning the now-anchored gap
   *  (frozen) so the triggering {@link apply} can surface it as {@link DisplayApplyResult.anchored} — else
   *  `undefined` when there is no pending gap. */
  const anchorGap = (offset: number): DisplayBlock | undefined => {
    if (pendingGapBlock === undefined) return undefined;
    pendingGapBlock.beforeOffset = offset;
    const anchored = freezeBlock(pendingGapBlock);
    pendingGapBlock = undefined;
    return anchored;
  };

  const applyMessage = (event: MessageEvent): DisplayApplyResult => {
    const active = activeText();
    // A delta may extend the active block only when it is the SAME speaker AND the SAME logical message
    // AND the producer did not force a new block with `start`. Message identity: if both sides carry a
    // `messageId` they must match; a changed id (or one side having an id the other lacks) is a distinct
    // message. With no ids on either side, the fallback is purely structural — adjacent + same speaker.
    const idsMatch =
      event.messageId !== undefined || active?.messageId !== undefined
        ? event.messageId === active?.messageId
        : true;
    const canExtend = active !== undefined && event.start !== true && active.role === event.role && idsMatch;

    if (canExtend && active !== undefined) {
      // Snapshot REPLACES the accumulated text; a delta APPENDS exactly (no separator).
      active.text = event.mode === "snapshot" ? event.text : active.text + event.text;
      active.endOffset = event.offset;
      if (event.final === true) active.complete = true;
      return { changed: freezeBlock(active), appended: false };
    }

    // Open a fresh block. (A `start`/id-change/role-change also closes any still-open predecessor so the
    // next unrelated delta cannot re-open it.)
    closeActiveText();
    const anchored = anchorGap(event.offset);
    const block: MutableText = {
      kind: "text",
      role: event.role,
      text: event.text,
      startOffset: event.offset,
      endOffset: event.offset,
      complete: event.final === true,
      ...(event.messageId !== undefined ? { messageId: event.messageId } : {}),
    };
    blocks.push(block);
    return { changed: freezeBlock(block), appended: true, ...(anchored !== undefined ? { anchored } : {}) };
  };

  const applyToolCall = (event: ToolCallEvent): DisplayApplyResult => {
    // A tool call interrupts any running text: it becomes the trailing block, so a later delta opens a
    // new text block rather than coalescing across the tool.
    closeActiveText();
    const anchored = anchorGap(event.offset);
    const block: MutableTool = {
      kind: "tool",
      tool: toolFromCall(event),
      startOffset: event.offset,
      endOffset: event.offset,
    };
    blocks.push(block);
    const pending: PendingTool = { block };
    if (event.callId !== undefined) openTools.set(event.callId, pending);
    else anonymousTool = pending;
    return { changed: freezeBlock(block), appended: true, ...(anchored !== undefined ? { anchored } : {}) };
  };

  const applyToolResult = (event: ToolResultEvent): DisplayApplyResult => {
    const pending = event.callId !== undefined ? openTools.get(event.callId) : anonymousTool;
    if (pending === undefined) return NOOP; // A result with no open call — nothing to pair (never invents a card).
    pending.block.tool = toolWithResult(pending.block.tool, event);
    pending.block.endOffset = event.offset;
    if (event.callId !== undefined) openTools.delete(event.callId);
    else anonymousTool = undefined;
    return { changed: freezeBlock(pending.block), appended: false };
  };

  const applyPermissionRequest = (event: PermissionRequestEvent): DisplayApplyResult => {
    closeActiveText();
    const anchored = anchorGap(event.offset);
    const block: MutablePermission = {
      kind: "permission",
      permission: permissionFromRequest(event),
      startOffset: event.offset,
      endOffset: event.offset,
    };
    blocks.push(block);
    openPermissions.set(event.callId, { block });
    return { changed: freezeBlock(block), appended: true, ...(anchored !== undefined ? { anchored } : {}) };
  };

  const applyPermissionResolution = (event: PermissionResolutionEvent): DisplayApplyResult => {
    const pending = openPermissions.get(event.callId);
    if (pending === undefined) return NOOP;
    pending.block.permission = permissionWithResolution(pending.block.permission, event);
    pending.block.endOffset = event.offset;
    openPermissions.delete(event.callId);
    return { changed: freezeBlock(pending.block), appended: false };
  };

  const apply = (event: TranscriptEvent): DisplayApplyResult => {
    // Idempotency gate: this projection requires events in strictly increasing `offset` order, so any
    // offset at or below the high-water mark is treated as already folded (replay / reconnect /
    // pagination overlap / a duplicated chunk) and re-applying it must not change anything. A genuinely
    // out-of-order event (offset <= lastOffset arriving late) is likewise dropped here, not merged — a
    // caller seeing a "missing" block must re-feed the stream in order rather than read it as deduped.
    if (event.offset <= lastOffset) return NOOP;
    lastOffset = event.offset;
    switch (event.kind) {
      case "message":
        return applyMessage(event);
      case "tool-call":
        return applyToolCall(event);
      case "tool-result":
        return applyToolResult(event);
      case "permission":
        return event.phase === "request" ? applyPermissionRequest(event) : applyPermissionResolution(event);
      case "turn":
        // An explicit turn boundary closes the running message so the next turn's text starts fresh.
        closeActiveText();
        return NOOP;
      // A `step`, a `lifecycle` transition, and a raw `stream-chunk` do not themselves produce a display
      // block and do not break text coalescing (raw bytes render on the separate byte-terminal plane).
      case "step":
      case "lifecycle":
      case "stream-chunk":
        return NOOP;
    }
  };

  return {
    apply,
    applyAll(events: Iterable<TranscriptEvent>): void {
      for (const event of events) apply(event);
    },
    noteGap(): DisplayApplyResult {
      closeActiveText();
      const block: MutableGap = { kind: "gap", ordinal: gapOrdinal++ };
      blocks.push(block);
      pendingGapBlock = block;
      return { changed: freezeBlock(block), appended: true };
    },
    blocks(): readonly DisplayBlock[] {
      return blocks.map(freezeBlock);
    },
  };
}

/**
 * The pure batch convenience: fold a whole run of offset-ordered events into the ordered display blocks
 * in one call, over a fresh {@link createDisplayProjection}. Duplicate offsets in the input are deduped
 * by the same idempotency gate, so a replayed slice folds to the same result as a gap-free one.
 */
export function deriveDisplay(events: Iterable<TranscriptEvent>): readonly DisplayBlock[] {
  const projection = createDisplayProjection();
  projection.applyAll(events);
  return projection.blocks();
}
