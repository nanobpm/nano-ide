// Slice S2 (schema) — the memory-record schema for the Urban context layer.
//
// This module is the RECORD HALF of the published `@nanobpm/urban/context`
// contract (imported as `@nanobpm/urban/context/schema`). The consumer repo
// (`nanobpm/nano-workforce#291`), the git substrate/governance slice (S3), and
// the adversarial slice (S7) all build against the types + validator exported
// here, so the surface is deliberately small, stable, and versioned-friendly.
//
// The central design goal is a FORGERY-RESISTANT-BY-CONSTRUCTION encoding of the
// "hypothesis-never-fix" invariant: an unratified / agent-retrospective prior
// can never be *represented* as a measured / authoritative fact. This is not a
// runtime policy layered on top — it is baked into the controlled vocabulary and
// the cross-field validation rules below, so no code path (governance, retrieval,
// or a hostile caller) can construct a record that launders a hypothesis into a
// fact. S3 relies on this to gate its write path; S7 attacks it directly.

// ---------------------------------------------------------------------------
// Versioning
// ---------------------------------------------------------------------------

/**
 * The only schema version this module accepts. Records must carry it explicitly
 * so a future producer can bump the shape while old consumers reject-with-reason
 * instead of silently mis-reading a newer record.
 */
export const MEMORY_RECORD_SCHEMA_VERSION = 1 as const;
export type MemoryRecordSchemaVersion = typeof MEMORY_RECORD_SCHEMA_VERSION;

// ---------------------------------------------------------------------------
// Controlled vocabulary
// ---------------------------------------------------------------------------

/**
 * The scope ladder — the granularity a record is attached to, from the most
 * specific (a single ladder `element`) up to the whole `corpus`. The array
 * order IS the ladder order (specific → general) and is exported so callers can
 * reason about containment without re-deriving it.
 */
export const SCOPE_LADDER = ["element", "instance", "epic", "repo", "corpus"] as const;
export type MemoryScope = (typeof SCOPE_LADDER)[number];

/**
 * Whether the record asserts a norm (`normative` — "this is how it should be")
 * or an observation (`empirical` — "this is what was measured/seen").
 */
export const MEMORY_MODES = ["normative", "empirical"] as const;
export type MemoryMode = (typeof MEMORY_MODES)[number];

/**
 * Where the record came from:
 *  - `human`       — authored by a person.
 *  - `agent-retro` — a retrospective prior PROPOSED by an agent. Always a
 *                    hypothesis until ratified by governance (S3: merge of a bot
 *                    PR). By construction it can never be authoritative here.
 *  - `measured`    — produced by an empirical measurement. Authoritative fact.
 *  - `instance`    — observed directly from a concrete instance run. Fact.
 */
export const PROVENANCES = ["human", "agent-retro", "measured", "instance"] as const;
export type MemoryProvenance = (typeof PROVENANCES)[number];

/**
 * The authority tier — the forgery target. `hypothesis` is a not-yet-ratified
 * claim; `authoritative` is a ratified fact/fix. The invariants below make it
 * impossible for an `agent-retro` (or otherwise unratified) record to carry the
 * `authoritative` tier. Governance (S3) is the ONLY thing that legitimately
 * mints `authoritative` records, via the ratification transition it owns.
 */
export const AUTHORITIES = ["hypothesis", "authoritative"] as const;
export type MemoryAuthority = (typeof AUTHORITIES)[number];

// ---------------------------------------------------------------------------
// The record
// ---------------------------------------------------------------------------

/**
 * A memory record. The required fields form the stable published contract; the
 * optional fields are additive and safe for consumers to ignore.
 */
export interface MemoryRecord {
  /** Discriminates the schema version (see MEMORY_RECORD_SCHEMA_VERSION). */
  readonly schemaVersion: MemoryRecordSchemaVersion;
  /** Stable, non-empty identifier for the record. */
  readonly id: string;
  /** The ladder level this record is attached to. */
  readonly scope: MemoryScope;
  /** Normative vs empirical. */
  readonly mode: MemoryMode;
  /** Where the record came from. */
  readonly provenance: MemoryProvenance;
  /** Hypothesis vs authoritative — constrained by provenance (see invariants). */
  readonly authority: MemoryAuthority;
  /** The claim/observation the record carries. Non-empty. */
  readonly statement: string;
  /** ISO-8601 timestamp of when the record was created. */
  readonly createdAt: string;
  /** Optional: the specific target within `scope` (e.g. an element id). */
  readonly scopeRef?: string;
  /** Optional: free-form subject/topic the record is about. */
  readonly subject?: string;
  /** Optional: references (ids/urls) backing an empirical/measured claim. */
  readonly evidence?: readonly string[];
  /** Optional: id of a record this one supersedes. */
  readonly supersedes?: string;
}

// ---------------------------------------------------------------------------
// Validation result + errors
// ---------------------------------------------------------------------------

/** A machine-readable validation failure code. */
export type ValidationCode =
  | "not-an-object"
  | "unsupported-schema-version"
  | "missing-field"
  | "wrong-type"
  | "empty-string"
  | "invalid-vocabulary"
  | "invalid-timestamp"
  | "invariant-violation";

/** A single, human- and machine-readable validation error. */
export interface ValidationError {
  /** Dotted path to the offending field (empty for whole-record errors). */
  readonly path: string;
  /** Stable machine code. */
  readonly code: ValidationCode;
  /** Human-readable explanation. */
  readonly message: string;
}

/** The result of validating an untrusted value. */
export type ValidationResult =
  | { readonly ok: true; readonly record: MemoryRecord }
  | { readonly ok: false; readonly errors: readonly ValidationError[] };

// ---------------------------------------------------------------------------
// Small, assertion-free narrowing helpers
// ---------------------------------------------------------------------------

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.length > 0;
}

function includes<T extends string>(vocabulary: readonly T[], v: unknown): v is T {
  return typeof v === "string" && vocabulary.some((entry) => entry === v);
}

function isIsoTimestamp(v: unknown): v is string {
  if (typeof v !== "string" || v.length === 0) return false;
  // Require a real, round-trippable ISO-8601 instant (date + time + zone).
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/.test(v)) {
    return false;
  }
  return Number.isFinite(Date.parse(v));
}

function isStringArray(v: unknown): v is readonly string[] {
  return Array.isArray(v) && v.every((entry) => typeof entry === "string");
}

// ---------------------------------------------------------------------------
// The invariant — the heart of forgery-resistance
// ---------------------------------------------------------------------------

/** The three vocabulary fields the cross-field invariants constrain. */
export interface InvariantContext {
  readonly mode: MemoryMode;
  readonly provenance: MemoryProvenance;
  readonly authority: MemoryAuthority;
}

/**
 * Enumerates every invariant violation in `ctx`. An empty array means the
 * (mode, provenance, authority) triple is internally consistent.
 *
 * The rules, together, guarantee the hypothesis-never-fix invariant:
 *   R1  agent-retro ⇒ hypothesis          (a proposed prior is never a fact)
 *   R2  measured    ⇒ authoritative       (a measurement is a fact, not a guess)
 *   R3  measured    ⇒ empirical           (you cannot "measure" a norm)
 *   R4  instance    ⇒ authoritative       (a real observation is a fact)
 *   R5  instance    ⇒ empirical           (an observation is not a norm)
 *   R6  normative   ⇒ human | agent-retro (only people/agents author norms)
 *
 * A consequence worth stating explicitly (and tested by S7): the ONLY way to
 * reach `authoritative` is provenance ∈ {human, measured, instance}; agent-retro
 * is structurally excluded, so an unratified prior can never be laundered into a
 * fact by any field permutation.
 */
export function checkInvariants(ctx: InvariantContext): readonly ValidationError[] {
  const errors: ValidationError[] = [];
  // Cross-field invariants are whole-record violations (they constrain the
  // mode/provenance/authority triple jointly), so report them at the empty
  // (whole-record) path rather than mis-pointing consumers at `authority`.
  const push = (message: string) =>
    errors.push({ path: "", code: "invariant-violation", message });

  if (ctx.provenance === "agent-retro" && ctx.authority === "authoritative") {
    push(
      "hypothesis-never-fix: an 'agent-retro' prior is unratified and can never be 'authoritative'. Ratification is governance's job (S3: merge of the proposing PR).",
    );
  }
  if (ctx.provenance === "measured" && ctx.authority !== "authoritative") {
    push("a 'measured' record is an empirical fact and must be 'authoritative'.");
  }
  if (ctx.provenance === "measured" && ctx.mode !== "empirical") {
    push("a 'measured' record is an observation and must have mode 'empirical', not 'normative'.");
  }
  if (ctx.provenance === "instance" && ctx.authority !== "authoritative") {
    push("an 'instance' observation is a fact and must be 'authoritative'.");
  }
  if (ctx.provenance === "instance" && ctx.mode !== "empirical") {
    push("an 'instance' observation must have mode 'empirical', not 'normative'.");
  }
  if (ctx.mode === "normative" && !(ctx.provenance === "human" || ctx.provenance === "agent-retro")) {
    push(
      "a 'normative' record asserts a norm and may only be authored by 'human' or proposed by 'agent-retro'.",
    );
  }
  return errors;
}

/** Convenience predicate: is this a ratified, authoritative fact/fix? */
export function isAuthoritative(record: MemoryRecord): boolean {
  return record.authority === "authoritative";
}

// ---------------------------------------------------------------------------
// The validator
// ---------------------------------------------------------------------------

/**
 * Validate an untrusted value as a MemoryRecord. On success returns the record
 * narrowed to `MemoryRecord`; on failure returns EVERY error found (not just the
 * first) so callers can surface all problems at once. Never throws.
 */
export function validateMemoryRecord(input: unknown): ValidationResult {
  const errors: ValidationError[] = [];

  if (!isPlainObject(input)) {
    return {
      ok: false,
      errors: [{ path: "", code: "not-an-object", message: "record must be a plain object." }],
    };
  }

  // Version first — a wrong version means the rest of the shape is unreliable.
  // Distinguish an absent version (missing-field, like every other required
  // field) from a present-but-wrong one (unsupported-schema-version) so the
  // structured error is honest and consistent.
  if (input.schemaVersion !== MEMORY_RECORD_SCHEMA_VERSION) {
    const versionMissing = input.schemaVersion === undefined;
    errors.push({
      path: "schemaVersion",
      code: versionMissing ? "missing-field" : "unsupported-schema-version",
      message: versionMissing
        ? "schemaVersion is required."
        : `unsupported schemaVersion; expected ${MEMORY_RECORD_SCHEMA_VERSION}.`,
    });
  }

  // Capture fields into const locals: TypeScript's aliased-condition narrowing
  // persists a type-guard result across statements only for `const` references,
  // not for repeated property accesses. This lets us build the typed record at
  // the end WITHOUT any `as` cast (forbidden by the biome plugin).
  const idVal: unknown = input.id;
  const statementVal: unknown = input.statement;
  const createdAtVal: unknown = input.createdAt;
  const scopeVal: unknown = input.scope;
  const modeVal: unknown = input.mode;
  const provenanceVal: unknown = input.provenance;
  const authorityVal: unknown = input.authority;

  const idOk = isNonEmptyString(idVal);
  if (!idOk) {
    errors.push({
      path: "id",
      code: idVal === undefined ? "missing-field" : idVal === "" ? "empty-string" : "wrong-type",
      message: "id must be a non-empty string.",
    });
  }
  const statementOk = isNonEmptyString(statementVal);
  if (!statementOk) {
    errors.push({
      path: "statement",
      code: statementVal === undefined ? "missing-field" : statementVal === "" ? "empty-string" : "wrong-type",
      message: "statement must be a non-empty string.",
    });
  }
  const createdAtOk = isIsoTimestamp(createdAtVal);
  if (!createdAtOk) {
    errors.push({
      path: "createdAt",
      code: createdAtVal === undefined ? "missing-field" : "invalid-timestamp",
      message: "createdAt must be an ISO-8601 timestamp with a timezone.",
    });
  }

  const scopeOk = includes(SCOPE_LADDER, scopeVal);
  if (!scopeOk) {
    errors.push({ path: "scope", code: scopeVal === undefined ? "missing-field" : "invalid-vocabulary", message: `scope must be one of: ${SCOPE_LADDER.join(", ")}.` });
  }
  const modeOk = includes(MEMORY_MODES, modeVal);
  if (!modeOk) {
    errors.push({ path: "mode", code: modeVal === undefined ? "missing-field" : "invalid-vocabulary", message: `mode must be one of: ${MEMORY_MODES.join(", ")}.` });
  }
  const provenanceOk = includes(PROVENANCES, provenanceVal);
  if (!provenanceOk) {
    errors.push({ path: "provenance", code: provenanceVal === undefined ? "missing-field" : "invalid-vocabulary", message: `provenance must be one of: ${PROVENANCES.join(", ")}.` });
  }
  const authorityOk = includes(AUTHORITIES, authorityVal);
  if (!authorityOk) {
    errors.push({ path: "authority", code: authorityVal === undefined ? "missing-field" : "invalid-vocabulary", message: `authority must be one of: ${AUTHORITIES.join(", ")}.` });
  }

  // Optional fields: reject wrong types, ignore when absent.
  const scopeRefVal: unknown = input.scopeRef;
  const subjectVal: unknown = input.subject;
  const evidenceVal: unknown = input.evidence;
  const supersedesVal: unknown = input.supersedes;
  if (scopeRefVal !== undefined && !isNonEmptyString(scopeRefVal)) {
    errors.push({ path: "scopeRef", code: "wrong-type", message: "scopeRef, if present, must be a non-empty string." });
  }
  if (subjectVal !== undefined && typeof subjectVal !== "string") {
    errors.push({ path: "subject", code: "wrong-type", message: "subject, if present, must be a string." });
  }
  if (evidenceVal !== undefined && !isStringArray(evidenceVal)) {
    errors.push({ path: "evidence", code: "wrong-type", message: "evidence, if present, must be an array of strings." });
  }
  if (supersedesVal !== undefined && !isNonEmptyString(supersedesVal)) {
    errors.push({ path: "supersedes", code: "wrong-type", message: "supersedes, if present, must be a non-empty string." });
  }

  // Cross-field invariants can only run once the vocabulary fields are sound.
  if (modeOk && provenanceOk && authorityOk) {
    for (const err of checkInvariants({ mode: modeVal, provenance: provenanceVal, authority: authorityVal })) {
      errors.push(err);
    }
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  // All guards passed; aliased narrowing makes the const locals fully typed here.
  if (!scopeOk || !modeOk || !provenanceOk || !authorityOk || !idOk || !statementOk || !createdAtOk) {
    return { ok: false, errors: [{ path: "", code: "wrong-type", message: "internal: unexpected narrowing failure." }] };
  }

  const record: MemoryRecord = {
    schemaVersion: MEMORY_RECORD_SCHEMA_VERSION,
    id: idVal,
    scope: scopeVal,
    mode: modeVal,
    provenance: provenanceVal,
    authority: authorityVal,
    statement: statementVal,
    createdAt: createdAtVal,
    ...(isNonEmptyString(scopeRefVal) ? { scopeRef: scopeRefVal } : {}),
    ...(typeof subjectVal === "string" ? { subject: subjectVal } : {}),
    ...(isStringArray(evidenceVal) ? { evidence: evidenceVal } : {}),
    ...(isNonEmptyString(supersedesVal) ? { supersedes: supersedesVal } : {}),
  };
  return { ok: true, record };
}

/** Type guard form of {@link validateMemoryRecord}. */
export function isMemoryRecord(input: unknown): input is MemoryRecord {
  return validateMemoryRecord(input).ok;
}

/** Error thrown by {@link assertMemoryRecord}. Carries the structured errors. */
export class MemoryRecordValidationError extends Error {
  readonly errors: readonly ValidationError[];
  constructor(errors: readonly ValidationError[]) {
    super(`invalid memory record: ${errors.map((e) => `${e.path || "<record>"}: ${e.message}`).join("; ")}`);
    this.name = "MemoryRecordValidationError";
    this.errors = errors;
  }
}

/**
 * Throwing form: returns the validated record or throws
 * {@link MemoryRecordValidationError}. Handy for governance/write paths that
 * treat an invalid record as a hard failure.
 */
export function assertMemoryRecord(input: unknown): MemoryRecord {
  const result = validateMemoryRecord(input);
  if (!result.ok) {
    throw new MemoryRecordValidationError(result.errors);
  }
  return result.record;
}
