/**
 * The enrolment-capability gate: `requires` predicates.
 *
 * A vocab role's `requires` list is the REGISTRY GATE — it decides WHO may fill
 * the role based on the declared enrolment capability (cognition / weight /
 * family / host). It is deliberately NOT part of the routing token: capability
 * never rides the token (S0 invariant 3); it gates enrolment here.
 *
 * Each `requires` entry is a single predicate over one capability field:
 *
 *   predicate = field op value
 *   field     = cognition | weight | family | host
 *   op        = "=" | "==" | "!=" | ">=" | "<=" | ">" | "<"
 *
 * Ordering/numeric operators (`>=`, `<=`, `>`, `<`) apply to `weight` only (the
 * one numeric capability field); the string fields support only `=`/`==`/`!=`.
 * A role with no `requires` (or an empty list) is open to any capability.
 *
 * Match semantics are FAIL-CLOSED for a gate: an absent field fails every
 * positive predicate (`=`,`==`,`>=`,`<=`,`>`,`<`); only `!=` is satisfied by an
 * absent field (the worker's field is provably not the forbidden value). A
 * capability satisfies a role iff it satisfies EVERY predicate.
 */
import type { Capability } from "../protocol/index.ts";

/** The capability fields a `requires` predicate may gate on. */
export const REQUIRES_FIELDS = ["cognition", "weight", "family", "host"] as const;
export type RequiresField = (typeof REQUIRES_FIELDS)[number];

export type RequiresOp = "=" | "==" | "!=" | ">=" | "<=" | ">" | "<";

/** The numeric field; ordering operators are valid only for it. */
const NUMERIC_FIELD: RequiresField = "weight";
const ORDERING_OPS: ReadonlySet<string> = new Set([">=", "<=", ">", "<"]);
const STRING_FIELDS: ReadonlySet<string> = new Set(["cognition", "family", "host"]);

export interface RequiresPredicate {
  readonly field: RequiresField;
  readonly op: RequiresOp;
  /** The compared value: a number for `weight`, a string otherwise. */
  readonly value: string | number;
  /** The original source text, for diagnostics. */
  readonly source: string;
}

/** Raised when a `requires` entry is not a well-formed predicate. */
export class RequiresParseError extends Error {
  readonly source: string;
  constructor(source: string, detail: string) {
    super(`invalid requires predicate "${source}": ${detail}`);
    this.name = "RequiresParseError";
    this.source = source;
  }
}

// Longest operators first so `>=` is not mis-split as `>`; `==` before `=`.
const PREDICATE_RE = /^(cognition|weight|family|host)\s*(>=|<=|==|!=|=|>|<)\s*(.+?)\s*$/;

const FIELD_SET: ReadonlySet<string> = new Set(REQUIRES_FIELDS);

function isRequiresField(value: string): value is RequiresField {
  return FIELD_SET.has(value);
}

function isRequiresOp(value: string): value is RequiresOp {
  return value === "=" || value === "==" || value === "!=" || value === ">=" || value === "<=" || value === ">" || value === "<";
}

/** Parse one `requires` entry into a predicate, or throw {@link RequiresParseError}. */
export function parseRequires(source: string): RequiresPredicate {
  const match = PREDICATE_RE.exec(source.trim());
  if (match === null) {
    throw new RequiresParseError(source, "expected `field op value` (field: cognition|weight|family|host)");
  }
  const field = match[1];
  const op = match[2];
  const rawValue = match[3];
  if (!isRequiresField(field) || !isRequiresOp(op)) {
    throw new RequiresParseError(source, "unrecognised field or operator");
  }

  if (field === NUMERIC_FIELD) {
    const value = Number(rawValue);
    if (!Number.isFinite(value)) {
      throw new RequiresParseError(source, "weight predicate needs a finite numeric value");
    }
    return { field, op, value, source };
  }

  // String field: reject ordering operators (no total order on strings here).
  if (ORDERING_OPS.has(op)) {
    throw new RequiresParseError(source, `operator ${op} is only valid for the numeric field "weight"`);
  }
  if (!STRING_FIELDS.has(field)) {
    throw new RequiresParseError(source, `field ${field} is not a string field`);
  }
  return { field, op, value: rawValue, source };
}

/** Parse every entry of a role's `requires` list. */
export function parseRequiresList(requires: readonly string[] | undefined): RequiresPredicate[] {
  if (requires === undefined) return [];
  return requires.map(parseRequires);
}

function evalNumeric(op: RequiresOp, actual: number, expected: number): boolean {
  switch (op) {
    case "=":
    case "==":
      return actual === expected;
    case "!=":
      return actual !== expected;
    case ">=":
      return actual >= expected;
    case "<=":
      return actual <= expected;
    case ">":
      return actual > expected;
    case "<":
      return actual < expected;
  }
}

function evalString(op: RequiresOp, actual: string, expected: string): boolean {
  switch (op) {
    case "=":
    case "==":
      return actual === expected;
    case "!=":
      return actual !== expected;
    // Ordering operators are rejected at parse time for string fields.
    default:
      return false;
  }
}

/** True when `capability` satisfies a single predicate (fail-closed on absent fields). */
export function satisfiesPredicate(predicate: RequiresPredicate, capability: Capability): boolean {
  const actual = capability[predicate.field];
  if (actual === undefined) {
    // An absent field can only satisfy a "must NOT equal" predicate.
    return predicate.op === "!=";
  }
  if (predicate.field === NUMERIC_FIELD) {
    if (typeof actual !== "number" || typeof predicate.value !== "number") return false;
    return evalNumeric(predicate.op, actual, predicate.value);
  }
  if (typeof actual !== "string" || typeof predicate.value !== "string") return false;
  return evalString(predicate.op, actual, predicate.value);
}

/** True when `capability` satisfies EVERY predicate (an empty list is open). */
export function satisfiesRequires(predicates: readonly RequiresPredicate[], capability: Capability): boolean {
  return predicates.every((predicate) => satisfiesPredicate(predicate, capability));
}
