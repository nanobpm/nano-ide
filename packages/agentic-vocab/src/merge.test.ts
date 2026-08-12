import assert from "node:assert/strict";
import { test } from "node:test";
import { CORE_VOCAB } from "./core-vocab.ts";
import { mergeVocab } from "./merge.ts";
import { VocabDocumentError, VocabResolver } from "./resolver.ts";

test("an author extension adds a new network without disturbing the core", () => {
  const merged = mergeVocab({
    version: 1,
    networks: { research: { roles: { scout: { requires: ["cognition=research"], seats: 2 } } } },
  });
  const resolver = new VocabResolver(merged);
  assert.ok(resolver.tokens().includes("research.scout"));
  // Core roles survive intact.
  assert.ok(resolver.tokens().includes("planning.planner"));
  assert.ok(resolver.tokens().includes("decide"));
});

test("an extension retunes a single role field, leaving the rest", () => {
  const merged = mergeVocab({
    version: 1,
    networks: { implementation: { roles: { junior: { weight: 9 } } } },
  });
  const resolver = new VocabResolver(merged);
  const junior = resolver.roleForToken("implementation.junior");
  assert.equal(junior?.weight, 9, "extension weight wins");
  // The core requires/seats on junior are preserved (not clobbered).
  assert.deepEqual(junior?.seats, 3);
  const light = resolver.resolve({ cognition: "implementation", weight: 2 });
  assert.ok(light.tokens.includes("implementation.junior"), "core requires gate preserved");
});

test("an extension can add a seatsDistinctFamily opt-in to an existing role", () => {
  const merged = mergeVocab({
    version: 1,
    networks: { qa: { roles: { tester: { seats: ["red", "blue"], seatsDistinctFamily: true } } } },
  });
  const tester = new VocabResolver(merged).roleForToken("qa.tester");
  assert.equal(tester?.seatsDistinctFamily, true);
  assert.deepEqual(tester?.seats, ["red", "blue"]);
});

test("version becomes the max of base and extension", () => {
  assert.equal(mergeVocab({ version: 7, networks: {} }).version, Math.max(CORE_VOCAB.version, 7));
  assert.equal(mergeVocab({ version: 1, networks: {} }).version, CORE_VOCAB.version);
});

test("merge does not mutate either input", () => {
  const before = JSON.stringify(CORE_VOCAB);
  const ext = { version: 1, networks: { x: { roles: { y: {} } } } };
  const extBefore = JSON.stringify(ext);
  mergeVocab(ext);
  assert.equal(JSON.stringify(CORE_VOCAB), before, "core vocab untouched");
  assert.equal(JSON.stringify(ext), extBefore, "extension untouched");
});

test("merge over an explicit base merges recursively into subnetworks", () => {
  const base = JSON.parse(
    '{"version":1,"networks":{"net":{"subnetworks":{"sub":{"roles":{"a":{"weight":1}}}}}}}',
  );
  const merged = mergeVocab(
    { version: 1, networks: { net: { subnetworks: { sub: { roles: { b: { weight: 2 } } } } } } },
    base,
  );
  const tokens = new VocabResolver(merged).tokens();
  assert.ok(tokens.includes("net.sub.a"));
  assert.ok(tokens.includes("net.sub.b"));
});

test("merge rejects an invalid extension", () => {
  const bad = JSON.parse('{"version":1,"networks":{"Bad Name":{}}}');
  assert.throws(() => mergeVocab(bad), VocabDocumentError);
});
