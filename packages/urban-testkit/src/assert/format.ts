// Shared, fully-deterministic failure-message helpers for the `assertThat*` DSL.
//
// Every matcher across the DSL (`assertThatInstance`, `assertThatUserTask`,
// `assertThatDb`, `assertThatResponse`) reads synchronously from `snapshot()` /
// the read models and throws an intent-revealing `node:assert` `AssertionError`
// on failure. These helpers render deterministic actual-vs-expected diffs and
// throw the error. They MUST stay free of any wall-clock or entropy source —
// no `Date.now`, `setTimeout`/`setInterval`, `Math.random`, or real-time
// `await` — so a failure message is a pure function of its inputs.

import { AssertionError } from "node:assert";

/** Narrow an untyped JSON value to a *plain* object — one whose prototype is
 *  `Object.prototype` or `null`. Exotic objects (`Date`, `Error`, `Map`, `Set`,
 *  class instances, …) are deliberately excluded: treating them as bare records
 *  would make `formatValue` render them as `{}` and make `deepEqual`/`deepSubset`
 *  report two distinct instances (e.g. different `Date`s) as equal because both
 *  expose zero enumerable own keys. */
function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/** Render a value as a stable, human-readable string. Object keys are sorted so
 *  the output is a pure function of the value's contents — two structurally
 *  equal values always render identically, which keeps failure-message
 *  snapshots stable. */
export function formatValue(value: unknown): string {
  return stringify(value, new Set());
}

function stringify(value: unknown, seen: Set<object>): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "undefined":
      return "undefined";
    case "string":
      return JSON.stringify(value);
    case "number":
    case "boolean":
      return String(value);
    case "bigint":
      return `${value.toString()}n`;
    case "symbol":
      return value.toString();
    case "function":
      return `[Function ${value.name === "" ? "anonymous" : value.name}]`;
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) return "[Circular]";
    seen.add(value);
    const body = value.map((item) => stringify(item, seen)).join(", ");
    seen.delete(value);
    return `[${body}]`;
  }
  if (isRecord(value)) {
    if (seen.has(value)) return "[Circular]";
    seen.add(value);
    const body = Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}: ${stringify(value[key], seen)}`)
      .join(", ");
    seen.delete(value);
    return `{${body}}`;
  }
  // Non-plain objects (`Date`, `Error`, …) would otherwise fall to `String(value)`,
  // which is locale/timezone-dependent for `Date` and drops the message for `Error`.
  // Render the common ones deterministically so a failure message stays a pure
  // function of its inputs.
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? "Invalid Date" : value.toISOString();
  }
  if (value instanceof Error) {
    return `[${value.name}: ${value.message}]`;
  }
  return String(value);
}

/** A deterministic two-line `expected` / `actual` block for a failure message. */
export function renderDiff(actual: unknown, expected: unknown): string {
  return `  expected: ${formatValue(expected)}\n  actual:   ${formatValue(actual)}`;
}

export interface FailOptions {
  /** The intent-revealing headline (what was asserted and why it failed). */
  readonly message: string;
  /** The observed value, appended as an actual-vs-expected diff when provided. */
  readonly actual?: unknown;
  /** The wanted value, appended as an actual-vs-expected diff when provided. */
  readonly expected?: unknown;
  /** A short operator label surfaced on the `AssertionError` (defaults to `assertThat`). */
  readonly operator?: string;
  /** Whether to append the actual/expected diff to the message. Defaults to
   *  `true` when either `actual` or `expected` is supplied. */
  readonly diff?: boolean;
}

/** Throw a formatted `node:assert` `AssertionError`. The thrown message names the
 *  actual and expected values (via {@link renderDiff}) so a caller can read the
 *  failure without re-running under a debugger. */
export function failAssertion(options: FailOptions): never {
  const hasValues = "actual" in options || "expected" in options;
  const wantDiff = options.diff ?? hasValues;
  const message = wantDiff
    ? `${options.message}\n${renderDiff(options.actual, options.expected)}`
    : options.message;
  throw new AssertionError({
    message,
    actual: options.actual,
    expected: options.expected,
    operator: options.operator ?? "assertThat",
    stackStartFn: failAssertion,
  });
}

/** Structural deep equality (order-independent for object keys, order-sensitive
 *  for arrays). Shared by value/variable/JSON matchers so the whole DSL compares
 *  values one consistent way. */
export function deepEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    return a.every((item, index) => deepEqual(item, b[index]));
  }
  if (isRecord(a) && isRecord(b)) {
    const aKeys = Object.keys(a);
    const bKeys = Object.keys(b);
    if (aKeys.length !== bKeys.length) return false;
    return aKeys.every((key) => Object.hasOwn(b, key) && deepEqual(a[key], b[key]));
  }
  return false;
}

/** Deep SUBSET match: every key/value in `subset` is present and deep-equal in
 *  `actual` (extra keys in `actual` are ignored). Shared by the `hasVariables` /
 *  `hasJson` / `hasRow` subset matchers. Note the subset relaxation applies to
 *  object keys only: arrays are matched by exact length and positional deep-equal
 *  (a shorter `subset` array is NOT treated as a prefix/subsequence of `actual`). */
export function deepSubset(actual: unknown, subset: unknown): boolean {
  if (isRecord(subset)) {
    if (!isRecord(actual)) return false;
    return Object.keys(subset).every(
      (key) => Object.hasOwn(actual, key) && deepSubset(actual[key], subset[key]),
    );
  }
  if (Array.isArray(subset)) {
    if (!Array.isArray(actual) || actual.length !== subset.length) return false;
    return subset.every((item, index) => deepSubset(actual[index], item));
  }
  return deepEqual(actual, subset);
}
