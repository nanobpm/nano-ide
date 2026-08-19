// Provider-selection factory for LIVE real adapters (issue #297, slice S4).
//
// Selects the hosted or on-device backend and returns real adapters for both seams. Every
// entry point is opt-in gated (via the underlying provider factories) so no optional
// dependency loads and no network I/O happens on the default CI path.

import type { ChatModelAdapter, EmbeddingModelAdapter } from "../../seams.ts";
import { assertRealAiEnabled } from "./env.ts";
import { createHostedProviderAdapters, type HostedProviderConfig } from "./hosted.ts";
import { createLocalModelAdapters, type LocalModelConfig } from "./local.ts";

/** Which real backend to activate. */
export type RealProvider = "hosted" | "local";

/** Options for selecting and configuring a live real backend. */
export interface RealAdapterOptions {
  /** Backend to use; defaults to `"hosted"`. */
  readonly provider?: RealProvider;
  /** Hosted-provider configuration (used when `provider` is `"hosted"`). */
  readonly hosted?: HostedProviderConfig;
  /** Local-model configuration (used when `provider` is `"local"`). */
  readonly local?: LocalModelConfig;
}

/** A matched pair of real adapters covering both seams. */
export interface RealAdapterPair {
  readonly embedding: EmbeddingModelAdapter;
  readonly chat: ChatModelAdapter;
}

/**
 * LIVE-activates the selected real backend for BOTH seams. Throws before any dynamic
 * import or network I/O unless the `URBAN_TESTKIT_AI_REAL` opt-in is set.
 */
export async function createRealAdapters(options: RealAdapterOptions = {}): Promise<RealAdapterPair> {
  assertRealAiEnabled();
  const provider = options.provider ?? "hosted";
  if (provider === "local") {
    return createLocalModelAdapters(options.local);
  }
  if (provider === "hosted") {
    return createHostedProviderAdapters(options.hosted);
  }
  // Fail loudly on an unknown provider (e.g. a JS caller passing a typo like "loacl")
  // instead of silently routing to the hosted backend and triggering network usage.
  throw new Error(
    `createRealAdapters: unknown provider ${JSON.stringify(provider)} — expected "hosted" or "local"`,
  );
}

/** LIVE-activates a real embedding adapter (opt-in gated). */
export async function createRealEmbeddingAdapter(
  options: RealAdapterOptions = {},
): Promise<EmbeddingModelAdapter> {
  const { embedding } = await createRealAdapters(options);
  return embedding;
}

/** LIVE-activates a real chat/judge adapter (opt-in gated). */
export async function createRealChatModelAdapter(
  options: RealAdapterOptions = {},
): Promise<ChatModelAdapter> {
  const { chat } = await createRealAdapters(options);
  return chat;
}
