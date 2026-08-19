// Derived seam inventory + static real-seam-descriptor registry (issue #297, slice S1).
//
// `seamInventory()` is the single, DERIVED source of truth S5's completeness guard
// asserts on. It enumerates whichever seams have declared a backing — no hand-maintained
// list — and reports, per seam, whether a fake, a record/replay, and a *real* backend
// exist.
//
// `hasReal` is STATIC EXISTENCE, decoupled from opt-in/runtime activation: it derives
// from a descriptor registered UNCONDITIONALLY at import via `registerRealSeamDescriptor`
// — NO instantiation, NO opt-in env/flag, NO network. This registry is kept SEPARATE
// from any runtime adapter construction/selection path. In slice S1 no real descriptor
// is registered, so both seams report `hasReal: false`; S4 flips them true by registering
// static descriptors at import.

/**
 * Canonical seam identity — the interface names. This union is the single source of
 * truth for valid seam ids; the enumeration in {@link seamInventory} is derived from
 * the backings/descriptors registered against these ids.
 */
export type SeamId = "EmbeddingModelAdapter" | "ChatModelAdapter";

/** One derived inventory row. */
export interface SeamInventoryEntry {
  readonly seam: SeamId;
  readonly hasFake: boolean;
  readonly hasRecordReplay: boolean;
  /** STATIC existence of a documented real backend (unconditional at import). */
  readonly hasReal: boolean;
  /** Documentation reference for the real backend, or `null` when none is registered. */
  readonly docRef: string | null;
}

/** A pure static fact: seam `X` has a documented real backend at `docRef`. */
export interface RealSeamDescriptor {
  readonly seam: SeamId;
  readonly docRef: string;
}

interface SeamBacking {
  hasFake: boolean;
  hasRecordReplay: boolean;
}

const backings = new Map<SeamId, SeamBacking>();
const realDescriptors = new Map<SeamId, string>();

function backingOf(seam: SeamId): SeamBacking {
  const existing = backings.get(seam);
  if (existing !== undefined) {
    return existing;
  }
  const created: SeamBacking = { hasFake: false, hasRecordReplay: false };
  backings.set(seam, created);
  return created;
}

/** Declares that a deterministic fake backs `seam` (called by the fakes module). */
export function declareFakeBacking(seam: SeamId): void {
  backingOf(seam).hasFake = true;
}

/** Declares that a record/replay backend wraps `seam` (called by the record/replay module). */
export function declareRecordReplayBacking(seam: SeamId): void {
  backingOf(seam).hasRecordReplay = true;
}

/**
 * Registers the STATIC fact that a documented real backend exists for a seam. This
 * performs NO instantiation, NO opt-in check, and NO network I/O — it only records the
 * seam id and its `docRef`. Called unconditionally at import by S4.
 */
export function registerRealSeamDescriptor(descriptor: RealSeamDescriptor): void {
  if (descriptor.docRef.trim().length === 0) {
    throw new Error("registerRealSeamDescriptor requires a non-empty docRef");
  }
  realDescriptors.set(descriptor.seam, descriptor.docRef);
}

/**
 * TEST-ONLY: clears the real-seam-descriptor registry so a test that registers a
 * descriptor cannot leak module-level state into another test (which would make
 * `hasReal`/`docRef` assertions order-dependent and non-deterministic). Only the
 * descriptor registry is cleared — the fake/record-replay backings are import-time
 * facts and must stay declared.
 */
export function resetRealSeamDescriptorsForTest(): void {
  realDescriptors.clear();
}

/**
 * Returns the derived inventory of every declared seam, sorted by seam id. A new seam
 * appears automatically once any backing is declared for it, so a future seam without
 * all three backings will make S5's completeness guard fail.
 */
export function seamInventory(): SeamInventoryEntry[] {
  const seams = new Set<SeamId>([...backings.keys(), ...realDescriptors.keys()]);
  return [...seams]
    .sort((a, b) => a.localeCompare(b))
    .map((seam) => {
      const backing = backingOf(seam);
      const docRef = realDescriptors.get(seam) ?? null;
      return {
        seam,
        hasFake: backing.hasFake,
        hasRecordReplay: backing.hasRecordReplay,
        hasReal: docRef !== null,
        docRef,
      };
    });
}
