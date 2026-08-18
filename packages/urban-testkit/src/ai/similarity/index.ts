// PLACEHOLDER owned by slice S2 (semantic-similarity matcher). Created by S1; S2 replaces
// this whole file. It exists so the `/ai` barrel's re-exports resolve and the build stays
// green before S2 lands. It registers a `matchesSemantically` handler that throws until S2
// implements it.

import { registerTextMatcher } from "../assertion.ts";
import type { SemanticSimilarityConfig } from "../config.ts";

const NOT_IMPLEMENTED = "matchesSemantically is not yet implemented (slice S2)";

/** Placeholder: S2 stores similarity defaults here. */
export function configureSimilarity(_config: SemanticSimilarityConfig): void {
  // no-op until S2 lands
}

/** Placeholder: S2 implements the cosine-similarity matcher here. */
export async function matchesSemantically(
  _actual: string,
  _expected: string,
  _options?: SemanticSimilarityConfig,
): Promise<void> {
  throw new Error(NOT_IMPLEMENTED);
}

registerTextMatcher("matchesSemantically", async () => {
  throw new Error(NOT_IMPLEMENTED);
});
