import assert from "node:assert/strict";
import { test } from "node:test";
import { asArray, asRecord, optNumber, optString, reqString } from "./record.ts";
import { NormalizerDialectError } from "./types.ts";

test("asRecord reports an array distinctly from a plain object", () => {
  assert.throws(
    () => asRecord("h", [1, 2, 3]),
    (err: unknown) => err instanceof NormalizerDialectError && /got array$/.test(err.message),
  );
});

test("asRecord reports null distinctly", () => {
  assert.throws(
    () => asRecord("h", null),
    (err: unknown) => err instanceof NormalizerDialectError && /got null$/.test(err.message),
  );
});

test("asRecord reports a primitive by its typeof", () => {
  assert.throws(
    () => asRecord("h", 7),
    (err: unknown) => err instanceof NormalizerDialectError && /got number$/.test(err.message),
  );
});

test("asArray reports null distinctly from a plain object", () => {
  assert.throws(
    () => asArray("h", null, "message.content"),
    (err: unknown) =>
      err instanceof NormalizerDialectError && /message\.content must be an array, got null$/.test(err.message),
  );
});

test("asArray reports a primitive by its typeof", () => {
  assert.throws(
    () => asArray("h", "x", "message.content"),
    (err: unknown) => err instanceof NormalizerDialectError && /got string$/.test(err.message),
  );
});

test("reqString reports null distinctly from a plain object", () => {
  assert.throws(
    () => reqString("h", { f: null }, "f"),
    (err: unknown) => err instanceof NormalizerDialectError && /got null$/.test(err.message),
  );
});

test("reqString reports an array distinctly from a plain object", () => {
  assert.throws(
    () => reqString("h", { f: [1] }, "f"),
    (err: unknown) => err instanceof NormalizerDialectError && /got array$/.test(err.message),
  );
});

test("optString reports an array distinctly (present but wrong type)", () => {
  assert.throws(
    () => optString("h", { f: [1] }, "f"),
    (err: unknown) => err instanceof NormalizerDialectError && /got array$/.test(err.message),
  );
});

test("optNumber reports an array distinctly (present but wrong type)", () => {
  assert.throws(
    () => optNumber("h", { f: [1] }, "f"),
    (err: unknown) => err instanceof NormalizerDialectError && /got array$/.test(err.message),
  );
});
