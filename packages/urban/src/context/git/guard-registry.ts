// Slice S3 (git/governance) — the mandatory pre-commit guard registry.
//
// This is the seam that makes PII enforcement NON-OPTIONAL and default-DENY BY
// CONSTRUCTION on every write path. A registry is ALWAYS seeded with the S6
// mandatory guard (`preCommitPiiGuard`) as its first, non-removable member:
//
//  - there is no method to remove or replace the default guard, and
//  - a freshly-constructed registry (the default the writer uses when a caller
//    supplies no wiring at all) already contains it,
//
// so a caller cannot silently bypass PII enforcement. Additional guards can only
// be ADDED (making the policy stricter), never subtracted. The writer calls
// {@link PreCommitGuardRegistry.assertAll} immediately before it stages/commits
// any record, so a write carrying PII is rejected before it is ever committed.

import type { PiiCandidate, PiiGuard } from "../pii/index.ts";
import { preCommitPiiGuard } from "../pii/index.ts";

/**
 * An append-only registry of pre-commit guards. The mandatory S6 PII guard is
 * pre-registered as the default and cannot be removed; callers may register
 * ADDITIONAL guards, which run in addition to (never instead of) the default.
 */
export class PreCommitGuardRegistry {
  // Index 0 is ALWAYS the mandatory S6 PII guard. There is no removal API, so it
  // is impossible to end up with a registry that does not enforce it.
  readonly #guards: PiiGuard[];

  /**
   * Build a registry. It is seeded with the mandatory {@link preCommitPiiGuard}
   * first; any `additional` guards are appended after it. Even with no arguments
   * the resulting registry enforces PII by construction.
   */
  constructor(additional: readonly PiiGuard[] = []) {
    this.#guards = [preCommitPiiGuard, ...additional];
  }

  /** Register an ADDITIONAL guard. Cannot displace the mandatory default guard. */
  register(guard: PiiGuard): void {
    this.#guards.push(guard);
  }

  /** A snapshot of the registered guards, in run order (mandatory guard first). */
  get guards(): readonly PiiGuard[] {
    return [...this.#guards];
  }

  /**
   * Run EVERY registered guard against `candidate`. The mandatory PII guard runs
   * first. Each guard is default-DENY: the first guard to detect a violation
   * throws (a {@link import("../pii/index.ts").PiiGuardError} for the PII guard),
   * so a candidate carrying PII never reaches the commit that follows this call.
   */
  assertAll(candidate: PiiCandidate): void {
    for (const guard of this.#guards) {
      guard.assert(candidate);
    }
  }
}
