// Semantic-similarity matcher — slice S2 (issue #297).
//
// Implements `assertThatText(actual).matchesSemantically(expected, options?)`:
//   1. applies the configured TextPreprocessors (global defaults + per-call overrides) to
//      both texts;
//   2. embeds each via the configured EmbeddingModelAdapter (default = S1's deterministic,
//      network-free fake embedding adapter);
//   3. computes cosine similarity;
//   4. passes iff `score >= threshold`, else throws an assertion error reporting the score,
//      the threshold, and both preprocessed texts.
//
// Consumes S1's shapes verbatim (contract:ai-seams) — no synonyms. This module registers
// its matcher on import via `registerTextMatcher`, so importing the `/ai` barrel installs it.

import { registerTextMatcher } from "../assertion.ts";
import type { SemanticSimilarityConfig, TextPreprocessors } from "../config.ts";
import { FakeEmbeddingModelAdapter } from "../fakes.ts";
import { composePreprocessors } from "../preprocessors.ts";
import type { EmbeddingModelAdapter } from "../seams.ts";
import { describeText } from "../text.ts";
import { cosineSimilarity } from "./cosine.ts";

/** Default cosine-similarity threshold (epic sketch). */
const DEFAULT_THRESHOLD = 0.8;

/** Fully-resolved config: no optional fields, so the matcher never re-defaults inline. */
interface ResolvedSimilarityConfig {
  readonly threshold: number;
  readonly preprocessors: TextPreprocessors;
  readonly adapter: EmbeddingModelAdapter;
}

function baseDefaults(): ResolvedSimilarityConfig {
  return {
    threshold: DEFAULT_THRESHOLD,
    preprocessors: [],
    adapter: new FakeEmbeddingModelAdapter(),
  };
}

let globalDefaults: ResolvedSimilarityConfig = baseDefaults();

/** Layers a partial config over a resolved base, leaving unset fields untouched. */
function resolve(
  config: SemanticSimilarityConfig | undefined,
  base: ResolvedSimilarityConfig,
): ResolvedSimilarityConfig {
  if (config === undefined) {
    return base;
  }
  return {
    threshold: config.threshold ?? base.threshold,
    preprocessors: config.preprocessors ?? base.preprocessors,
    adapter: config.adapter ?? base.adapter,
  };
}

/**
 * Sets the global defaults (adapter, threshold, preprocessors) for `matchesSemantically`.
 * Unspecified fields keep their current value; per-call `options` still override these.
 */
export function configureSimilarity(config: SemanticSimilarityConfig): void {
  globalDefaults = resolve(config, globalDefaults);
}

/** Test-visible reset so suites don't leak global config into one another. */
export function resetSimilarityDefaults(): void {
  globalDefaults = baseDefaults();
}

/**
 * Semantic-similarity assertion: passes iff the cosine similarity of the (preprocessed)
 * `actual` and `expected` embeddings is `>= threshold`, else throws.
 */
export async function matchesSemantically(
  actual: string,
  expected: string,
  options?: SemanticSimilarityConfig,
): Promise<void> {
  const resolved = resolve(options, globalDefaults);
  const preprocess = composePreprocessors(resolved.preprocessors);
  const actualText = preprocess(actual);
  const expectedText = preprocess(expected);

  const [actualVector, expectedVector] = await Promise.all([
    resolved.adapter.embed(actualText),
    resolved.adapter.embed(expectedText),
  ]);
  const score = cosineSimilarity(actualVector, expectedVector);
  if (score >= resolved.threshold) {
    return;
  }
  throw new Error(
    `matchesSemantically failed: cosine similarity ${score.toFixed(4)} < threshold ` +
      `${resolved.threshold} — actual ${describeText(actualText)} vs expected ` +
      `${describeText(expectedText)}`,
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isTextPreprocessors(value: unknown): value is TextPreprocessors {
  return Array.isArray(value) && value.every((item) => typeof item === "function");
}

function isEmbeddingModelAdapter(value: unknown): value is EmbeddingModelAdapter {
  return (
    isRecord(value) &&
    typeof value.modelId === "string" &&
    typeof value.dimension === "number" &&
    typeof value.embed === "function"
  );
}

/**
 * Recovers a {@link SemanticSimilarityConfig} from the type-erased registry argument without
 * an `as`-cast (AGENTS.md bans `as T`): validates each field and rebuilds a typed object.
 */
function toSimilarityConfig(value: unknown): SemanticSimilarityConfig | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!isRecord(value)) {
    throw new TypeError("matchesSemantically options must be an object when provided");
  }
  const record = value;
  const config: {
    threshold?: number;
    preprocessors?: TextPreprocessors;
    adapter?: EmbeddingModelAdapter;
  } = {};
  if (record.threshold !== undefined) {
    if (typeof record.threshold !== "number") {
      throw new TypeError("matchesSemantically threshold must be a number");
    }
    config.threshold = record.threshold;
  }
  if (record.preprocessors !== undefined) {
    if (!isTextPreprocessors(record.preprocessors)) {
      throw new TypeError("matchesSemantically preprocessors must be an array of functions");
    }
    config.preprocessors = record.preprocessors;
  }
  if (record.adapter !== undefined) {
    if (!isEmbeddingModelAdapter(record.adapter)) {
      throw new TypeError("matchesSemantically adapter must be an EmbeddingModelAdapter");
    }
    config.adapter = record.adapter;
  }
  return config;
}

registerTextMatcher("matchesSemantically", async (actual, args) => {
  const [expected, options] = args;
  if (typeof expected !== "string") {
    throw new TypeError("matchesSemantically(expected) requires a string");
  }
  await matchesSemantically(actual, expected, toSimilarityConfig(options));
});
