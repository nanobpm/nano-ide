// Local / in-browser real adapters (issue #297, slice S4).
//
// An on-device model (Transformers.js) backs BOTH seams without a hosted service, aligning
// with the on-device vision-demo direction:
//   - `LocalEmbeddingAdapter` implements `EmbeddingModelAdapter` via a feature-extraction
//     pipeline;
//   - `LocalChatModelAdapter` implements `ChatModelAdapter` via a text-generation pipeline,
//     switching to image-to-text when the optional image part is present (vision).
//
// IMPORT-SAFETY: no top-level import of the `@xenova/transformers` optional dependency —
// it is loaded LAZILY via a non-literal dynamic `import()` inside the opt-in-gated
// `createLocalModelAdapters` factory only. Importing this module on the default/Deno lane
// never resolves it.
//
// LIVE activation requires the `URBAN_TESTKIT_AI_REAL` opt-in (see ./env.ts). Model weights
// download on first use, so this too is off by default.

import { assertRealAiEnabled, importOptionalDependency } from "./env.ts";
import type {
  ChatInput,
  ChatModelAdapter,
  ChatResult,
  EmbeddingModelAdapter,
} from "../../seams.ts";

/** npm specifier of the optional on-device model runtime (loaded lazily, never at import). */
const TRANSFORMERS_MODULE = "@xenova/transformers";
const DEFAULT_EMBEDDING_MODEL = "Xenova/all-MiniLM-L6-v2";
const DEFAULT_EMBEDDING_DIMENSION = 384;
const DEFAULT_TEXT_MODEL = "Xenova/LaMini-Flan-T5-783M";
const DEFAULT_VISION_MODEL = "Xenova/vit-gpt2-image-captioning";

/** Configuration for the local model backend. */
export interface LocalModelConfig {
  /** Feature-extraction model id. */
  readonly embeddingModel?: string;
  /** Dimension the feature-extraction model returns. */
  readonly embeddingDimension?: number;
  /** Text-generation model id (plain-text judging). */
  readonly textModel?: string;
  /** Image-to-text model id (vision judging). */
  readonly visionModel?: string;
}

// --- Minimal structural views of the Transformers.js surface we call ---

interface TransformersPipeline {
  (input: unknown, options?: Record<string, unknown>): Promise<unknown>;
}

interface PipelineFactory {
  (task: string, model?: string): Promise<TransformersPipeline>;
}

function isPipelineFactory(value: unknown): value is PipelineFactory {
  return typeof value === "function";
}

function pickPipelineFactory(mod: unknown): PipelineFactory {
  if (typeof mod === "object" && mod !== null) {
    const named = Reflect.get(mod, "pipeline");
    if (isPipelineFactory(named)) {
      return named;
    }
    const fromDefault = Reflect.get(mod, "default");
    if (typeof fromDefault === "object" && fromDefault !== null) {
      const nested = Reflect.get(fromDefault, "pipeline");
      if (isPipelineFactory(nested)) {
        return nested;
      }
    }
  }
  throw new Error(`the '${TRANSFORMERS_MODULE}' module did not export a 'pipeline' factory`);
}

function isNumberIterable(value: unknown): value is Iterable<number> {
  return typeof value === "object" && value !== null && Symbol.iterator in value;
}

function extractEmbeddingVector(output: unknown): number[] {
  if (typeof output === "object" && output !== null) {
    const data = Reflect.get(output, "data");
    if (isNumberIterable(data)) {
      return Array.from(data, (value) => Number(value));
    }
  }
  throw new Error("unexpected feature-extraction output (missing numeric `data`)");
}

function extractGeneratedText(output: unknown): string {
  const first = Array.isArray(output) ? output[0] : output;
  if (typeof first === "object" && first !== null) {
    const generated = Reflect.get(first, "generated_text");
    if (typeof generated === "string") {
      return generated;
    }
  }
  throw new Error("unexpected generation output (missing `generated_text`)");
}

/** Real embedding adapter over an on-device feature-extraction pipeline. */
export class LocalEmbeddingAdapter implements EmbeddingModelAdapter {
  readonly modelId: string;
  readonly dimension: number;
  readonly #pipeline: TransformersPipeline;

  constructor(pipeline: TransformersPipeline, config: LocalModelConfig = {}) {
    this.#pipeline = pipeline;
    this.modelId = config.embeddingModel ?? DEFAULT_EMBEDDING_MODEL;
    this.dimension = config.embeddingDimension ?? DEFAULT_EMBEDDING_DIMENSION;
  }

  async embed(text: string): Promise<number[]> {
    const output = await this.#pipeline(text, { pooling: "mean", normalize: true });
    return extractEmbeddingVector(output);
  }
}

/** Real chat/judge adapter over on-device text-generation (and image-to-text for vision). */
export class LocalChatModelAdapter implements ChatModelAdapter {
  readonly modelId: string;
  readonly #textPipeline: TransformersPipeline;
  readonly #visionPipeline: TransformersPipeline;

  constructor(
    textPipeline: TransformersPipeline,
    visionPipeline: TransformersPipeline,
    config: LocalModelConfig = {},
  ) {
    this.#textPipeline = textPipeline;
    this.#visionPipeline = visionPipeline;
    this.modelId = config.textModel ?? DEFAULT_TEXT_MODEL;
  }

  async chat(input: ChatInput): Promise<ChatResult> {
    if (input.image !== undefined) {
      const caption = await this.#visionPipeline(
        `data:${input.image.mediaType};base64,${input.image.data}`,
      );
      const captionText = extractGeneratedText(caption);
      const output = await this.#textPipeline(`${input.prompt}\n\nIMAGE: ${captionText}`);
      return { text: extractGeneratedText(output) };
    }
    const output = await this.#textPipeline(input.prompt);
    return { text: extractGeneratedText(output) };
  }
}

/**
 * LIVE activation of the on-device backend. Throws (before any import/download) unless the
 * opt-in env is set, then lazily loads `@xenova/transformers` and returns real adapters for
 * BOTH seams.
 */
export async function createLocalModelAdapters(
  config: LocalModelConfig = {},
): Promise<{ embedding: LocalEmbeddingAdapter; chat: LocalChatModelAdapter }> {
  assertRealAiEnabled();
  const mod = await importOptionalDependency(TRANSFORMERS_MODULE);
  const pipeline = pickPipelineFactory(mod);
  const [features, textGen, vision] = await Promise.all([
    pipeline("feature-extraction", config.embeddingModel ?? DEFAULT_EMBEDDING_MODEL),
    pipeline("text2text-generation", config.textModel ?? DEFAULT_TEXT_MODEL),
    pipeline("image-to-text", config.visionModel ?? DEFAULT_VISION_MODEL),
  ]);
  return {
    embedding: new LocalEmbeddingAdapter(features, config),
    chat: new LocalChatModelAdapter(textGen, vision, config),
  };
}
