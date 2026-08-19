/**
 * Small untyped-record inspection helpers shared by the per-harness dialect maps
 * (ADR 0062 slice 3). A native record is untyped input (a `JSON.parse`d
 * `stream-json` line, an SDK event object), so every dialect narrows it the same
 * way: is-it-an-object, read-a-string, read-an-optional-string. Centralising the
 * narrowing keeps the dialects declarative and, crucially, keeps them free of
 * `as`-casts (AGENTS.md) — they narrow through these guards instead.
 */
import { NormalizerDialectError } from "./types.ts";

/** True for a plain (non-array) object; the shape every native record must have. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Describe a non-record value for a dialect error: distinguishes `null` and `array` from the bare `typeof`. */
function describeNonRecord(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

/** Narrow to a record or throw a dialect error attributing the harness. */
export function asRecord(harness: string, value: unknown): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new NormalizerDialectError(harness, `record must be a plain object, got ${describeNonRecord(value)}`);
  }
  return value;
}

/** Read a required string field or throw a dialect error. */
export function reqString(harness: string, obj: Record<string, unknown>, field: string): string {
  const v = obj[field];
  if (typeof v !== "string") {
    throw new NormalizerDialectError(harness, `field "${field}" must be a string, got ${typeof v}`);
  }
  return v;
}

/** Read an optional string field (undefined when absent), throwing on a wrong type. */
export function optString(harness: string, obj: Record<string, unknown>, field: string): string | undefined {
  const v = obj[field];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "string") {
    throw new NormalizerDialectError(harness, `field "${field}" must be a string when present, got ${typeof v}`);
  }
  return v;
}

/** Read an optional finite number field, coercing absent/null to `undefined`. */
export function optNumber(harness: string, obj: Record<string, unknown>, field: string): number | undefined {
  const v = obj[field];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "number" || !Number.isFinite(v)) {
    throw new NormalizerDialectError(harness, `field "${field}" must be a finite number when present, got ${typeof v}`);
  }
  return v;
}

/** Narrow to an array or throw a dialect error. */
export function asArray(harness: string, value: unknown, what: string): readonly unknown[] {
  if (!Array.isArray(value)) {
    throw new NormalizerDialectError(harness, `${what} must be an array, got ${typeof value}`);
  }
  return value;
}

/**
 * Collapse a message-content value to plain text. Harnesses model an assistant
 * message either as a bare string or as an array of typed content parts
 * (`{ type: "text", text }`); we concatenate the text parts and ignore the rest
 * (tool-use parts are lifted to their own events by the dialect). Returns
 * `undefined` when there is no text to emit so the dialect can skip an empty
 * message.
 */
export function contentText(value: unknown): string | undefined {
  if (typeof value === "string") return value.length > 0 ? value : undefined;
  if (!Array.isArray(value)) return undefined;
  let text = "";
  for (const part of value) {
    if (typeof part === "string") {
      text += part;
    } else if (isRecord(part) && part.type === "text" && typeof part.text === "string") {
      text += part.text;
    }
  }
  return text.length > 0 ? text : undefined;
}
