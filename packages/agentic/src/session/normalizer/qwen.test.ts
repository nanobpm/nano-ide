import assert from "node:assert/strict";
import { test } from "node:test";
import { normalizeSession } from "./link.ts";
import { qwenNormalizer } from "./qwen.ts";

test("qwen maps a system-role content frame to a system event", () => {
  const events = normalizeSession(qwenNormalizer, [{ type: "content", role: "system", text: "you are nano" }]);
  assert.equal(events.length, 1);
  assert.equal(events[0].type, "system");
});

test("qwen keeps the assistant fallback for an unknown role", () => {
  const events = normalizeSession(qwenNormalizer, [{ type: "content", role: "model", text: "here is the plan" }]);
  assert.equal(events[0].type, "assistant");
});

test("qwen maps a user-role content frame to a user event", () => {
  const events = normalizeSession(qwenNormalizer, [{ type: "content", role: "user", text: "please refactor" }]);
  assert.equal(events[0].type, "user");
});
