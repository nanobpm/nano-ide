// `assertThatResponse` — fluent assertions over an already-resolved HTTP
// `ApiResponse`, the second of the two Urban surfaces the process-engine DSL has
// no analog for.
//
// The response has already been driven and resolved (via `app.api.call` /
// `app.callRoute`), so every matcher here is FULLY SYNCHRONOUS — it inspects the
// captured `status` / `body` / `headers` and chains. Nothing awaits, polls, or
// reads a clock: no `Date.now`/`setTimeout`/`Math.random`, so a failure message is
// a pure function of the response.

import type { ApiResponse } from "../openapi-driver.ts";
import { deepSubset, failAssertion, formatValue } from "./format.ts";

/** Fluent, synchronous assertions over an already-resolved HTTP response's
 *  status, JSON body, and headers. Each matcher returns the same object so calls
 *  chain. */
export interface ResponseAssert<T> {
  /** Assert the response status equals `code`. */
  hasStatus(code: number): ResponseAssert<T>;
  /** Assert the parsed JSON body deep-matches `subset` (a SUBSET match — extra
   *  keys on the body are ignored). */
  hasJson(subset: unknown): ResponseAssert<T>;
  /** Assert a header is present (case-insensitive name) and, when `value` is
   *  given, that it equals `value`. */
  hasHeader(name: string, value?: string): ResponseAssert<T>;
}

/** Assert over an already-resolved {@link ApiResponse} (synchronous). */
export function assertThatResponse<T>(res: ApiResponse<T>): ResponseAssert<T> {
  const self: ResponseAssert<T> = {
    hasStatus: (code) => {
      if (res.status !== code) {
        failAssertion({
          message: `assertThatResponse().hasStatus: expected status ${code} but got ${res.status}\n  body: ${formatValue(res.body)}`,
          actual: res.status,
          expected: code,
          operator: "assertThatResponse.hasStatus",
        });
      }
      return self;
    },
    hasJson: (subset) => {
      if (!deepSubset(res.body, subset)) {
        failAssertion({
          message: "assertThatResponse().hasJson: the response body does not match the expected subset",
          actual: res.body,
          expected: subset,
          operator: "assertThatResponse.hasJson",
        });
      }
      return self;
    },
    hasHeader: (name, value) => {
      // `Headers.get` is case-insensitive and returns `null` when the header is absent.
      const actual = res.headers.get(name);
      if (actual === null) {
        failAssertion({
          message: `assertThatResponse().hasHeader: expected header ${JSON.stringify(name)} to be present\n  headers: ${formatValue(headerEntries(res.headers))}`,
          diff: false,
          operator: "assertThatResponse.hasHeader",
        });
      }
      if (value !== undefined && actual !== value) {
        failAssertion({
          message: `assertThatResponse().hasHeader: header ${JSON.stringify(name)} does not equal the expected value`,
          actual,
          expected: value,
          operator: "assertThatResponse.hasHeader",
        });
      }
      return self;
    },
  };
  return self;
}

/** Render a `Headers` as a plain, sorted record so a failure message names the
 *  actual headers deterministically. */
function headerEntries(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  const entries = [...headers].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  for (const [key, value] of entries) out[key] = value;
  return out;
}
