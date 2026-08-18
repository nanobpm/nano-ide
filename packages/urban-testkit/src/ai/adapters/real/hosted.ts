// Hosted-provider real adapters (issue #297, slice S4).
//
// A single hosted provider (OpenAI-compatible) backs BOTH seams:
//   - `HostedEmbeddingAdapter` implements `EmbeddingModelAdapter` (real embeddings);
//   - `HostedChatModelAdapter` implements `ChatModelAdapter` (real chat/judge, including
//     the optional image part — vision — folded into the chat seam).
//
// IMPORT-SAFETY: this module performs NO top-level import of the `openai` optional
// dependency. The SDK is loaded LAZILY via a non-literal dynamic `import()` inside the
// opt-in-gated `createHostedProviderAdapters` factory only, so importing this module on the
// default/Deno lane (where `openai` is absent) never resolves it and never hits the network.
//
// LIVE activation requires the `URBAN_TESTKIT_AI_REAL` opt-in (see ./env.ts) plus an API
// key (config `apiKey` or the provider's own `OPENAI_API_KEY`).

import { assertRealAiEnabled, importOptionalDependency, readEnvVar } from "./env.ts";
import type {
  ChatInput,
  ChatModelAdapter,
  ChatResult,
  EmbeddingModelAdapter,
} from "../../seams.ts";

/** npm specifier of the optional hosted-provider SDK (loaded lazily, never at import). */
const OPENAI_MODULE = "openai";
const DEFAULT_EMBEDDING_MODEL = "text-embedding-3-small";
const DEFAULT_EMBEDDING_DIMENSION = 1536;
const DEFAULT_CHAT_MODEL = "gpt-4o-mini";

/** Configuration for the hosted provider. All fields are optional and never logged. */
export interface HostedProviderConfig {
  /** API key; falls back to the provider's `OPENAI_API_KEY` env var. */
  readonly apiKey?: string;
  /** Override the API base URL (for OpenAI-compatible gateways). */
  readonly baseUrl?: string;
  /** Embedding model id. */
  readonly embeddingModel?: string;
  /** Dimension the embedding model returns. */
  readonly embeddingDimension?: number;
  /** Chat/judge model id. */
  readonly chatModel?: string;
}

// --- Minimal structural views of the SDK surface we call (no optional-dep type import) ---

interface OpenAiEmbeddingResponse {
  readonly data: ReadonlyArray<{ readonly embedding: number[] }>;
}

interface OpenAiEmbeddingsApi {
  create(body: { model: string; input: string }): Promise<OpenAiEmbeddingResponse>;
}

type OpenAiContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };

interface OpenAiMessage {
  readonly role: "system" | "user";
  readonly content: string | OpenAiContentPart[];
}

interface OpenAiChatResponse {
  readonly choices: ReadonlyArray<{ readonly message: { readonly content: string | null } }>;
}

interface OpenAiChatCompletionsApi {
  create(body: { model: string; messages: OpenAiMessage[] }): Promise<OpenAiChatResponse>;
}

interface OpenAiClient {
  readonly embeddings: OpenAiEmbeddingsApi;
  readonly chat: { readonly completions: OpenAiChatCompletionsApi };
}

type OpenAiConstructor = new (options: { apiKey?: string; baseURL?: string }) => unknown;

function isConstructor(value: unknown): value is OpenAiConstructor {
  return typeof value === "function";
}

function hasCreateFn(value: unknown): boolean {
  return typeof value === "object" && value !== null && typeof Reflect.get(value, "create") === "function";
}

function isOpenAiClient(value: unknown): value is OpenAiClient {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  if (!hasCreateFn(Reflect.get(value, "embeddings"))) {
    return false;
  }
  const chat = Reflect.get(value, "chat");
  if (typeof chat !== "object" || chat === null) {
    return false;
  }
  return hasCreateFn(Reflect.get(chat, "completions"));
}

function pickOpenAiConstructor(mod: unknown): OpenAiConstructor {
  if (typeof mod === "object" && mod !== null) {
    const named = Reflect.get(mod, "OpenAI");
    if (isConstructor(named)) {
      return named;
    }
    const fallback = Reflect.get(mod, "default");
    if (isConstructor(fallback)) {
      return fallback;
    }
  }
  if (isConstructor(mod)) {
    return mod;
  }
  throw new Error(`the '${OPENAI_MODULE}' module did not export a client constructor`);
}

function buildMessages(input: ChatInput): OpenAiMessage[] {
  const messages: OpenAiMessage[] = [];
  if (input.system !== undefined) {
    messages.push({ role: "system", content: input.system });
  }
  if (input.image !== undefined) {
    messages.push({
      role: "user",
      content: [
        { type: "text", text: input.prompt },
        {
          type: "image_url",
          image_url: { url: `data:${input.image.mediaType};base64,${input.image.data}` },
        },
      ],
    });
  } else {
    messages.push({ role: "user", content: input.prompt });
  }
  return messages;
}

/** Real embedding adapter over the hosted provider. Constructed only via the opt-in factory. */
export class HostedEmbeddingAdapter implements EmbeddingModelAdapter {
  readonly modelId: string;
  readonly dimension: number;
  readonly #client: OpenAiClient;

  constructor(client: OpenAiClient, config: HostedProviderConfig = {}) {
    this.#client = client;
    this.modelId = config.embeddingModel ?? DEFAULT_EMBEDDING_MODEL;
    this.dimension = config.embeddingDimension ?? DEFAULT_EMBEDDING_DIMENSION;
  }

  async embed(text: string): Promise<number[]> {
    const response = await this.#client.embeddings.create({ model: this.modelId, input: text });
    const first = response.data[0];
    if (first === undefined) {
      throw new Error("hosted embedding response contained no data");
    }
    return [...first.embedding];
  }
}

/** Real chat/judge adapter over the hosted provider (serves the optional image part too). */
export class HostedChatModelAdapter implements ChatModelAdapter {
  readonly modelId: string;
  readonly #client: OpenAiClient;

  constructor(client: OpenAiClient, config: HostedProviderConfig = {}) {
    this.#client = client;
    this.modelId = config.chatModel ?? DEFAULT_CHAT_MODEL;
  }

  async chat(input: ChatInput): Promise<ChatResult> {
    const response = await this.#client.chat.completions.create({
      model: this.modelId,
      messages: buildMessages(input),
    });
    const first = response.choices[0];
    return { text: first?.message.content ?? "" };
  }
}

/**
 * LIVE activation of the hosted provider. Throws (before any import/network) unless the
 * opt-in env is set, then lazily loads the `openai` optional dependency and returns real
 * adapters for BOTH seams.
 */
export async function createHostedProviderAdapters(
  config: HostedProviderConfig = {},
): Promise<{ embedding: HostedEmbeddingAdapter; chat: HostedChatModelAdapter }> {
  assertRealAiEnabled();
  const mod = await importOptionalDependency(OPENAI_MODULE);
  const ClientCtor = pickOpenAiConstructor(mod);
  const client = new ClientCtor({
    apiKey: config.apiKey ?? readEnvVar("OPENAI_API_KEY"),
    baseURL: config.baseUrl,
  });
  if (!isOpenAiClient(client)) {
    throw new Error(`the '${OPENAI_MODULE}' client did not expose the expected embeddings/chat API`);
  }
  return {
    embedding: new HostedEmbeddingAdapter(client, config),
    chat: new HostedChatModelAdapter(client, config),
  };
}
