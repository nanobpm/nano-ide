/**
 * The shared causal-chain linker + stream driver every dialect reuses — ADR 0062
 * slice 3.
 *
 * A {@link HarnessNormalizer} produces {@link DraftEvent}s (semantics only); the
 * *chaining* — assigning each event a stable `id` and stamping `parentId` as the
 * id of its predecessor — is identical across every harness dialect, so it lives
 * here exactly once (derivation over duplication, AGENTS.md). {@link normalizeSession}
 * is the one entry point a caller uses: it maps a whole native transcript through
 * a normalizer, links the drafts into a causal chain, and validates every result
 * against the slice-1 boundary ({@link parseSessionEvent}) so a dialect can never
 * emit a shape that is not a canonical {@link SessionEvent}.
 */
import { randomUUID } from "node:crypto";
import { parseSessionEvent, type SessionEvent } from "../events.ts";
import type { DraftEvent, HarnessNormalizer } from "./types.ts";

export interface LinkOptions {
  /**
   * Id generator for drafts that do not carry a native id. Default is
   * `crypto.randomUUID`, which is unique-safe across repeated
   * `normalizeSession()` calls for one session (e.g. per chunk / per resume
   * leg); inject a deterministic generator in tests when stable ids are needed.
   * It is only consulted when a draft omits `id`.
   */
  newId?: () => string;
  /**
   * The `parentId` the first linked event points at — the causal predecessor
   * this transcript continues from. `null` (default) starts a fresh chain; on a
   * resume the caller passes the last restored event's id so the new events
   * continue the same chain across the resume boundary.
   */
  parentId?: string | null;
}

/**
 * Thread a flat list of {@link DraftEvent}s into a causal chain of canonical
 * {@link SessionEvent}s: each event's `id` is its native id when it supplied one
 * else a freshly generated id, and its `parentId` is the id of the event before
 * it (or {@link LinkOptions.parentId} for the first). Offsets are *not* assigned
 * here — the authoritative log owns those on `emit` (slice 1); this only records
 * causality (`parentId`), which survives compaction.
 */
export function linkDrafts(drafts: readonly DraftEvent[], options: LinkOptions = {}): SessionEvent[] {
  const newId = options.newId ?? randomUUID;
  let parentId: string | null = options.parentId ?? null;
  const linked: SessionEvent[] = [];
  for (const draft of drafts) {
    const { id: nativeId, ...rest } = draft;
    const id = nativeId ?? newId();
    // Re-validate the fully-formed event at the slice-1 boundary: `rest` carries
    // the discriminant + payload, and we add the chain fields. parseSessionEvent
    // *builds* the union member field-by-field (never an as-cast), so a dialect
    // bug surfaces here as a loud SessionEventShapeError instead of a bad row.
    const event = parseSessionEvent({ ...rest, id, parentId });
    linked.push(event);
    parentId = id;
  }
  return linked;
}

/**
 * Normalize a whole native transcript through a harness normalizer: map every
 * record to drafts, then {@link linkDrafts} the concatenation into one canonical
 * causal chain. This is the fallback backend's public ingestion call — the
 * mirror of the ACP backend's `session/update` stream, producing the same
 * {@link SessionEvent}s a caller feeds to a slice-1 `SessionAdapter.emit`.
 */
export function normalizeSession(
  normalizer: HarnessNormalizer,
  records: Iterable<unknown>,
  options: LinkOptions = {},
): SessionEvent[] {
  const drafts: DraftEvent[] = [];
  for (const record of records) {
    for (const draft of normalizer.toDrafts(record)) {
      drafts.push(draft);
    }
  }
  return linkDrafts(drafts, options);
}
