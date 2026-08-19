import assert from "node:assert/strict";
import { test } from "node:test";
import { composePreprocessors, lowercase, stripPunctuation, trim } from "./preprocessors.ts";
import { parseVerdict, serializeVerdict } from "./verdict.ts";

test("preprocessors: lowercase, trim (collapses runs), and stripPunctuation", () => {
  assert.equal(lowercase("HeLLo"), "hello");
  assert.equal(trim("  a   b  "), "a b");
  assert.equal(stripPunctuation("hello, world!"), "hello world");
});

test("preprocessors: compose applies transforms left-to-right", () => {
  const normalize = composePreprocessors([lowercase, stripPunctuation, trim]);
  assert.equal(normalize("  Hello,   WORLD!!  "), "hello world");
});

test("preprocessors: composing an empty list is the identity", () => {
  const identity = composePreprocessors([]);
  assert.equal(identity("Untouched, 1!"), "Untouched, 1!");
});

test("verdict: serialize/parse round-trips", () => {
  const text = serializeVerdict({ pass: false, rationale: "nope" });
  assert.deepEqual(parseVerdict(text), { pass: false, rationale: "nope" });
});

test("verdict: parsing malformed or mismatched text throws loudly", () => {
  assert.throws(() => parseVerdict("not json"), /not valid JSON/);
  assert.throws(() => parseVerdict('{"pass":"yes","rationale":"x"}'), /pass, rationale/);
  assert.throws(() => parseVerdict('{"rationale":"x"}'), /pass, rationale/);
});
