// Unit tests for the memory-record schema (slice S2). Run via
// `npm run test --workspace @nanobpm/urban` (node --test, src/**/*.test.ts).
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  validateMemoryRecord,
  isMemoryRecord,
  assertMemoryRecord,
  MemoryRecordValidationError,
  checkInvariants,
  isAuthoritative,
  SCOPE_LADDER,
  MEMORY_MODES,
  PROVENANCES,
  AUTHORITIES,
  MEMORY_RECORD_SCHEMA_VERSION,
  type MemoryRecord,
} from "./index.ts";

function base(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: MEMORY_RECORD_SCHEMA_VERSION,
    id: "rec-1",
    scope: "repo",
    mode: "empirical",
    provenance: "human",
    authority: "authoritative",
    statement: "the tests pass",
    createdAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

test("accepts a well-formed record and narrows it", () => {
  const result = validateMemoryRecord(base());
  assert.equal(result.ok, true);
  if (result.ok) {
    const rec: MemoryRecord = result.record;
    assert.equal(rec.id, "rec-1");
    assert.equal(rec.schemaVersion, MEMORY_RECORD_SCHEMA_VERSION);
    assert.equal(isAuthoritative(rec), true);
  }
});

test("accepts optional fields when well-typed and drops absent ones", () => {
  const result = validateMemoryRecord(base({ provenance: "measured", scopeRef: "elem-1", subject: "latency", evidence: ["run-1"], supersedes: "rec-0" }));
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.record.scopeRef, "elem-1");
    assert.deepEqual(result.record.evidence, ["run-1"]);
    assert.equal("subject" in result.record, true);
  }
  const bare = validateMemoryRecord(base());
  if (bare.ok) {
    assert.equal("scopeRef" in bare.record, false);
    assert.equal("evidence" in bare.record, false);
  }
});

test("rejects a non-object with a clear error", () => {
  const result = validateMemoryRecord(42);
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.errors[0]?.code, "not-an-object");
  }
});

test("reports every problem, not just the first", () => {
  const result = validateMemoryRecord({ schemaVersion: 9, scope: "galaxy", mode: "x" });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.ok(result.errors.length >= 3);
    const codes = new Set(result.errors.map((e) => e.code));
    assert.ok(codes.has("unsupported-schema-version"));
    assert.ok(codes.has("invalid-vocabulary"));
    assert.ok(codes.has("missing-field"));
  }
});

test("rejects drifted vocabulary on each controlled field", () => {
  assert.equal(validateMemoryRecord(base({ scope: "galaxy" })).ok, false);
  assert.equal(validateMemoryRecord(base({ mode: "prescriptive" })).ok, false);
  assert.equal(validateMemoryRecord(base({ provenance: "robot" })).ok, false);
  assert.equal(validateMemoryRecord(base({ authority: "supreme" })).ok, false);
});

test("distinguishes wrong-type from drifted vocabulary on controlled fields", () => {
  for (const field of ["scope", "mode", "provenance", "authority"]) {
    const wrongType = validateMemoryRecord(base({ [field]: 42 }));
    assert.equal(wrongType.ok, false);
    if (!wrongType.ok) {
      const err = wrongType.errors.find((e) => e.path === field);
      assert.equal(err?.code, "wrong-type", `${field}: a non-string must report wrong-type, not invalid-vocabulary`);
    }
    const drifted = validateMemoryRecord(base({ [field]: "not-in-ladder" }));
    assert.equal(drifted.ok, false);
    if (!drifted.ok) {
      const err = drifted.errors.find((e) => e.path === field);
      assert.equal(err?.code, "invalid-vocabulary", `${field}: a drifted string must report invalid-vocabulary`);
    }
  }
});

test("rejects non-ISO timestamps but accepts offset zones", () => {
  assert.equal(validateMemoryRecord(base({ createdAt: "yesterday" })).ok, false);
  assert.equal(validateMemoryRecord(base({ createdAt: "2026-01-01" })).ok, false);
  assert.equal(validateMemoryRecord(base({ createdAt: "2026-01-01T12:00:00+13:00" })).ok, true);
});

// --- The hypothesis-never-fix invariant, at every scope -------------------

test("INVARIANT: agent-retro can never be authoritative, at any scope", () => {
  for (const scope of SCOPE_LADDER) {
    for (const mode of MEMORY_MODES) {
      const result = validateMemoryRecord(base({ scope, mode, provenance: "agent-retro", authority: "authoritative" }));
      assert.equal(result.ok, false, `agent-retro/authoritative must be rejected at ${scope}/${mode}`);
      if (!result.ok) {
        assert.ok(result.errors.some((e) => e.code === "invariant-violation"));
      }
    }
  }
});

test("agent-retro as a hypothesis is accepted at every scope and mode", () => {
  for (const scope of SCOPE_LADDER) {
    for (const mode of MEMORY_MODES) {
      assert.equal(validateMemoryRecord(base({ scope, mode, provenance: "agent-retro", authority: "hypothesis" })).ok, true);
    }
  }
});

test("measured/instance must be empirical + authoritative", () => {
  assert.equal(validateMemoryRecord(base({ provenance: "measured", authority: "hypothesis" })).ok, false);
  assert.equal(validateMemoryRecord(base({ provenance: "measured", mode: "normative", authority: "authoritative" })).ok, false);
  assert.equal(validateMemoryRecord(base({ provenance: "instance", authority: "hypothesis" })).ok, false);
  assert.equal(validateMemoryRecord(base({ provenance: "instance", mode: "normative", authority: "authoritative" })).ok, false);
  assert.equal(validateMemoryRecord(base({ provenance: "measured", mode: "empirical", authority: "authoritative" })).ok, true);
  assert.equal(validateMemoryRecord(base({ provenance: "instance", mode: "empirical", authority: "authoritative" })).ok, true);
});

test("only human/agent-retro may author a normative record", () => {
  assert.equal(validateMemoryRecord(base({ mode: "normative", provenance: "human", authority: "hypothesis" })).ok, true);
  assert.equal(validateMemoryRecord(base({ mode: "normative", provenance: "agent-retro", authority: "hypothesis" })).ok, true);
  assert.equal(validateMemoryRecord(base({ mode: "normative", provenance: "measured", authority: "authoritative" })).ok, false);
});

test("checkInvariants: the only route to authoritative excludes agent-retro", () => {
  for (const provenance of PROVENANCES) {
    for (const mode of MEMORY_MODES) {
      const errs = checkInvariants({ provenance, mode, authority: "authoritative" });
      if (provenance === "agent-retro") {
        assert.ok(errs.length > 0, "agent-retro must never validate as authoritative");
      }
    }
  }
});

test("assertMemoryRecord throws MemoryRecordValidationError carrying structured errors", () => {
  assert.throws(
    () => assertMemoryRecord(base({ provenance: "agent-retro", authority: "authoritative" })),
    (err: unknown) => {
      assert.ok(err instanceof MemoryRecordValidationError);
      assert.ok(err.errors.length > 0);
      return true;
    },
  );
  const ok = assertMemoryRecord(base());
  assert.equal(ok.id, "rec-1");
});

test("isMemoryRecord is a usable type guard", () => {
  const v: unknown = base();
  assert.equal(isMemoryRecord(v), true);
  assert.equal(isMemoryRecord(42), false);
});

test("vocabulary arrays are the expected controlled sets", () => {
  assert.deepEqual([...SCOPE_LADDER], ["element", "instance", "epic", "repo", "corpus"]);
  assert.deepEqual([...MEMORY_MODES], ["normative", "empirical"]);
  assert.deepEqual([...PROVENANCES], ["human", "agent-retro", "measured", "instance"]);
  assert.deepEqual([...AUTHORITIES], ["hypothesis", "authoritative"]);
});
