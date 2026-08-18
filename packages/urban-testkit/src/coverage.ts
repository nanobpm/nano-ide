// Coverage-exhaustive gate for the e2e test kit (issue #157, S4; issue #189).
//
// A generic surface-coverage tracker: for each named *surface* (e.g. "operations",
// "workers") it holds the app's DECLARED element ids — derived from the app's own
// manifest + OpenAPI spec, never a second hand-written list — and the ids a test run
// actually EXERCISED. `assertFullCoverage()` then fails the build listing any declared
// element that was never driven, turning "we forgot to test operation X / worker Y"
// from a silent gap into a red test.
//
// The core is deliberately surface-agnostic and free of any runtime/engine import, so
// it is trivially unit-testable in isolation and later slices can add surfaces (webhook
// triggers, BPMN elements, SQLite tables) without touching this module — they only need
// to `declareSurface(...)` their element ids and `record(...)` as those elements fire.

/** One surface's declared-vs-exercised element coverage. */
export interface SurfaceReport {
  /** The surface name, e.g. "operations". */
  readonly surface: string;
  /** Declared element ids (the denominator), sorted. */
  readonly declared: readonly string[];
  /** Element ids a test run exercised (declared ∪ unexpected), sorted. */
  readonly exercised: readonly string[];
  /** Declared but never exercised — the gap the gate fails on, sorted. */
  readonly missing: readonly string[];
  /** Exercised but not declared — a hit on an element outside the derived surface
   *  (usually an internal/system element or a stale declaration). Informational only:
   *  the gate does NOT fail on these. Sorted. */
  readonly unexpected: readonly string[];
  /** Declared elements that were exercised **via a mock at least once** (epic #296, S4).
   *  Recorded additively: an id enters this set the first time it is exercised via a mock
   *  (`record(..., true)`) and stays — a *later* real dispatch of the same element does NOT
   *  remove it. So for a mixed mock+real element this means "mock-satisfied at least once",
   *  not "exclusively via mock". A mocked element still counts as exercised — so it is NOT a
   *  gap and never fails `assertFullCoverage` — but it is surfaced here so a reader can see the
   *  coverage was satisfied (at least partly) by a mock rather than solely by driving the real
   *  handler. Always a subset of `exercised`, sorted. Empty when nothing on this surface was
   *  mock-satisfied. */
  readonly mocked: readonly string[];
  /** True when nothing declared is missing (`missing` is empty). */
  readonly complete: boolean;
}

/** A whole-app coverage report across every declared surface. */
export interface CoverageReport {
  /** Per-surface reports, in the order surfaces were declared. */
  readonly surfaces: readonly SurfaceReport[];
  /** True when every declared surface is complete. */
  readonly complete: boolean;
}

/** Options for {@link SurfaceCoverage.assertFullCoverage}. */
export interface AssertFullCoverageOptions {
  /** Restrict the gate to these surfaces (default: all declared surfaces). Naming an
   *  undeclared surface is a test bug and throws. */
  readonly surfaces?: readonly string[];
}

function sorted(set: ReadonlySet<string>): string[] {
  return [...set].sort();
}

/** Element ids in `a` that are not in `b`. */
function difference(a: ReadonlySet<string>, b: ReadonlySet<string>): string[] {
  const out: string[] = [];
  for (const id of a) {
    if (!b.has(id)) out.push(id);
  }
  return out.sort();
}

/** Element ids present in both `a` and `b`, sorted. */
function intersection(a: ReadonlySet<string>, b: ReadonlySet<string>): string[] {
  const out: string[] = [];
  for (const id of a) {
    if (b.has(id)) out.push(id);
  }
  return out.sort();
}

/**
 * Tracks declared-vs-exercised coverage across an app's surfaces. Construct with an
 * initial set of declared surfaces (or add them later with {@link declareSurface}),
 * {@link record} each element as it is exercised, then {@link report} or
 * {@link assertFullCoverage}.
 */
export class SurfaceCoverage {
  readonly #declared = new Map<string, Set<string>>();
  readonly #exercised = new Map<string, Set<string>>();
  /** Per-surface set of element ids that were exercised via a mock at least once (epic #296,
   *  S4). Additive: an id added here on a mock dispatch (`record(..., true)`) stays even if the
   *  same element is later dispatched for real. A subset of `#exercised`: an element added here
   *  is always also recorded exercised. Used to surface `SurfaceReport.mocked` so a mock-satisfied
   *  element is honest and visible, never a hidden gap. */
  readonly #mocked = new Map<string, Set<string>>();

  /** @param declared surface name → its declared element ids. */
  constructor(declared?: Readonly<Record<string, Iterable<string>>>) {
    if (declared) {
      for (const [surface, ids] of Object.entries(declared)) this.declareSurface(surface, ids);
    }
  }

  /**
   * Declare (or extend) a surface's element set. Idempotent: re-declaring a surface
   * unions the new ids in and never drops already-recorded exercises. Also registers the
   * surface so it appears in {@link report} / {@link assertFullCoverage} even with zero hits.
   */
  declareSurface(surface: string, ids: Iterable<string>): this {
    const declared = this.#declared.get(surface) ?? new Set<string>();
    for (const id of ids) declared.add(id);
    this.#declared.set(surface, declared);
    if (!this.#exercised.has(surface)) this.#exercised.set(surface, new Set<string>());
    return this;
  }

  /** The declared surfaces, in declaration order. */
  surfaces(): string[] {
    return [...this.#declared.keys()];
  }

  /** Mark `id` on `surface` as exercised. A hit on an undeclared surface still records
   *  (surfacing later as `unexpected`), so instrumentation can run before a surface is
   *  declared without losing data. Pass `mocked: true` when the element was exercised via a
   *  mock (epic #296, S4): it still counts as exercised (so it is not a gap), and is
   *  additionally flagged in {@link SurfaceReport.mocked} so the mock is visible, not hidden. */
  record(surface: string, id: string, mocked = false): void {
    const exercised = this.#exercised.get(surface) ?? new Set<string>();
    exercised.add(id);
    this.#exercised.set(surface, exercised);
    if (mocked) {
      const mockedSet = this.#mocked.get(surface) ?? new Set<string>();
      mockedSet.add(id);
      this.#mocked.set(surface, mockedSet);
    }
  }

  /** Build a full coverage {@link CoverageReport}. */
  report(): CoverageReport {
    // Report every surface that was declared OR recorded against, declaration order first.
    const names: string[] = [...this.#declared.keys()];
    for (const name of this.#exercised.keys()) {
      if (!this.#declared.has(name)) names.push(name);
    }
    const surfaces = names.map((surface) => this.#surfaceReport(surface));
    return { surfaces, complete: surfaces.every((s) => s.complete) };
  }

  #surfaceReport(surface: string): SurfaceReport {
    const declared = this.#declared.get(surface) ?? new Set<string>();
    const exercised = this.#exercised.get(surface) ?? new Set<string>();
    const mocked = this.#mocked.get(surface) ?? new Set<string>();
    const missing = difference(declared, exercised);
    return {
      surface,
      declared: sorted(declared),
      exercised: sorted(exercised),
      missing,
      unexpected: difference(exercised, declared),
      // Report only mock-satisfied elements that are actually declared on this surface (mocked ids
      // are exercised by construction, so this is mocked ∩ declared ∩ exercised) — an honest,
      // visible signal that a *declared* element's coverage came via a mock. An undeclared mock hit
      // stays purely `unexpected`, never inflating `mocked` past the documented "declared" contract.
      mocked: intersection(mocked, declared),
      complete: missing.length === 0,
    };
  }

  /**
   * Throw if any gated surface has un-exercised declared elements. The error message
   * lists each incomplete surface with its missing element ids — the actionable "you
   * forgot to test these" gate. Passes silently when coverage is complete.
   */
  assertFullCoverage(opts: AssertFullCoverageOptions = {}): void {
    const gated = opts.surfaces ?? [...this.#declared.keys()];
    const unknown = gated.filter((s) => !this.#declared.has(s));
    if (unknown.length > 0) {
      throw new Error(
        `assertFullCoverage: unknown surface(s) ${unknown.join(", ")}. ` +
          `Declared surfaces: ${this.surfaces().join(", ") || "(none)"}`,
      );
    }
    const gaps = gated
      .map((surface) => this.#surfaceReport(surface))
      .filter((s) => !s.complete);
    if (gaps.length === 0) return;
    const detail = gaps
      .map((s) => `  ${s.surface}: ${s.missing.length} un-exercised → ${s.missing.join(", ")}`)
      .join("\n");
    throw new Error(`Coverage incomplete — declared surface elements were never exercised:\n${detail}`);
  }
}
