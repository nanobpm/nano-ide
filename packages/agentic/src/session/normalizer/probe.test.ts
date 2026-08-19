import assert from "node:assert/strict";
import { test } from "node:test";
import { capabilityProbe, type HarnessNormalizer } from "./types.ts";
import { FLEET_NORMALIZERS, normalizerFor, probeFleet } from "./index.ts";

function syntheticNormalizer(streaming: boolean, resumeById: boolean): HarnessNormalizer {
  return {
    harness: `synthetic(${streaming},${resumeById})`,
    capabilities: { streaming, resumeById },
    toDrafts: () => [],
    resume: (sessionId) => ({ transport: "cli", sessionId, args: [] }),
  };
}

test("durable-resume is the AND of streaming and resume-by-id (derived, not declared)", () => {
  assert.equal(capabilityProbe(syntheticNormalizer(true, true)).durableResume, true);
  assert.equal(capabilityProbe(syntheticNormalizer(true, false)).durableResume, false, "a stream we cannot resume is not durable");
  assert.equal(capabilityProbe(syntheticNormalizer(false, true)).durableResume, false, "a resume with no mind to replay is not durable");
  assert.equal(capabilityProbe(syntheticNormalizer(false, false)).durableResume, false);
});

test("the probe echoes the raw capabilities alongside the derived bit", () => {
  const ad = capabilityProbe(syntheticNormalizer(true, false));
  assert.deepEqual(ad, {
    harness: "synthetic(true,false)",
    streaming: true,
    resumeById: false,
    durableResume: false,
  });
});

test("every harness in the current fleet advertises durable-resume", () => {
  const fleet = probeFleet();
  assert.equal(fleet.length, FLEET_NORMALIZERS.length);
  for (const ad of fleet) {
    assert.equal(ad.durableResume, true, `${ad.harness} must advertise durable-resume`);
    assert.equal(ad.streaming, true);
    assert.equal(ad.resumeById, true);
  }
});

test("the fleet registry covers exactly the documented harnesses, keyed by id", () => {
  const harnesses = probeFleet().map((a) => a.harness).sort();
  assert.deepEqual(harnesses, ["@github/copilot", "claude-code", "deepseek", "kimi", "pi", "qwen-code"]);
  for (const n of FLEET_NORMALIZERS) {
    assert.equal(normalizerFor(n.harness), n, "registry lookup returns the same instance");
  }
  assert.equal(normalizerFor("not-a-harness"), undefined);
});
