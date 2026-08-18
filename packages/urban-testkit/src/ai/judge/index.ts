// PLACEHOLDER owned by slice S3 (LLM-as-a-judge matcher). Created by S1; S3 replaces this
// whole file. It exists so the `/ai` barrel's re-exports resolve and the build stays green
// before S3 lands. It registers a `satisfiesJudge` handler that throws until S3 implements
// it.

import { registerTextMatcher } from "../assertion.ts";
import type { JudgeConfig } from "../config.ts";

const NOT_IMPLEMENTED = "satisfiesJudge is not yet implemented (slice S3)";

/** Placeholder: S3 stores judge defaults here. */
export function configureJudge(_config: JudgeConfig): void {
  // no-op until S3 lands
}

/** Placeholder: S3 implements the LLM-as-a-judge matcher here. */
export async function satisfiesJudge(
  _actual: string,
  _criteria: string,
  _options?: JudgeConfig,
): Promise<void> {
  throw new Error(NOT_IMPLEMENTED);
}

registerTextMatcher("satisfiesJudge", async () => {
  throw new Error(NOT_IMPLEMENTED);
});
