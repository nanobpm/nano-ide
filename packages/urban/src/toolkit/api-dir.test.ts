import assert from "node:assert/strict";
import { test } from "node:test";

import { DEFAULT_OPERATIONS_DIR, normalizeApiDir } from "./api-dir.ts";

test("normalizeApiDir: empty/whitespace falls back to the default", () => {
  assert.equal(normalizeApiDir(""), DEFAULT_OPERATIONS_DIR);
  assert.equal(normalizeApiDir("   "), DEFAULT_OPERATIONS_DIR);
});

test("normalizeApiDir: strips leading ./ and surrounding slashes, folds backslashes", () => {
  assert.equal(normalizeApiDir("ops"), "ops");
  assert.equal(normalizeApiDir("./ops/"), "ops");
  assert.equal(normalizeApiDir("api\\ops"), "api/ops");
  assert.equal(normalizeApiDir("nested/ops/"), "nested/ops");
});

test("normalizeApiDir: rejects absolute POSIX paths", () => {
  assert.throws(() => normalizeApiDir("/ops"), /app-relative/);
});

test("normalizeApiDir: rejects absolute Windows paths", () => {
  assert.throws(() => normalizeApiDir("C:\\ops"), /app-relative/);
  assert.throws(() => normalizeApiDir("C:/ops"), /app-relative/);
  assert.throws(() => normalizeApiDir("\\ops"), /app-relative/);
});

test("normalizeApiDir: rejects .. traversal segments", () => {
  assert.throws(() => normalizeApiDir("../ops"), /\.\./);
  assert.throws(() => normalizeApiDir("ops/../escape"), /\.\./);
  assert.throws(() => normalizeApiDir("a/../../b"), /\.\./);
});
