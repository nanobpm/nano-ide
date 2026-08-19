import assert from "node:assert/strict";
import { test } from "node:test";
import { claudeNormalizer } from "./claude.ts";
import { copilotNormalizer } from "./copilot.ts";
import { deepseekNormalizer } from "./deepseek.ts";
import { kimiNormalizer } from "./kimi.ts";
import { piNormalizer } from "./pi.ts";
import { qwenNormalizer } from "./qwen.ts";

test("each harness resume shim maps a session id to its native restore invocation", () => {
  assert.deepEqual(copilotNormalizer.resume("s1"), { transport: "sdk", sessionId: "s1", call: "resumeSession", args: ["s1"] });
  assert.deepEqual(deepseekNormalizer.resume("s1"), { transport: "sdk", sessionId: "s1", call: "restore", args: ["s1"] });
  assert.deepEqual(claudeNormalizer.resume("s1"), { transport: "cli", sessionId: "s1", args: ["--resume", "s1"] });
  assert.deepEqual(qwenNormalizer.resume("s1"), { transport: "cli", sessionId: "s1", args: ["-r", "s1"] });
  assert.deepEqual(kimiNormalizer.resume("s1"), { transport: "cli", sessionId: "s1", args: ["-S", "s1"] });
  assert.deepEqual(piNormalizer.resume("s1"), { transport: "cli", sessionId: "s1", args: ["--session-id", "s1"] });
});

test("cli resume shims append the id as its own argv token (no shell-injection seam)", () => {
  const shim = claudeNormalizer.resume("id with spaces");
  assert.equal(shim.transport, "cli");
  if (shim.transport === "cli") {
    assert.deepEqual(shim.args, ["--resume", "id with spaces"]);
  }
});
