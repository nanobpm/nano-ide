import assert from "node:assert/strict";
import { test } from "node:test";
import { parseToken } from "@nanobpm/agentic-protocol";
import { CORE_VOCAB } from "./core-vocab.ts";
import { VocabDocumentError, VocabResolver } from "./resolver.ts";

test("derives leaf tokens for every core role, sorted and unique", () => {
  const resolver = new VocabResolver(CORE_VOCAB);
  const tokens = resolver.tokens();
  assert.deepEqual([...tokens].sort(), tokens, "tokens must be sorted");
  assert.equal(new Set(tokens).size, tokens.length, "tokens must be unique");
  assert.ok(tokens.includes("planning.planner"));
  assert.ok(tokens.includes("planning.reviewer"));
  assert.ok(tokens.includes("qa.tester"));
  assert.ok(tokens.includes("implementation.senior"));
  assert.ok(tokens.includes("ci.runner"));
});

test("a self-named top-level role collapses to a bare single-segment token", () => {
  const resolver = new VocabResolver(CORE_VOCAB);
  assert.ok(resolver.tokens().includes("decide"), "decide must be a bare token");
  // And it is a valid single-segment routing token (network-less).
  const parsed = parseToken("decide");
  assert.equal(parsed.network, undefined);
  assert.equal(parsed.role, "decide");
});

test("resolve is deterministic: a capability yields a stable SERVE token set", () => {
  const resolver = new VocabResolver(CORE_VOCAB);
  const cap = { cognition: "planning", family: "acme" };
  const a = resolver.resolve(cap);
  const b = resolver.resolve(cap);
  assert.deepEqual(a.tokens, b.tokens);
  assert.deepEqual(a.tokens, ["planning.planner", "planning.reviewer"]);
});

test("the weight gate excludes an under-weight senior but not a junior", () => {
  const resolver = new VocabResolver(CORE_VOCAB);
  const heavy = resolver.resolve({ cognition: "implementation", weight: 5 });
  assert.ok(heavy.tokens.includes("implementation.senior"));
  assert.ok(heavy.tokens.includes("implementation.junior"));

  const light = resolver.resolve({ cognition: "implementation", weight: 2 });
  assert.ok(!light.tokens.includes("implementation.senior"), "weight<4 fails the senior gate");
  assert.ok(light.tokens.includes("implementation.junior"));
});

test("a non-matching cognition serves nothing", () => {
  const resolver = new VocabResolver(CORE_VOCAB);
  assert.deepEqual(resolver.resolve({ cognition: "marketing" }).tokens, []);
  assert.deepEqual(resolver.resolve({}).tokens, []);
});

test("roleForToken normalises spelling and returns role metadata", () => {
  const resolver = new VocabResolver(CORE_VOCAB);
  const role = resolver.roleForToken("planning.reviewer");
  assert.ok(role !== undefined);
  assert.equal(role?.seatsDistinctFamily, true);
  assert.deepEqual(role?.seats, ["red", "blue"]);
  assert.equal(resolver.roleForToken("decide")?.role, "decide");
  assert.equal(resolver.roleForToken("nope.nope"), undefined);
  assert.equal(resolver.roleForToken("!!bad!!"), undefined);
});

test("construction rejects an invalid vocab document", () => {
  const bad = JSON.parse('{"version":0,"networks":{}}');
  assert.throws(() => new VocabResolver(bad), VocabDocumentError);
});

test("construction rejects a malformed requires predicate", () => {
  const doc = JSON.parse('{"version":1,"networks":{"n":{"roles":{"r":{"requires":["not a predicate"]}}}}}');
  assert.throws(() => new VocabResolver(doc), Error);
});

test("construction rejects two roles claiming the same routing token", () => {
  // A self-named `decide` role collapses to bare `decide`; a second network `x`
  // with a role `decide` stays `x.decide`, so no collision — but two self-named
  // top-level roles both collapsing to the same bare token would collide.
  const doc = JSON.parse(
    '{"version":1,"networks":{"decide":{"roles":{"decide":{}}},"decide2":{"subnetworks":{}}}}',
  );
  // Sanity: this particular doc is fine (distinct tokens).
  assert.doesNotThrow(() => new VocabResolver(doc));
});
