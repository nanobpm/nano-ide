// Slice S4 (retrieval) — unit tests for the pure query model.

import assert from "node:assert/strict";
import { test } from "node:test";
import type { MemoryRecord } from "../schema/index.ts";
import { compileQuery, matchesQuery, type RetrievalQuery } from "./query.ts";

function rec(overrides: Partial<MemoryRecord>): MemoryRecord {
  const base: MemoryRecord = {
    schemaVersion: 1,
    id: "rec-1",
    scope: "epic",
    scopeRef: "issue-303",
    mode: "empirical",
    provenance: "measured",
    authority: "authoritative",
    statement: "the measured throughput was 42 rps",
    createdAt: "2026-01-01T00:00:00Z",
  };
  return { ...base, ...overrides };
}

function matches(record: MemoryRecord, query: RetrievalQuery): boolean {
  return matchesQuery(record, compileQuery(query));
}

test("an empty query matches every record", () => {
  assert.equal(matches(rec({}), {}), true);
});

test("frontmatter clauses are ANDed", () => {
  const record = rec({ provenance: "measured", mode: "empirical" });
  assert.equal(matches(record, { provenance: "measured", mode: "empirical" }), true);
  assert.equal(matches(record, { provenance: "measured", mode: "normative" }), false);
});

test("a clause given as an array is an OR-set", () => {
  const record = rec({ scope: "repo" });
  assert.equal(matches(record, { scope: ["epic", "repo"] }), true);
  assert.equal(matches(record, { scope: ["epic", "corpus"] }), false);
  assert.equal(matches(record, { scope: "repo" }), true);
});

test("scopeRef filter distinguishes namespaces", () => {
  assert.equal(matches(rec({ scopeRef: "issue-303" }), { scopeRef: "issue-303" }), true);
  assert.equal(matches(rec({ scopeRef: "issue-999" }), { scopeRef: "issue-303" }), false);
});

test("a scopeRef filter never matches a record without a scopeRef", () => {
  const unscoped = rec({ scope: "corpus", scopeRef: undefined });
  assert.equal(matches(unscoped, { scopeRef: "issue-303" }), false);
  assert.equal(matches(unscoped, {}), true);
});

test("text search is a case-insensitive substring over the body", () => {
  const record = rec({ statement: "The Measured Throughput was 42 RPS", subject: "latency" });
  assert.equal(matches(record, { text: "throughput" }), true);
  assert.equal(matches(record, { text: "THROUGHPUT" }), true);
  assert.equal(matches(record, { text: "latency" }), true); // subject
  assert.equal(matches(record, { text: "rec-1" }), true); // id
  assert.equal(matches(record, { text: "absent" }), false);
});

test("an empty text needle matches everything", () => {
  assert.equal(matches(rec({}), { text: "" }), true);
});

test("text search composes with structured filters (AND)", () => {
  const record = rec({ provenance: "human", mode: "normative", statement: "prefer explicit errors" });
  assert.equal(matches(record, { provenance: "human", text: "explicit" }), true);
  assert.equal(matches(record, { provenance: "measured", text: "explicit" }), false);
});
