import assert from "node:assert/strict";
import { test } from "node:test";
import {
  parseRequires,
  parseRequiresList,
  RequiresParseError,
  satisfiesPredicate,
  satisfiesRequires,
} from "./requires.ts";

test("parses equality, inequality and ordering predicates", () => {
  assert.deepEqual(parseRequires("cognition=planning"), {
    field: "cognition",
    op: "=",
    value: "planning",
    source: "cognition=planning",
  });
  assert.deepEqual(parseRequires("weight>=4"), { field: "weight", op: ">=", value: 4, source: "weight>=4" });
  assert.equal(parseRequires("family != acme").op, "!=");
  assert.equal(parseRequires("family != acme").value, "acme");
});

test("tolerates surrounding whitespace", () => {
  const p = parseRequires("  cognition  ==  qa  ");
  assert.equal(p.field, "cognition");
  assert.equal(p.op, "==");
  assert.equal(p.value, "qa");
});

test("rejects malformed predicates", () => {
  assert.throws(() => parseRequires("nonsense"), RequiresParseError);
  assert.throws(() => parseRequires("host"), RequiresParseError);
  assert.throws(() => parseRequires("colour=red"), RequiresParseError);
});

test("ordering operators are weight-only; string ordering rejected", () => {
  assert.throws(() => parseRequires("cognition>=planning"), RequiresParseError);
  assert.throws(() => parseRequires("weight>=notanumber"), RequiresParseError);
});

test("satisfiesPredicate is fail-closed on absent fields (except !=)", () => {
  assert.equal(satisfiesPredicate(parseRequires("cognition=planning"), {}), false);
  assert.equal(satisfiesPredicate(parseRequires("weight>=3"), {}), false);
  // Absent field provably is not the forbidden value.
  assert.equal(satisfiesPredicate(parseRequires("family!=acme"), {}), true);
});

test("numeric comparisons evaluate against weight", () => {
  assert.equal(satisfiesPredicate(parseRequires("weight>=4"), { weight: 5 }), true);
  assert.equal(satisfiesPredicate(parseRequires("weight>=4"), { weight: 4 }), true);
  assert.equal(satisfiesPredicate(parseRequires("weight>=4"), { weight: 3 }), false);
  assert.equal(satisfiesPredicate(parseRequires("weight<2"), { weight: 1 }), true);
});

test("string comparisons evaluate against the field", () => {
  assert.equal(satisfiesPredicate(parseRequires("cognition=qa"), { cognition: "qa" }), true);
  assert.equal(satisfiesPredicate(parseRequires("cognition=qa"), { cognition: "planning" }), false);
  assert.equal(satisfiesPredicate(parseRequires("family!=acme"), { family: "acme" }), false);
  assert.equal(satisfiesPredicate(parseRequires("family!=acme"), { family: "globex" }), true);
});

test("satisfiesRequires requires EVERY predicate; empty list is open", () => {
  const preds = parseRequiresList(["cognition=implementation", "weight>=4"]);
  assert.equal(satisfiesRequires(preds, { cognition: "implementation", weight: 5 }), true);
  assert.equal(satisfiesRequires(preds, { cognition: "implementation", weight: 2 }), false);
  assert.equal(satisfiesRequires(preds, { cognition: "qa", weight: 9 }), false);
  assert.equal(satisfiesRequires(parseRequiresList(undefined), {}), true);
  assert.equal(satisfiesRequires(parseRequiresList([]), { cognition: "anything" }), true);
});
