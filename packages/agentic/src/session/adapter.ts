/**
 * The `@nanobpm/agentic/session` adapter contract — ADR 0062, slice 1.
 *
 * The three-method interface every session backend implements. It is the *mind*
 * side of a durable agent activation: the authoritative log of what the agent
 * thought/did ({@link SessionAdapter.emit}, the "mind tap"), the mind/world join
 * points at a push boundary ({@link SessionAdapter.checkpoint}), and the seed a
 * re-leased incarnation replays to resume ({@link SessionAdapter.restore}).
 *
 * Publishing this interface + the {@link SessionEvent} types first is the whole
 * point of slice 1: the ACP client (slice 2), the stream-json/native normalisers
 * (slice 3) and the nano-workforce world-restore (slice 4) all code against this
 * stable contract in parallel. Keep it small and additive.
 */
import type { AppendedSessionEvent, SessionEvent } from "./events.ts";

/**
 * Identifies one **activation** — a single leased run of a BPMN element. This is
 * the log's identity for fencing and replay: every incarnation of the same
 * `(processInstanceKey, elementId)` shares one causal log and one fence, so a
 * re-lease resumes the same session rather than starting a new one.
 *
 * The authoritative log is keyed `(processInstanceKey, elementId)` (ADR 0062):
 * this pair identifies the activation and shares one fence. The current
 * `incarnation` is stored as the fence token, and each appended event carries an
 * `incarnation` stamp recording which generation wrote that row.
 */
export interface ActivationKey {
  readonly processInstanceKey: string;
  readonly elementId: string;
}

/** Render an {@link ActivationKey} as an opaque, collision-free string key. */
export function activationKeyString(key: ActivationKey): string {
  // NUL separates the two components so no pair of distinct (pik, elementId)
  // values can collide by concatenation (NUL cannot appear in either).
  return `${key.processInstanceKey}\u0000${key.elementId}`;
}

/**
 * One recorded side effect at a checkpoint's push boundary. The *shape* of an
 * effect (its `kind` vocabulary, how it is replayed/fenced) is owned by slice 4
 * (nano-workforce world-restore); slice 1 stores the ledger opaquely so the
 * contract is stable before that lands. `detail` is an opaque JSON value.
 */
export interface EffectEntry {
  readonly id: string;
  readonly kind: string;
  readonly detail?: unknown;
}

/**
 * The world-side effects committed at a checkpoint. Stored verbatim (JSON) and
 * handed back unchanged at {@link SessionAdapter.restore}; slice 1 never
 * interprets it.
 */
export type EffectLedger = readonly EffectEntry[];

/**
 * A mind/world join recorded at a push boundary: the agent's mind is at log
 * `offset`, the world is at git `commitSha`, and `effectLedger` lists the effects
 * that boundary committed. On re-lease the newest checkpoint's seed is replayed.
 */
export interface SessionCheckpoint {
  /** Unique checkpoint id (producer- or backend-assigned). */
  readonly id: string;
  /**
   * The log offset the checkpoint pins: exactly the log's `nextOffset` at the
   * moment it was taken, so the seed is events `[0, offset)`.
   */
  readonly offset: number;
  /** The world (git) commit the mind is joined to at this boundary. */
  readonly commitSha: string;
  /** The effects committed at this boundary (opaque to slice 1). */
  readonly effectLedger: EffectLedger;
  /** The incarnation that took the checkpoint. */
  readonly incarnation: number;
  /** When the checkpoint was taken, ISO-8601. */
  readonly at: string;
}

/**
 * The mind seed handed back on re-lease: everything a resumed incarnation needs
 * to reconstruct the agent's mind up to a checkpoint and continue from there.
 */
export interface SessionSeed {
  /**
   * The checkpoint the seed restores from, or `null` when the session has no
   * checkpoint yet (a fresh start — `events` is empty and `nextOffset` is 0).
   */
  readonly checkpoint: SessionCheckpoint | null;
  /**
   * The authoritative log replayed up to (and excluding) the checkpoint offset,
   * in offset order — the events the resumed agent replays to rebuild its mind.
   */
  readonly events: readonly AppendedSessionEvent[];
  /**
   * The offset the resumed incarnation continues appending at — the checkpoint
   * offset (0 when there is no checkpoint). Any events a dead incarnation wrote
   * *past* the checkpoint are uncommitted and are not part of the seed.
   */
  readonly nextOffset: number;
}

/**
 * The three-method session adapter. An instance is bound to one
 * {@link ActivationKey} and one `incarnation`; a re-lease constructs a new
 * adapter at a higher incarnation over the same authoritative log.
 */
export interface SessionAdapter {
  /** The activation this adapter writes to. */
  readonly key: ActivationKey;
  /** The generation of this writer (the fencing token). */
  readonly incarnation: number;

  /**
   * The **mind tap**: append `event` to the authoritative session log at the
   * current offset, returning it stamped with its assigned `offset` and this
   * writer's `incarnation`. Fenced — a call from an incarnation that a newer one
   * has superseded throws {@link StaleIncarnationError} and writes nothing.
   */
  emit(event: SessionEvent): AppendedSessionEvent;

  /**
   * Mark a mind/world join at a push boundary: record a checkpoint pinning the
   * current log offset to `commitSha` and `effectLedger`. Fenced like
   * {@link emit}. Returns the recorded checkpoint.
   */
  checkpoint(commitSha: string, effectLedger: EffectLedger): SessionCheckpoint;

  /**
   * Hand back the mind seed to resume from. With no argument (or an unknown id)
   * it resolves the **latest** checkpoint; given a checkpoint id it restores that
   * specific one. Returns a {@link SessionSeed} of the log up to the checkpoint
   * offset. Read-only — it does not mutate the log or the fence.
   */
  restore(fromCheckpoint?: string): SessionSeed;
}

/**
 * Raised when a write (emit/checkpoint) is attempted by an incarnation that a
 * newer one has already superseded — the fence rejected it. The stale writer's
 * call has no effect; the log stays owned by the current incarnation.
 */
export class StaleIncarnationError extends Error {
  readonly key: ActivationKey;
  readonly incarnation: number;
  readonly current: number;
  constructor(key: ActivationKey, incarnation: number, current: number) {
    super(
      `incarnation ${incarnation} is fenced for activation ` +
        `${key.processInstanceKey}/${key.elementId}: a newer incarnation ${current} has taken over`,
    );
    this.name = "StaleIncarnationError";
    this.key = key;
    this.incarnation = incarnation;
    this.current = current;
  }
}
