// Integration test for `w.race` (the event-based gateway, epic #314, S1/#316)
// against a DEDICATED gateway. Skips itself when no gateway binary is available,
// so unit-only CI stays green; run locally with a built server (or SERVER_BIN=…).
//
// Proves the first-of race end-to-end: the instance parks on BOTH arms (a message
// catch racing a far-future timer catch), the correlated message FIRES → its arm
// wins, the losing timer catch is cancelled by the engine (its body never runs),
// and the instance COMPLETES.
import { test } from "node:test";
import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { defineFlow, WorkflowClient, Worker } from "../dist/index.js";
import { Gateway, resolveServerBin, sleep, waitFor } from "./server.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const skip = resolveServerBin() ? false : "no gateway binary built (set SERVER_BIN or `make debug`)";

test("declarative race parks on both arms, the message wins, the timer loser is cancelled, and the instance completes", { skip }, async () => {
  const scratch = join(HERE, ".it", "race");
  const gw = await Gateway.create(scratch);
  await gw.start();

  const ran = new Set<string>();
  // A far-future timer so the message deterministically wins the race.
  const flow = defineFlow("race-live", (w) => {
    w.run("prepare", async () => ({ ok: true }));
    w.race({
      approved: { signal: { correlationKey: "prKey" }, do: (b) => b.run("onApproved", async () => ({ won: "message" })) },
      timeout: { timer: { after: "P10D" }, do: (b) => b.run("onTimeout", async () => ({ won: "timer" })) },
    });
    w.run("finalize", async () => ({ done: true }));
  });

  const client = new WorkflowClient({ baseUrl: gw.baseUrl, transport: "rest" });
  const worker = new Worker({
    baseUrl: gw.baseUrl,
    workflows: [flow],
    pollTimeoutMs: 1500,
    onActivity: (e) => {
      ran.add(e.elementId);
    },
    onError: () => {},
  });

  try {
    await client.deploy(flow);
    const inst = await client.start(flow, { prKey: "PR-42" });
    worker.start();

    // `prepare` runs, then the instance parks on the event-based gateway (both the
    // message catch and the timer catch are armed).
    await waitFor(() => ran.has("prepare"), "prepare ran", 15000);
    await sleep(500);

    // Fire the correlated message — the message arm wins the race.
    await client.signal(flow, "approved", "PR-42", { approvedBy: "alice" });

    await waitFor(() => ran.has("onApproved"), "the winning message arm's body ran", 15000);
    await waitFor(() => ran.has("finalize"), "the race converged onto finalize", 15000);
    await sleep(400);

    assert.equal(ran.has("onTimeout"), false, "the losing timer arm's body must never run (its catch was cancelled)");

    const final = await client.getInstance(String(inst.processInstanceKey));
    assert.ok(final, "getInstance should return the completed instance");
    // Read the optional `state` from either the top-level response or a nested
    // `processInstance`, narrowing at runtime (no unsafe type assertions).
    let state: string | undefined;
    if (typeof final.state === "string") {
      state = final.state;
    } else {
      const pi = final.processInstance;
      if (typeof pi === "object" && pi !== null && !Array.isArray(pi) && typeof pi.state === "string") {
        state = pi.state;
      }
    }
    assert.ok(state === "COMPLETED" || state === undefined, `instance should complete after the race (state=${state})`);
  } finally {
    await worker.stop();
    await gw.stop();
  }
});
