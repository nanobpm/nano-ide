import { test } from "node:test";
import assert from "node:assert/strict";
import { validateVocabDocument } from "./schema.ts";
import { VALID_VOCABS, INVALID_VOCABS } from "../conformance/vocab.ts";

test("valid vocab documents pass validation and narrow to the document", () => {
  for (const vector of VALID_VOCABS) {
    const result = validateVocabDocument(vector.document);
    assert.ok(result.ok, `${vector.name}: expected ok, got ${result.ok ? "" : JSON.stringify(result.errors)}`);
    if (result.ok) {
      assert.deepEqual(result.value, vector.document, vector.name);
    }
  }
});

test("invalid vocab documents fail with the expected error code", () => {
  for (const vector of INVALID_VOCABS) {
    const result = validateVocabDocument(vector.document);
    assert.ok(!result.ok, `${vector.name}: expected failure`);
    if (!result.ok) {
      const codes = result.errors.map((e) => e.code);
      assert.ok(
        codes.includes(vector.expectedCode),
        `${vector.name}: expected code ${vector.expectedCode} among ${JSON.stringify(codes)}`,
      );
    }
  }
});

test("subnetwork roles are validated recursively", () => {
  const result = validateVocabDocument({
    version: 1,
    networks: {
      implementation: {
        subnetworks: { ci: { roles: { fix: { weight: "bad" } } } },
      },
    },
  });
  assert.ok(!result.ok);
  if (!result.ok) {
    assert.ok(result.errors.some((e) => e.code === "bad-weight"));
    assert.ok(result.errors.some((e) => e.path === "$.networks.implementation.subnetworks.ci.roles.fix.weight"));
  }
});

test("narrowed document does not share array references with the input", () => {
  const requires = ["relay"];
  const seats = ["a", "b"];
  const input = {
    version: 1,
    networks: { impl: { roles: { fix: { requires, seats } } } },
  };
  const result = validateVocabDocument(input);
  assert.ok(result.ok);
  if (result.ok) {
    const role = result.value.networks.impl?.roles?.fix;
    assert.ok(role);
    assert.notStrictEqual(role.requires, requires);
    assert.deepEqual(role.requires, requires);
    assert.notStrictEqual(role.seats, seats);
    assert.deepEqual(role.seats, seats);
    requires.push("mutated");
    seats.push("mutated");
    assert.deepEqual(role.requires, ["relay"]);
    assert.deepEqual(role.seats, ["a", "b"]);
  }
});
