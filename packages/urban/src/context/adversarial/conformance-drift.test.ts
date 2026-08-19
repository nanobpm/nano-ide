// Slice S7 (adversarial) — SCHEMA / vocabulary DRIFT guards + conformance.
//
// The shared conformance corpus (S2) is the contract BOTH producer and consumer
// are held to. Here we (a) hold the producer's own validator to the full corpus,
// and (b) attack the controlled vocabulary directly — drifted scope/mode/
// provenance/authority values, and structurally malformed records, must all be
// rejected with clear, structured errors.

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  assertConformance,
  corpus,
  fromResultValidator,
  invalidFixtures,
  runConformance,
  validFixtures,
} from "../conformance/index.ts";
import { isMemoryRecord, validateMemoryRecord } from "../schema/index.ts";

test("the producer validator passes the FULL conformance corpus", () => {
  // Result-form validator, adapted to the corpus's { ok } contract.
  assert.doesNotThrow(() => assertConformance(fromResultValidator(validateMemoryRecord)));

  const report = runConformance(fromResultValidator(validateMemoryRecord));
  assert.equal(report.failed, 0, "no corpus case may fail");
  assert.equal(report.total, corpus.length);
  assert.ok(report.total > 0);
});

test("the boolean type-guard validator also conforms", () => {
  const report = runConformance((input) => ({ ok: isMemoryRecord(input) }));
  assert.equal(report.failed, 0);
});

test("every valid fixture is accepted and every invalid fixture is rejected", () => {
  for (const c of validFixtures) {
    assert.equal(validateMemoryRecord(c.input).ok, true, `should accept: ${c.name}`);
  }
  for (const c of invalidFixtures) {
    assert.equal(validateMemoryRecord(c.input).ok, false, `should reject: ${c.name}`);
  }
});

test("drifted vocabulary is rejected with the right structured code", () => {
  const drifts: Array<{ field: string; value: string }> = [
    { field: "scope", value: "galaxy" },
    { field: "mode", value: "prescriptive" },
    { field: "provenance", value: "robot" },
    { field: "authority", value: "supreme" },
  ];
  for (const { field, value } of drifts) {
    const input: Record<string, unknown> = {
      schemaVersion: 1,
      id: "x",
      scope: "repo",
      mode: "empirical",
      provenance: "human",
      authority: "authoritative",
      statement: "s",
      createdAt: "2026-01-01T00:00:00Z",
    };
    input[field] = value;
    const result = validateMemoryRecord(input);
    assert.equal(result.ok, false, `drifted ${field}=${value} must be rejected`);
    if (!result.ok) {
      assert.equal(
        result.errors.some((e) => e.path === field && e.code === "invalid-vocabulary"),
        true,
        `expected invalid-vocabulary on ${field}`,
      );
    }
  }
});

test("hostile inputs never crash the validator (throwing getters, exotic shapes)", () => {
  const hostile = {
    get id() {
      throw new Error("boom");
    },
  };
  // Must return a structured rejection, not propagate the throw.
  assert.doesNotThrow(() => validateMemoryRecord(hostile));
  assert.equal(validateMemoryRecord(hostile).ok, false);

  for (const value of [42, null, undefined, "string", [], new Date()]) {
    assert.equal(validateMemoryRecord(value).ok, false);
  }
});
