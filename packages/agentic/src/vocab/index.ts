/**
 * @nanobpm/agentic-vocab — the vocab resolver & core vocabulary for the Nano
 * agentic protocol (ADR 0056, slice S3).
 *
 * Turns the versioned vocab artifact (the ONE capability→token map) into the
 * REGISTER→SERVE handshake: a declared enrolment capability resolves to a
 * deterministic SERVE token set ({@link VocabResolver}); the opinionated core
 * vocabulary ships working out of the box ({@link CORE_VOCAB}); authors extend it
 * in the same schema ({@link mergeVocab}); and the diversity SLO grades seating
 * red / amber / green ({@link computeDiversity} / {@link correlateRegistry}).
 *
 * The wire contract (family set, token grammar, vocab schema, `serve` payload)
 * lives in `@nanobpm/agentic-protocol`; this package builds on it and never
 * redefines it. Capability is NEVER in the routing token — it is the enrolment
 * attribute the `requires` gate reads.
 */
export {
  VocabResolver,
  VocabDocumentError,
  type Resolution,
  type ResolvedRole,
} from "./resolver.ts";

export { CORE_VOCAB, CORE_VOCAB_VERSION } from "./core-vocab.ts";

export { mergeVocab } from "./merge.ts";

export {
  REQUIRES_FIELDS,
  RequiresParseError,
  parseRequires,
  parseRequiresList,
  satisfiesRequires,
  satisfiesPredicate,
  type RequiresField,
  type RequiresOp,
  type RequiresPredicate,
} from "./requires.ts";

export {
  computeDiversity,
  correlateRegistry,
  type DiversityStatus,
  type DiversityReport,
  type RoleDiversity,
  type SeatAssignment,
  type RegisteredWorker,
} from "./diversity.ts";

export {
  buildServePayload,
  buildServeFrame,
  serveCapability,
  type ServeSink,
} from "./serve.ts";
