// Config + preprocessor types shared by both matcher siblings (issue #297, slice S1).
//
// These types are consumed by S2 (semantic-similarity) and S3 (LLM-judge); they live
// here so neither sibling redefines a synonym.

import type { ChatModelAdapter, EmbeddingModelAdapter } from "./seams.ts";

/** A single composable string transform applied before comparison/judging. */
export type TextPreprocessor = (input: string) => string;

/** An ordered, composable list of {@link TextPreprocessor}s. */
export type TextPreprocessors = readonly TextPreprocessor[];

/** Configuration for the `matchesSemantically` matcher (S2). */
export interface SemanticSimilarityConfig {
  /** Cosine-similarity threshold in [0, 1]; a match requires `score >= threshold`. */
  readonly threshold?: number;
  /** Preprocessors applied to both texts before embedding. */
  readonly preprocessors?: TextPreprocessors;
  /** Embedding adapter to use; defaults to the deterministic fake. */
  readonly adapter?: EmbeddingModelAdapter;
}

/** Configuration for the `satisfiesJudge` matcher (S3). */
export interface JudgeConfig {
  /** Chat adapter to use; defaults to the deterministic fake. */
  readonly adapter?: ChatModelAdapter;
  /** Builds the judge prompt from the criteria and the actual text. */
  readonly promptTemplate?: (criteria: string, actual: string) => string;
}
