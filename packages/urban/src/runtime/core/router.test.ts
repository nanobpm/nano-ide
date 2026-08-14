import { test } from "node:test";
import assert from "node:assert/strict";
import { noContent, normalizeRoutePath } from "./router.ts";

test("normalizeRoutePath ensures a leading slash and trims trailing slashes", () => {
  assert.equal(normalizeRoutePath("hooks/x", "/fallback"), "/hooks/x");
  assert.equal(normalizeRoutePath("/hooks/x", "/fallback"), "/hooks/x");
  assert.equal(normalizeRoutePath("/tasks/", "/tasks"), "/tasks");
  assert.equal(normalizeRoutePath("  /chat  ", "/chat"), "/chat");
});

test("normalizeRoutePath collapses leading slashes so a //host value stays in-app", () => {
  assert.equal(normalizeRoutePath("//evil.com", "/app/api"), "/evil.com");
  assert.equal(normalizeRoutePath("///app/api", "/app/api"), "/app/api");
  assert.equal(normalizeRoutePath("  //app/api-docs  ", "/app/api"), "/app/api-docs");
});

test("normalizeRoutePath falls back when value is missing or collapses to root", () => {
  assert.equal(normalizeRoutePath(undefined, "/tasks"), "/tasks");
  assert.equal(normalizeRoutePath("/", "/tasks"), "/tasks");
  assert.equal(normalizeRoutePath("", "/tasks"), "/tasks");
});

test("noContent emits a 204 with an empty body and no content-type", () => {
  const res = noContent();
  assert.equal(res.status, 204);
  // 204 must carry no body: a "null" (or any) payload violates the semantics and
  // makes a body-parsing client throw. Guard against a json(null, 204) regression.
  assert.equal(res.body, "");
  assert.equal(res.headers?.["content-type"], undefined);
});
