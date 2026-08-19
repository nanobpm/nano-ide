// Unit tests for the mandatory pre-commit PII guard (slice S6 core). Run via
// `npm run test --workspace @nanobpm/urban` (node --test, src/**/*.test.ts).
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  preCommitPiiGuard,
  createPiiGuard,
  PiiGuardError,
  type PiiGuard,
} from "./guard.ts";
import { MEMORY_RECORD_SCHEMA_VERSION, type MemoryRecord } from "../schema/index.ts";

function record(overrides: Partial<MemoryRecord> = {}): MemoryRecord {
  const full: MemoryRecord = {
    schemaVersion: MEMORY_RECORD_SCHEMA_VERSION,
    id: "rec-1",
    scope: "repo",
    mode: "empirical",
    provenance: "human",
    authority: "authoritative",
    statement: "the release passed all gates",
    createdAt: "2026-08-19T14:00:00.000Z",
  };
  return { ...full, ...overrides };
}

test("default guard passes clean content through (returns void)", () => {
  assert.equal(preCommitPiiGuard.assert(record()), undefined);
  assert.equal(preCommitPiiGuard.inspect(record()).clean, true);
});

test("default guard is default-DENY: rejects a PII-carrying record", () => {
  assert.throws(
    () => preCommitPiiGuard.assert(record({ statement: "owner alice@example.com approved" })),
    PiiGuardError,
  );
});

test("PiiGuardError carries the located findings", () => {
  try {
    preCommitPiiGuard.assert(record({ subject: "ssn 123-45-6789" }));
    assert.fail("expected PiiGuardError");
  } catch (err) {
    assert.ok(err instanceof PiiGuardError);
    assert.ok(err.findings.length >= 1);
    assert.equal(err.findings[0].kind, "ssn");
    assert.equal(err.findings[0].path, "subject");
  }
});

test("guard rejects obfuscated PII too (evasion attempt)", () => {
  assert.throws(
    () => preCommitPiiGuard.assert("contact me: bob (at) corp dot com"),
    PiiGuardError,
  );
});

test("inspect is non-throwing and returns findings", () => {
  const result = preCommitPiiGuard.inspect("card 4242 4242 4242 4242");
  assert.equal(result.clean, false);
  if (!result.clean) assert.equal(result.findings[0].kind, "credit-card");
});

test("createPiiGuard() with no options matches the default guard policy", () => {
  const guard = createPiiGuard();
  assert.equal(guard.name, "pre-commit-pii-guard");
  assert.throws(() => guard.assert("email x@y.com"), PiiGuardError);
  assert.doesNotThrow(() => guard.assert("nothing sensitive"));
});

test("guard name is overridable but policy stays default-DENY", () => {
  const guard: PiiGuard = createPiiGuard({ name: "write-path-guard" });
  assert.equal(guard.name, "write-path-guard");
  assert.throws(() => guard.assert("ssn 123-45-6789"), PiiGuardError);
});

test("custom classifier override is still enforced as default-DENY", () => {
  // A stricter policy that flags a banned word — proving the guard enforces
  // whatever classifier it is given, and always denies on a non-clean result.
  const guard = createPiiGuard({
    classify: (c) =>
      typeof c === "string" && c.includes("secret")
        ? { clean: false, findings: [{ kind: "email", path: "", index: 0, excerpt: "***", reason: "banned" }] }
        : { clean: true, findings: [] },
  });
  assert.throws(() => guard.assert("this is secret"), PiiGuardError);
  assert.doesNotThrow(() => guard.assert("this is fine"));
});
