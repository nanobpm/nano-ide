// Conformance guard (issue #341): the WASM test double must implement the *entire*
// `EngineClient` surface, not merely the methods some behavioural test happens to
// exercise. urban grew `getForm`, then `openUserTasks`, on `EngineClient` after this kit
// was first published; a `WasmEngineClient` compiled/published against the older urban
// silently lacked them, so any consumer whose reconciler/poller reached for the new
// accessor hit `TypeError: engine.<method> is not a function` under the fake and had to
// hand-polyfill it in its harness (nanobpm/nano-workforce#309 / #312). A purely
// structural `implements EngineClient` check cannot catch that: it only binds the fake to
// whatever urban version *it* compiled against.
//
// `ENGINE_CLIENT_METHODS` is urban's single runtime source of truth for the interface's
// surface, compile-time-pinned to `keyof EngineClient`. Iterating it here turns the next
// such seam-lag into a red test in *this* repo's CI — the categorical fix for the whole
// "fake lags the SDK" class, not just the one method that bit us this time.

import { test } from "node:test";
import assert from "node:assert/strict";
import { ENGINE_CLIENT_METHODS } from "@nanobpm/urban/runtime";
import { createWasmEngineClient } from "./wasm-engine.ts";

test("WasmEngineClient implements the full EngineClient method surface", async () => {
  const engine = await createWasmEngineClient();
  try {
    const missing = ENGINE_CLIENT_METHODS.filter((method) => typeof engine[method] !== "function");
    assert.deepEqual(
      missing,
      [],
      `WasmEngineClient is missing EngineClient method(s) [${missing.join(", ")}] — the SDK grew ` +
        "a method the test double lags behind (issue #341). Implement it on WasmEngineClient, " +
        "deriving from an existing method where possible so the two cannot drift.",
    );
  } finally {
    // Guard cleanup: `close` may itself be one of the missing methods this test
    // exists to detect. Calling it unconditionally would throw
    // `TypeError: engine.close is not a function` and mask the actionable
    // assertion above that lists exactly which methods are missing.
    if (typeof engine.close === "function") {
      await engine.close();
    }
  }
});
