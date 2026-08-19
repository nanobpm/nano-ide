/**
 * The `@nanobpm/agentic/session/normalizer` contract — ADR 0062, slice 3 (the
 * `stream-json`/native-transcript **fallback** ingestion backend).
 *
 * Slice 2 speaks ACP directly; this slice covers every harness that does *not*
 * (yet) speak ACP. ADR 0062 §5 frames `stream-json` as a *transport with N
 * vendor dialects*, so there is no single "stream-json backend": each harness
 * gets a small **normalizer** that maps its native/streaming session output onto
 * Nano's canonical {@link SessionEvent} (slice 1), plus a **resume shim** over
 * that harness's native `--resume <id>` (or SDK equivalent).
 *
 * The three moving parts a harness normalizer exposes:
 *
 *  - {@link HarnessNormalizer.toDrafts} — the dialect map: one native record →
 *    zero-or-more {@link DraftEvent}s (canonical events *minus* the causal-chain
 *    fields the shared {@link linkDrafts} threads in, so a per-harness dialect
 *    never re-implements chaining).
 *  - {@link HarnessNormalizer.resume} — the resume shim: given a native session
 *    id, the exact native invocation ({@link ResumeShim}) that restores it.
 *  - {@link HarnessNormalizer.capabilities} — the {@link HarnessCapabilities}
 *    the {@link capabilityProbe} folds into a `durable-resume` advertisement
 *    (slice 5's enrolment gate reads this).
 *
 * Nothing here interprets a harness schema as *ours*: the native shapes are
 * ingestion details owned entirely by each dialect module; the union they all
 * target is the stable slice-1 contract.
 */
import type { SessionEvent } from "../events.ts";

/**
 * Distributive `Omit` over a discriminated union: applies `Omit` to *each* union
 * member, preserving the `type` discriminant. A plain `Omit<Union, K>` collapses
 * to the members' common properties (losing the per-member fields), so we cannot
 * use it to describe "a session event without its chain fields".
 */
export type DistributiveOmit<T, K extends keyof T> = T extends unknown ? Omit<T, K> : never;

/**
 * A canonical {@link SessionEvent} as a dialect first produces it — the full
 * semantic payload (`type` + type-specific fields) but *without* the causal-chain
 * responsibilities (`parentId`, and an optional-only `id`). The shared
 * {@link linkDrafts} threads `parentId` in emission order and fills any missing
 * `id`, so an individual dialect never re-implements chain bookkeeping; it just
 * says "here is the event this record means". A dialect that already knows a
 * stable native id (a tool-call id, a provider message id) may supply it as
 * `id` to preserve correlation across a resume.
 */
export type DraftEvent = DistributiveOmit<SessionEvent, "id" | "parentId"> & {
  readonly id?: string;
};

/**
 * The native resume invocation a harness's shim resolves for a session id. Two
 * transports cover the fleet:
 *
 *  - `cli` — a flag-driven harness: `args` are the argv tail to append to the
 *    harness command to resume that session (e.g. Claude's `["--resume", id]`,
 *    Qwen's `["-r", id]`). Nano spawns; it never parses the harness's output
 *    beyond the dialect map.
 *  - `sdk` — an in-process harness (Copilot's `copilot-sdk`, the DeepSeek live
 *    feed): `call` names the SDK method and `args` are its arguments (e.g.
 *    `resumeSession(id)`), so the host invokes it directly rather than spawning.
 *
 * `sessionId` echoes the id the shim resumed, so a caller that only kept the
 * {@link ResumeShim} still knows which session it targets.
 */
export type ResumeShim =
  | { readonly transport: "cli"; readonly sessionId: string; readonly args: readonly string[] }
  | { readonly transport: "sdk"; readonly sessionId: string; readonly call: string; readonly args: readonly unknown[] };

/**
 * What a harness can do, from the perspective of durable resume. `streaming` is
 * "exposes a machine-readable streaming/native mind source we can normalize";
 * `resumeById` is "can restore a *specific* prior session by id" (not merely
 * `--continue` the latest). {@link CapabilityAdvertisement.durableResume} is
 * derived, never declared — see {@link capabilityProbe}.
 */
export interface HarnessCapabilities {
  readonly streaming: boolean;
  readonly resumeById: boolean;
}

/**
 * The advertisement {@link capabilityProbe} produces: the raw capabilities plus
 * the single **derived** `durableResume` bit slice 5's enrolment gate consumes.
 * Keeping `durableResume` derived (never a hand-set field on a normalizer)
 * eliminates the drift surface where a harness claims durability it can't honour.
 */
export interface CapabilityAdvertisement {
  readonly harness: string;
  readonly streaming: boolean;
  readonly resumeById: boolean;
  /** `true` iff the harness both streams a mind source AND resumes by id. */
  readonly durableResume: boolean;
}

/**
 * One harness's fallback ingestion adapter: a dialect map, a resume shim, and its
 * capabilities. Independent per harness (they fan out in parallel), and all
 * target the one canonical {@link SessionEvent} union.
 */
export interface HarnessNormalizer {
  /** The harness id this normalizer speaks for, e.g. `"@github/copilot"`. */
  readonly harness: string;
  /** Raw capabilities; `durable-resume` is derived from these by {@link capabilityProbe}. */
  readonly capabilities: HarnessCapabilities;
  /**
   * Map one native record (a parsed `stream-json` line, an SDK `SessionEvent`, a
   * live-feed frame) to zero-or-more canonical {@link DraftEvent}s. Returns `[]`
   * for records that carry no session-log meaning (transport keep-alives, init
   * frames the canonical model does not represent). Throws
   * {@link NormalizerDialectError} on a record that *should* map but is
   * structurally invalid — a corrupt transcript fails loudly, it never
   * fabricates an event.
   */
  toDrafts(record: unknown): readonly DraftEvent[];
  /** Resolve the native invocation that resumes `sessionId` for this harness. */
  resume(sessionId: string): ResumeShim;
}

/**
 * Derive a harness's `durable-resume` advertisement from its raw capabilities.
 * A harness advertises `durable-resume` **iff** it both exposes a streaming mind
 * source we can normalize AND can restore a specific session by id — either half
 * alone is insufficient (a stream we can't resume, or a resume with no mind to
 * replay). This is the single place the bit is computed.
 */
export function capabilityProbe(normalizer: HarnessNormalizer): CapabilityAdvertisement {
  const { streaming, resumeById } = normalizer.capabilities;
  return {
    harness: normalizer.harness,
    streaming,
    resumeById,
    durableResume: streaming && resumeById,
  };
}

/**
 * Raised when a native record that a dialect *should* map is structurally
 * invalid (a missing tool-call id, a message with no content). Mirrors slice 1's
 * `SessionEventShapeError` at the ingestion boundary: normalization is a trusted
 * map, so a malformed native record surfaces loudly rather than silently
 * dropping or fabricating a canonical event.
 */
export class NormalizerDialectError extends Error {
  readonly harness: string;
  constructor(harness: string, message: string) {
    super(`[${harness}] ${message}`);
    this.name = "NormalizerDialectError";
    this.harness = harness;
  }
}
