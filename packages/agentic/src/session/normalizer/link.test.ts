import assert from "node:assert/strict";
import { test } from "node:test";
import { normalizeSession } from "./link.ts";
import { qwenNormalizer } from "./qwen.ts";

test("the default newId is unique across repeated normalizeSession calls for one session", () => {
  const records = [
    { type: "content", role: "user", text: "one" },
    { type: "content", role: "model", text: "two" },
  ];
  const first = normalizeSession(qwenNormalizer, records);
  const second = normalizeSession(qwenNormalizer, records);
  const ids = new Set([...first, ...second].map((e) => e.id));
  assert.equal(ids.size, first.length + second.length, "ids do not collide across calls");
});

test("an injected newId still overrides the default for deterministic tests", () => {
  const events = normalizeSession(
    qwenNormalizer,
    [{ type: "content", role: "user", text: "hi" }],
    { newId: (() => { let n = 0; return () => `d-${n++}`; })() },
  );
  assert.equal(events[0].id, "d-0");
});
