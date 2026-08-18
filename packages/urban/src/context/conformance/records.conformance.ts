// Runnable conformance suite — matched by the pre-declared `test:conformance`
// glob (src/context/conformance/**/*.conformance.ts). It holds THIS repo's
// producer validator (`validateMemoryRecord`) to the shared corpus. The consumer
// (nano-workforce#291) imports the same `corpus` + `runConformance`/
// `assertConformance` and runs it against its own validator, so both sides prove
// they agree on the exact same fixtures.
import { test } from "node:test";
import assert from "node:assert/strict";

import { validateMemoryRecord } from "../schema/index.ts";
import {
  corpus,
  runConformance,
  assertConformance,
  fromResultValidator,
  validFixtures,
  invalidFixtures,
  type ConformanceValidator,
  type ConformanceReport,
} from "./index.ts";

const validator = fromResultValidator(validateMemoryRecord);

test("corpus is non-trivial and partitioned", () => {
  assert.ok(corpus.length >= 50, `expected a substantial corpus, got ${corpus.length}`);
  assert.ok(validFixtures.length > 0);
  assert.ok(invalidFixtures.length > 0);
  assert.equal(validFixtures.length + invalidFixtures.length, corpus.length);
  // Case names must be unique so failures are unambiguous.
  assert.equal(new Set(corpus.map((c) => c.name)).size, corpus.length);
});

test("producer validator satisfies the full conformance corpus", () => {
  const report = runConformance(validator);
  assert.equal(report.failed, 0, `failures:\n${report.failures.map((f) => `${f.case.name}: expected ${f.expected}, got ${f.actual}`).join("\n")}`);
  assert.equal(report.passed, report.total);
});

test("assertConformance does not throw for the producer validator", () => {
  assert.doesNotThrow(() => assertConformance(validator));
});

test("runConformance treats a throwing validator as a rejection instead of crashing", () => {
  const throwing: ConformanceValidator = () => {
    throw new Error("boom");
  };
  // The runner must stay pure: no throw escapes, and every case is scored `reject`.
  let report: ConformanceReport | undefined;
  assert.doesNotThrow(() => {
    report = runConformance(throwing);
  });
  assert.ok(report);
  if (report) {
    assert.equal(report.total, corpus.length);
    // Every case scores `reject`; only the corpus's reject-cases can pass.
    const rejectCount = corpus.filter((c) => c.expect === "reject").length;
    assert.equal(report.passed, rejectCount);
    assert.equal(report.results.every((r) => r.actual === "reject"), true);
  }
});

// Per-case granularity: one sub-test per fixture so a regression names the exact case.
for (const c of corpus) {
  test(`case: ${c.name}`, () => {
    const actual = validator(c.input).ok ? "accept" : "reject";
    assert.equal(actual, c.expect, `${c.name} — ${c.note}`);
  });
}
