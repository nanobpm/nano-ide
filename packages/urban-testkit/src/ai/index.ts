// @nanobpm/urban-testkit `/ai` surface — S1 scaffold (issue #297).
//
// AI-judge & semantic-similarity assertions for Urban apps. This barrel is the single
// public entry for the `./ai` subpath; siblings (S2 similarity, S3 judge, S4 real
// adapters) add code inside their own subdirectories and never edit this file.
//
// The re-exports from `./similarity`, `./judge` and `./adapters/real` also import those
// modules for their SIDE-EFFECT registration (matcher registration; static real-seam
// descriptors). Every module imported here is import-safe: no network, no optional-dep
// top-level import (see `./adapters/real/index.ts`).

export type {
  ChatInput,
  ChatModelAdapter,
  ChatResult,
  ContentPart,
  EmbeddingModelAdapter,
  ImagePart,
  TextPart,
} from "./seams.ts";
export type {
  JudgeConfig,
  SemanticSimilarityConfig,
  TextPreprocessor,
  TextPreprocessors,
} from "./config.ts";
export { composePreprocessors, lowercase, stripPunctuation, trim } from "./preprocessors.ts";
export { FakeChatModelAdapter, FakeEmbeddingModelAdapter } from "./fakes.ts";
export { type ChatVerdict, parseVerdict, serializeVerdict } from "./verdict.ts";
export {
  Cassette,
  RecordReplayChatModelAdapter,
  RecordReplayEmbeddingAdapter,
  type RecordReplayMode,
} from "./record-replay.ts";
export {
  assertThatText,
  createTextMatcherRegistry,
  registerTextMatcher,
  type TextAssertion,
  type TextMatcher,
  type TextMatcherRegistry,
} from "./assertion.ts";
export {
  type RealSeamDescriptor,
  registerRealSeamDescriptor,
  type SeamId,
  seamInventory,
  type SeamInventoryEntry,
} from "./inventory.ts";

// Sibling surfaces — pre-wired so S2/S3/S4 only fill their own file.
export { configureSimilarity, matchesSemantically } from "./similarity/index.ts"; // S2
export { configureJudge, satisfiesJudge } from "./judge/index.ts"; // S3
export * from "./adapters/real/index.ts"; // S4 (real adapters; names owned by S4)
