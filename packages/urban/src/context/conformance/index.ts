// Slice S2 (conformance) — the shared conformance corpus + a reusable runner.
//
// Published as `@nanobpm/urban/context/conformance`. This subpath IS the
// contract: BOTH the producer (this repo) and the consumer
// (`nanobpm/nano-workforce#291`) are held to the SAME corpus, and the
// adversarial slice (S7) imports the corpus + runner from here directly. It is
// intentionally self-contained — it does NOT re-export the schema module, so a
// consumer can import it without pulling the whole schema surface, and the top
// barrel never sees a duplicate symbol.
//
// The runner is a PURE function over a validator callback (no test framework),
// so any party can point it at their own validator and get a structured report.
// The `.conformance.ts` sibling wires it into `node:test` for `test:conformance`.

import { SCOPE_LADDER } from "../schema/index.ts";

// ---------------------------------------------------------------------------
// Public shapes
// ---------------------------------------------------------------------------

/** Whether the corpus expects a validator to accept or reject an input. */
export type ConformanceExpectation = "accept" | "reject";

/** A single corpus entry: an input and the outcome every conformant validator must produce. */
export interface ConformanceCase {
  /** Unique, stable, human-readable case name. */
  readonly name: string;
  /** The required outcome. */
  readonly expect: ConformanceExpectation;
  /** The (untrusted) value fed to the validator. */
  readonly input: unknown;
  /** Why this case exists / what rule it exercises. */
  readonly note: string;
}

/**
 * The minimal validator contract the corpus tests. A conformant validator maps
 * an untrusted value to an accept/reject decision via `{ ok }`. Both
 * `validateMemoryRecord` (result form) and `isMemoryRecord` (boolean) can be
 * adapted to this shape — see {@link fromResultValidator}.
 */
export type ConformanceValidator = (input: unknown) => { readonly ok: boolean };

/** The outcome of running one case through a validator. */
export interface ConformanceCaseResult {
  readonly case: ConformanceCase;
  readonly expected: ConformanceExpectation;
  readonly actual: ConformanceExpectation;
  readonly passed: boolean;
}

/** The aggregate report from {@link runConformance}. */
export interface ConformanceReport {
  readonly total: number;
  readonly passed: number;
  readonly failed: number;
  readonly results: readonly ConformanceCaseResult[];
  readonly failures: readonly ConformanceCaseResult[];
}

// ---------------------------------------------------------------------------
// Corpus construction
// ---------------------------------------------------------------------------

interface Triple {
  readonly mode: string;
  readonly provenance: string;
  readonly authority: string;
}

/**
 * Every (provenance, mode, authority) triple that is VALID by the schema
 * invariants. Instantiated across all scopes below, this covers every
 * scope × provenance × mode combination that a well-formed record can take.
 */
const VALID_TRIPLES: readonly Triple[] = [
  { provenance: "human", mode: "normative", authority: "hypothesis" },
  { provenance: "human", mode: "normative", authority: "authoritative" },
  { provenance: "human", mode: "empirical", authority: "hypothesis" },
  { provenance: "human", mode: "empirical", authority: "authoritative" },
  { provenance: "agent-retro", mode: "normative", authority: "hypothesis" },
  { provenance: "agent-retro", mode: "empirical", authority: "hypothesis" },
  { provenance: "measured", mode: "empirical", authority: "authoritative" },
  { provenance: "instance", mode: "empirical", authority: "authoritative" },
];

/**
 * Every (provenance, mode, authority) triple that MUST be rejected by the
 * invariants, with the rule it violates. The first two are the headline
 * hypothesis-never-fix invariant (agent-retro can never be authoritative).
 */
const INVALID_TRIPLES: readonly (Triple & { readonly why: string })[] = [
  { provenance: "agent-retro", mode: "normative", authority: "authoritative", why: "hypothesis-never-fix: agent-retro can never be authoritative" },
  { provenance: "agent-retro", mode: "empirical", authority: "authoritative", why: "hypothesis-never-fix: agent-retro can never be authoritative" },
  { provenance: "measured", mode: "empirical", authority: "hypothesis", why: "measured must be authoritative" },
  { provenance: "measured", mode: "normative", authority: "authoritative", why: "measured must be empirical, not normative" },
  { provenance: "instance", mode: "empirical", authority: "hypothesis", why: "instance must be authoritative" },
  { provenance: "instance", mode: "normative", authority: "authoritative", why: "instance must be empirical, not normative" },
];

function baseRecord(scope: string, triple: Triple): Record<string, unknown> {
  return {
    schemaVersion: 1,
    id: `rec-${scope}-${triple.provenance}-${triple.mode}-${triple.authority}`,
    scope,
    mode: triple.mode,
    provenance: triple.provenance,
    authority: triple.authority,
    statement: `example ${triple.mode} ${triple.provenance} record at ${scope} scope`,
    createdAt: "2026-01-01T00:00:00.000Z",
  };
}

function buildCombinationalCases(): readonly ConformanceCase[] {
  const cases: ConformanceCase[] = [];
  for (const scope of SCOPE_LADDER) {
    for (const triple of VALID_TRIPLES) {
      cases.push({
        name: `accept ${scope}/${triple.mode}/${triple.provenance}/${triple.authority}`,
        expect: "accept",
        input: baseRecord(scope, triple),
        note: "well-formed record; valid vocabulary + consistent invariants",
      });
    }
    for (const triple of INVALID_TRIPLES) {
      cases.push({
        name: `reject ${scope}/${triple.mode}/${triple.provenance}/${triple.authority}`,
        expect: "reject",
        input: baseRecord(scope, triple),
        note: triple.why,
      });
    }
  }
  return cases;
}

/** Structural / vocabulary-drift rejects that are independent of scope. */
const STRUCTURAL_CASES: readonly ConformanceCase[] = [
  { name: "reject non-object (number)", expect: "reject", input: 42, note: "record must be an object" },
  { name: "reject non-object (null)", expect: "reject", input: null, note: "record must be an object" },
  { name: "reject non-object (array)", expect: "reject", input: [], note: "record must be a plain object, not an array" },
  {
    name: "reject unsupported schemaVersion",
    expect: "reject",
    input: { schemaVersion: 2, id: "x", scope: "repo", mode: "empirical", provenance: "human", authority: "authoritative", statement: "s", createdAt: "2026-01-01T00:00:00.000Z" },
    note: "schemaVersion must be exactly 1",
  },
  {
    name: "reject missing schemaVersion",
    expect: "reject",
    input: { id: "x", scope: "repo", mode: "empirical", provenance: "human", authority: "authoritative", statement: "s", createdAt: "2026-01-01T00:00:00.000Z" },
    note: "schemaVersion is required",
  },
  {
    name: "reject missing id",
    expect: "reject",
    input: { schemaVersion: 1, scope: "repo", mode: "empirical", provenance: "human", authority: "authoritative", statement: "s", createdAt: "2026-01-01T00:00:00.000Z" },
    note: "id is required",
  },
  {
    name: "reject empty statement",
    expect: "reject",
    input: { schemaVersion: 1, id: "x", scope: "repo", mode: "empirical", provenance: "human", authority: "authoritative", statement: "", createdAt: "2026-01-01T00:00:00.000Z" },
    note: "statement must be non-empty",
  },
  {
    name: "reject drifted scope vocabulary",
    expect: "reject",
    input: { schemaVersion: 1, id: "x", scope: "galaxy", mode: "empirical", provenance: "human", authority: "authoritative", statement: "s", createdAt: "2026-01-01T00:00:00.000Z" },
    note: "scope must be in the ladder vocabulary",
  },
  {
    name: "reject drifted mode vocabulary",
    expect: "reject",
    input: { schemaVersion: 1, id: "x", scope: "repo", mode: "prescriptive", provenance: "human", authority: "authoritative", statement: "s", createdAt: "2026-01-01T00:00:00.000Z" },
    note: "mode must be normative|empirical",
  },
  {
    name: "reject drifted provenance vocabulary",
    expect: "reject",
    input: { schemaVersion: 1, id: "x", scope: "repo", mode: "empirical", provenance: "robot", authority: "authoritative", statement: "s", createdAt: "2026-01-01T00:00:00.000Z" },
    note: "provenance must be in the vocabulary",
  },
  {
    name: "reject drifted authority vocabulary",
    expect: "reject",
    input: { schemaVersion: 1, id: "x", scope: "repo", mode: "empirical", provenance: "human", authority: "supreme", statement: "s", createdAt: "2026-01-01T00:00:00.000Z" },
    note: "authority must be hypothesis|authoritative",
  },
  {
    name: "reject non-ISO timestamp",
    expect: "reject",
    input: { schemaVersion: 1, id: "x", scope: "repo", mode: "empirical", provenance: "human", authority: "authoritative", statement: "s", createdAt: "yesterday" },
    note: "createdAt must be ISO-8601",
  },
  {
    name: "reject wrong-typed id",
    expect: "reject",
    input: { schemaVersion: 1, id: 123, scope: "repo", mode: "empirical", provenance: "human", authority: "authoritative", statement: "s", createdAt: "2026-01-01T00:00:00.000Z" },
    note: "id must be a string",
  },
  {
    name: "reject wrong-typed evidence",
    expect: "reject",
    input: { schemaVersion: 1, id: "x", scope: "repo", mode: "empirical", provenance: "measured", authority: "authoritative", statement: "s", createdAt: "2026-01-01T00:00:00.000Z", evidence: "not-an-array" },
    note: "evidence, if present, must be a string array",
  },
  {
    name: "accept well-formed measured record with evidence + optionals",
    expect: "accept",
    input: { schemaVersion: 1, id: "x", scope: "instance", scopeRef: "elem-7", subject: "latency", mode: "empirical", provenance: "measured", authority: "authoritative", statement: "p99 improved", createdAt: "2026-01-01T00:00:00.000Z", evidence: ["run-1", "run-2"], supersedes: "rec-old" },
    note: "optional fields accepted when well-typed",
  },
];

/**
 * The full conformance corpus: exhaustive scope × valid/invalid triples, plus
 * structural and vocabulary-drift cases. Deterministic and stable — treat it as
 * the versioned contract fixture both producer and consumer are held to.
 */
export const corpus: readonly ConformanceCase[] = [...buildCombinationalCases(), ...STRUCTURAL_CASES];

/** The subset of the corpus that must be accepted. */
export const validFixtures: readonly ConformanceCase[] = corpus.filter((c) => c.expect === "accept");

/** The subset of the corpus that must be rejected. */
export const invalidFixtures: readonly ConformanceCase[] = corpus.filter((c) => c.expect === "reject");

// ---------------------------------------------------------------------------
// The runner
// ---------------------------------------------------------------------------

/**
 * Adapt a `{ ok } | { ... }`-returning validator (like `validateMemoryRecord`)
 * to the {@link ConformanceValidator} shape. Any function returning an object
 * with a boolean `ok` already conforms; this is a typed identity helper.
 */
export function fromResultValidator(validate: (input: unknown) => { readonly ok: boolean }): ConformanceValidator {
  return (input: unknown) => ({ ok: validate(input).ok });
}

/**
 * Run `validate` against the corpus (or a supplied subset) and return a
 * structured report. Pure: does not throw and does not depend on a test runner.
 */
export function runConformance(
  validate: ConformanceValidator,
  cases: readonly ConformanceCase[] = corpus,
): ConformanceReport {
  const results: ConformanceCaseResult[] = cases.map((c) => {
    const actual: ConformanceExpectation = validate(c.input).ok ? "accept" : "reject";
    return { case: c, expected: c.expect, actual, passed: actual === c.expect };
  });
  const failures = results.filter((r) => !r.passed);
  return {
    total: results.length,
    passed: results.length - failures.length,
    failed: failures.length,
    results,
    failures,
  };
}

/**
 * Assert full conformance: throws with a readable summary if any case fails.
 * Consumers can call this in their own test suite to be held to the contract.
 */
export function assertConformance(validate: ConformanceValidator, cases: readonly ConformanceCase[] = corpus): void {
  const report = runConformance(validate, cases);
  if (report.failed > 0) {
    const detail = report.failures
      .map((f) => `  - ${f.case.name}: expected ${f.expected}, got ${f.actual} (${f.case.note})`)
      .join("\n");
    throw new Error(`conformance failed: ${report.failed}/${report.total} case(s):\n${detail}`);
  }
}
