// @nanobpm/urban/context/pii — slice S6 CORE (pii guard-core).
//
// The enforcement seam of the Urban context layer. It publishes two things:
//
//  1. A PURE PII classifier (`classifyPii`) — inspects candidate record content
//     and returns a located clean/violation decision. Reusable on any hot path
//     and by the S6 CI slice's build-time scan.
//  2. A MANDATORY, default-DENY pre-commit guard (`preCommitPiiGuard` /
//     `createPiiGuard`) built on the classifier. S3 (git substrate / governance)
//     registers this as the NON-OPTIONAL default pre-commit step on every write
//     path, so PII is blocked BY CONSTRUCTION — not merely when a caller opts in.
//
// Contract summary (see ./guard.ts and ./NOTES.md for detail):
//   guard.assert(candidate)  → void when clean, THROWS PiiGuardError on PII.
//   guard.inspect(candidate) → non-throwing PiiClassification.
//
// The MVP substrate is no-PII by construction; this slice builds neither a
// mutable/erasure backend nor the CI workflow (that is the later S6 CI slice,
// which layers a build-time net + erasure/immutability docs on top of this).
//
// This slice imports the record types from `../schema` but NOT `../git`: S3
// imports us, so the dependency points one way and the graph stays acyclic.

export {
  type PiiKind,
  type PiiFinding,
  type PiiClassification,
  type PiiCandidate,
  classifyPii,
  isPiiClean,
} from "./classifier.ts";

export {
  type PiiGuard,
  type PiiGuardOptions,
  PiiGuardError,
  createPiiGuard,
  preCommitPiiGuard,
} from "./guard.ts";
