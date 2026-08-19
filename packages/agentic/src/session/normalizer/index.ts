/**
 * `@nanobpm/agentic/session/normalizer` — ADR 0062 slice 3 public surface.
 *
 * The `stream-json`/native-transcript fallback ingestion backend: the per-harness
 * {@link HarnessNormalizer} contract, the shared causal-chain linker
 * ({@link normalizeSession}/{@link linkDrafts}), the capability probe
 * ({@link capabilityProbe}), and the current-fleet registry that enumerates the
 * harnesses this slice ships an adapter for. A caller (the ingestion boundary,
 * slice 5's enrolment gate) looks a harness up by id and gets its normalizer;
 * {@link probeFleet} folds the whole registry into `durable-resume`
 * advertisements in one call.
 *
 * The registry is derived from the normalizer modules themselves (each is keyed
 * by its own `harness` id), so there is no second hand-maintained list of harness
 * names to drift against.
 */
export type {
  CapabilityAdvertisement,
  DistributiveOmit,
  DraftEvent,
  HarnessCapabilities,
  HarnessNormalizer,
  ResumeShim,
} from "./types.ts";
export { capabilityProbe, NormalizerDialectError } from "./types.ts";
export type { LinkOptions } from "./link.ts";
export { linkDrafts, normalizeSession } from "./link.ts";
export { copilotNormalizer } from "./copilot.ts";
export { claudeNormalizer } from "./claude.ts";
export { qwenNormalizer } from "./qwen.ts";
export { kimiNormalizer } from "./kimi.ts";
export { piNormalizer } from "./pi.ts";
export { deepseekNormalizer } from "./deepseek.ts";

import { claudeNormalizer } from "./claude.ts";
import { copilotNormalizer } from "./copilot.ts";
import { deepseekNormalizer } from "./deepseek.ts";
import { kimiNormalizer } from "./kimi.ts";
import { piNormalizer } from "./pi.ts";
import { qwenNormalizer } from "./qwen.ts";
import { type CapabilityAdvertisement, capabilityProbe, type HarnessNormalizer } from "./types.ts";

/** Every fallback normalizer in the current fleet, in reference-dialect order. */
export const FLEET_NORMALIZERS: readonly HarnessNormalizer[] = [
  copilotNormalizer,
  claudeNormalizer,
  qwenNormalizer,
  kimiNormalizer,
  piNormalizer,
  deepseekNormalizer,
];

/** Registry keyed by `harness` id, derived from {@link FLEET_NORMALIZERS}. */
export const NORMALIZER_REGISTRY: ReadonlyMap<string, HarnessNormalizer> = new Map(
  FLEET_NORMALIZERS.map((n) => [n.harness, n]),
);

/** Look a harness's normalizer up by id, or `undefined` when it is not in the fleet. */
export function normalizerFor(harness: string): HarnessNormalizer | undefined {
  return NORMALIZER_REGISTRY.get(harness);
}

/** Probe every harness in the fleet for its derived `durable-resume` advertisement. */
export function probeFleet(): readonly CapabilityAdvertisement[] {
  return FLEET_NORMALIZERS.map(capabilityProbe);
}
