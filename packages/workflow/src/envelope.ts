// Typed data envelopes — the code-first expression of a nano:shape.
//
// An envelope declares a named, typed payload contract IN CODE. It carries two
// things at once:
//   - a runtime schema (ordered fields + scalar types), which the model emitter
//     LIFTS into the BPMN as a `nano:shape` (under `nano:shapes` on the process)
//     plus the `io.nanobpm.dataEnvelope.in/out` `zeebe:property` on the service
//     task / message — exactly the carrier the console derives worker I/O from
//     (server/src/console/envelope_scan.rs); and
//   - a phantom TypeScript type, inferred from the field spec, so `run`/`task`
//     handlers and message payloads are statically typed at the call site.
//
// This is what makes code-first EJECTABLE to model-first: the generated `.bpmn`
// already carries the typed shapes + envelope wiring the modeller and the Fused
// Domain Model (ADR 0040) expect, so opening it in the Modeller loses nothing.
//
//   const PrReviewRoundIn = envelope("PrReviewRoundIn", {
//     prUrl: "string", repo: "string", prNumber: "integer",
//     prompt: "string", round: "integer",
//     answer: { type: "string", optional: true },
//   });
//   // PrReviewRoundIn.type  ≅  { prUrl: string; repo: string; prNumber: number;
//   //                            prompt: string; round: number; answer?: string }

import { assertIdent } from "./xml.js";

/** The scalar types a `nano:extend` field may declare (mirrors the vocabulary
 *  the console's shape scan understands). `integer`/`number` are both `number`
 *  in TS; `datetime` is an ISO `string`. */
export type ScalarType = "string" | "integer" | "number" | "boolean" | "datetime";

/** Map a scalar envelope type to its TypeScript representation. */
export type ScalarTs<T extends ScalarType> = T extends "string" | "datetime"
  ? string
  : T extends "integer" | "number"
    ? number
    : T extends "boolean"
      ? boolean
      : never;

/** A field spec: either a bare scalar type, or an object with modifiers. */
export type FieldSpec =
  | ScalarType
  | { type: ScalarType; optional?: boolean; list?: boolean };

/** The TS type of a single field spec (applies `list` before `optional`). A spec
 *  whose `list` isn't a literal (the widened `FieldSpec` of a plain `Envelope`) may
 *  be either, so a declared envelope with list fields still fits `Envelope`. */
export type FieldTs<F> = F extends ScalarType
  ? ScalarTs<F>
  : F extends { type: infer T extends ScalarType; list: true }
    ? ScalarTs<T>[]
    : F extends { type: infer T extends ScalarType; list?: false }
      ? ScalarTs<T>
      : F extends { type: infer T extends ScalarType }
        ? ScalarTs<T> | ScalarTs<T>[]
        : never;

type OptionalKeys<S> = {
  [K in keyof S]: S[K] extends { optional: true } ? K : never;
}[keyof S];
type RequiredKeys<S> = Exclude<keyof S, OptionalKeys<S>>;

/** The inferred payload type of an envelope: required + optional fields. */
export type EnvelopeType<S extends Record<string, FieldSpec>> = {
  [K in RequiredKeys<S>]: FieldTs<S[K]>;
} & {
  [K in OptionalKeys<S>]?: FieldTs<S[K]>;
};

/** A normalised field, as stored on an `Envelope` and lifted to `nano:extend`. */
export interface EnvelopeField {
  name: string;
  type: ScalarType;
  optional: boolean;
  list: boolean;
}

/**
 * A typed data envelope: a named schema (for the model) plus a phantom TS type
 * (for the call site). Construct with {@link envelope}. `type` is a phantom
 * property — it is `undefined` at runtime and exists only to carry the inferred
 * payload type (use `typeof env.type` in type positions).
 */
export interface Envelope<S extends Record<string, FieldSpec> = Record<string, FieldSpec>> {
  readonly name: string;
  readonly fields: EnvelopeField[];
  /** Phantom: the inferred payload type. Do not read at runtime. */
  readonly type: EnvelopeType<S>;
}

const SCALARS: ReadonlySet<string> = new Set([
  "string",
  "integer",
  "number",
  "boolean",
  "datetime",
]);

class EnvelopeDef<S extends Record<string, FieldSpec>> implements Envelope<S> {
  readonly type!: EnvelopeType<S>;

  constructor(
    readonly name: string,
    readonly fields: EnvelopeField[],
  ) {}
}

function normaliseField(name: string, spec: FieldSpec): EnvelopeField {
  if (spec === null || (typeof spec !== "string" && typeof spec !== "object")) {
    throw new Error(`envelope field "${name}": must be a scalar type or a { type, optional?, list? } object`);
  }
  const raw = typeof spec === "string" ? { type: spec } : spec;
  if (!SCALARS.has(raw.type)) {
    throw new Error(
      `envelope field "${name}": unknown type "${raw.type}" (expected one of ${[...SCALARS].join(", ")})`,
    );
  }
  return {
    name,
    type: raw.type,
    optional: typeof spec === "object" && spec.optional === true,
    list: typeof spec === "object" && spec.list === true,
  };
}

/**
 * Declare a typed data envelope. `name` becomes the `nano:shape` id lifted into
 * the model (must be a valid BPMN identifier); `fields` declares the payload.
 * The returned envelope's `type` phantom carries the inferred TS payload type.
 */
export function envelope<const S extends Record<string, FieldSpec>>(
  name: string,
  fields: S,
): Envelope<S> {
  assertIdent("envelope name", name);
  const list = Object.entries(fields).map(([k, v]) => normaliseField(k, v));
  if (list.length === 0) throw new Error(`envelope "${name}" declares no fields`);
  for (const f of list) assertIdent("envelope field name", f.name);
  return new EnvelopeDef(name, list);
}

/** One way a value fails its envelope: the field (or "" for the value itself) and why. */
export interface EnvelopeProblem {
  field: string;
  message: string;
}

const DATETIME = /^(\d{4})-(\d{2})-(\d{2})([Tt ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?([Zz]|[+-]\d{2}:?\d{2})?)?$/;

/** A real calendar day: `Date.parse` rolls 2026-02-30 over to March instead of rejecting it. */
function isCalendarDate(y: number, m: number, d: number): boolean {
  const leap = (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return m >= 1 && m <= 12 && d >= 1 && d <= days[m - 1];
}

function isDatetime(v: unknown): boolean {
  if (typeof v !== "string") return false;
  const m = DATETIME.exec(v);
  return !!m && isCalendarDate(Number(m[1]), Number(m[2]), Number(m[3])) && !Number.isNaN(Date.parse(v));
}

function scalarProblem(type: ScalarType, v: unknown): string | undefined {
  switch (type) {
    case "string":
      return typeof v === "string" ? undefined : "must be a string";
    case "boolean":
      return typeof v === "boolean" ? undefined : "must be true or false";
    case "number":
      return typeof v === "number" && Number.isFinite(v) ? undefined : "must be a number";
    case "integer":
      return typeof v === "number" && Number.isInteger(v) ? undefined : "must be a whole number";
    case "datetime":
      return isDatetime(v)
        ? undefined
        : "must be an ISO 8601 date or date-time";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Check a value against an envelope: every required field present (not `undefined`
 * or `null`), and each supplied field of its declared scalar type (a `list` field an
 * array of it). An optional field may be absent, but a supplied `null` is checked like
 * any other value (and fails). Fields the envelope doesn't declare are allowed — an envelope is the
 * data a step needs, not all it may see. Returns the problems (empty = valid); it
 * does not coerce. Use it where untyped data enters a typed flow, e.g. the variables
 * a new instance is started with, checked against `flow.input`.
 */
export function validateEnvelope(env: Pick<Envelope, "name" | "fields">, value: unknown): EnvelopeProblem[] {
  if (!isRecord(value)) return [{ field: "", message: `${env.name} must be an object` }];
  const problems: EnvelopeProblem[] = [];
  for (const f of env.fields) {
    // Own properties only: `{}` has no `constructor` field of its own.
    const v = Object.hasOwn(value, f.name) ? value[f.name] : undefined;
    if (v === undefined || (v === null && !f.optional)) {
      if (!f.optional) problems.push({ field: f.name, message: "is required" });
      continue;
    }
    if (f.list) {
      if (!Array.isArray(v)) {
        problems.push({ field: f.name, message: "must be a list" });
        continue;
      }
      const bad = v.findIndex((item) => scalarProblem(f.type, item) !== undefined);
      if (bad >= 0) problems.push({ field: f.name, message: `item ${bad} ${scalarProblem(f.type, v[bad])}` });
      continue;
    }
    const p = scalarProblem(f.type, v);
    if (p) problems.push({ field: f.name, message: p });
  }
  return problems;
}
