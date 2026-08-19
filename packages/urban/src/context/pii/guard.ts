// Slice S6 CORE (pii guard-core) — the MANDATORY pre-commit PII guard.
//
// This is the enforcement seam S3 (git substrate / governance) consumes. It
// wraps the pure classifier (`./classifier.ts`) in a default-DENY policy: a
// candidate carrying PII is REJECTED (the guard throws); clean content passes
// through untouched.
//
// ┌────────────────────────────────────────────────────────────────────────┐
// │ CONTRACT — read before wiring:                                          │
// │   guard.assert(candidate)  → returns void when clean, THROWS            │
// │                              PiiGuardError when PII is detected.        │
// │   guard.inspect(candidate) → non-throwing; returns the classification.  │
// │                                                                          │
// │ S3 MUST register `preCommitPiiGuard` (or a `createPiiGuard()` instance) │
// │ as the NON-OPTIONAL, default pre-commit step on EVERY write path, so    │
// │ PII is blocked BY CONSTRUCTION — not merely when a caller opts in. The  │
// │ later S6 CI slice adds a build-time classification workflow +           │
// │ erasure/immutability docs on TOP of this in-process guard; it must not  │
// │ weaken or bypass it.                                                    │
// └────────────────────────────────────────────────────────────────────────┘
//
// This slice owns the classifier + guard ONLY. It has no git / network access
// and does NOT import `../git` (S3 imports us — the dependency points one way to
// keep the graph acyclic).

import {
  classifyPii,
  type PiiCandidate,
  type PiiClassification,
  type PiiFinding,
} from "./classifier.ts";

/**
 * Thrown by {@link PiiGuard.assert} (and the default guard) when a candidate
 * carries PII. Carries the located {@link PiiFinding}s so callers can log /
 * surface exactly what was rejected without re-running the classifier.
 */
export class PiiGuardError extends Error {
  /** The located detections that caused the rejection (never empty). */
  readonly findings: readonly PiiFinding[];

  constructor(findings: readonly PiiFinding[]) {
    const summary = findings
      .map((f) => `${f.kind}${f.path ? ` @ ${f.path}` : ""}`)
      .join(", ");
    super(`PII pre-commit guard rejected the write: ${summary}`);
    this.name = "PiiGuardError";
    // Defensively snapshot: a caller mutating the array it passed in must never
    // retroactively change what this error reports it rejected.
    this.findings = Object.freeze([...findings]);
  }
}

/**
 * A pre-commit guard. The published seam S3 registers as its default,
 * non-bypassable write-path check.
 *
 * Implementations MUST be default-DENY: {@link assert} throws on any detected
 * PII and returns normally only for clean content.
 */
export interface PiiGuard {
  /** Stable identifier (useful when a registry holds several guards). */
  readonly name: string;
  /**
   * Non-throwing classification — returns the decision so a caller can inspect
   * findings without catching. Does not enforce policy on its own.
   */
  inspect(candidate: PiiCandidate): PiiClassification;
  /**
   * Default-DENY enforcement. Returns `void` when the candidate is clean;
   * THROWS {@link PiiGuardError} (carrying the findings) when PII is detected.
   * This is the method a write path calls immediately before committing.
   */
  assert(candidate: PiiCandidate): void;
}

/**
 * Options for {@link createPiiGuard}. Additive and backward-compatible; the
 * default (no options) is the mandatory, no-PII-by-construction guard.
 */
export interface PiiGuardOptions {
  /** Override the guard's `name` (defaults to `"pre-commit-pii-guard"`). */
  readonly name?: string;
  /**
   * An ADDITIONAL classifier, unioned with the built-in {@link classifyPii}.
   * The built-in classifier ALWAYS runs; this override's findings are merged on
   * top, so an override can only make the guard STRICTER — it can never suppress
   * a built-in detection or otherwise disable enforcement (a guard is always
   * default-DENY). Intended for tests and for a future stricter policy.
   */
  readonly classify?: (candidate: PiiCandidate) => PiiClassification;
}

/**
 * Build a default-DENY PII guard. With no options this returns the same policy
 * as {@link preCommitPiiGuard}: it classifies with the built-in classifier and
 * rejects any candidate that carries PII. A caller-supplied `classify` runs IN
 * ADDITION to the built-in classifier (findings are unioned), so it can only
 * ever make the guard stricter — never weaker.
 */
export function createPiiGuard(options: PiiGuardOptions = {}): PiiGuard {
  const name = options.name ?? "pre-commit-pii-guard";
  const override = options.classify;
  // The built-in classifier ALWAYS runs; an override can only ADD findings.
  // This makes the `classify` option unable to disable the default-DENY guard.
  const classify = (candidate: PiiCandidate): PiiClassification => {
    const base = classifyPii(candidate);
    if (override === undefined) return base;
    const extra = override(candidate);
    const findings = [...base.findings, ...extra.findings];
    // Derive the verdict from the merged findings — the single source of truth.
    // A guard is default-DENY, so any `!clean` classification MUST carry the
    // findings that justify it; a non-clean result with no findings would make
    // `assert` throw a PiiGuardError whose summary is empty, contradicting the
    // "findings are never empty" contract. Surface that override bug loudly
    // rather than as a confusing, empty rejection.
    if (findings.length === 0 && (!base.clean || !extra.clean)) {
      throw new TypeError(
        "PII classifier override returned a non-clean classification with no findings; " +
          "an override may only ADD located findings, never report PII without locating it.",
      );
    }
    return findings.length === 0
      ? { clean: true, findings: [] }
      : { clean: false, findings };
  };
  return {
    name,
    inspect(candidate) {
      return classify(candidate);
    },
    assert(candidate) {
      const result = classify(candidate);
      if (!result.clean) throw new PiiGuardError(result.findings);
    },
  };
}

/**
 * The ready-to-use default guard. S3 registers THIS instance as the
 * non-optional, default pre-commit step on every write path so that PII is
 * blocked by construction. Do not gate it behind a caller opt-in.
 */
export const preCommitPiiGuard: PiiGuard = createPiiGuard();
