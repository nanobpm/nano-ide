// Record-mode helpers: deliberately regenerate cassettes from a LIVE real backend
// (issue #297, slice S4).
//
// These wire a real adapter as the capture source of S1's record/replay adapter purely via
// its PLUGGABLE injection point (the `captureSource` constructor option) — this file does
// NOT edit S1's `record-replay.ts`. Everything here is opt-in-gated (the real factory
// throws without `URBAN_TESTKIT_AI_REAL`), so default CI never records from the network.

import { assertRealAiEnabled } from "./env.ts";
import { createRealAdapters, type RealAdapterOptions } from "./factory.ts";
import {
  Cassette,
  RecordReplayChatModelAdapter,
  RecordReplayEmbeddingAdapter,
} from "../../record-replay.ts";

/** Options for building a recording adapter that captures from a live real backend. */
export interface RecordFromLiveOptions {
  /** The cassette to record into. */
  readonly cassette: Cassette;
  /** Real-backend selection/config forwarded to `createRealAdapters`. */
  readonly real?: RealAdapterOptions;
}

/**
 * Builds a record-mode embedding adapter whose capture source is a LIVE real embedding
 * adapter, injected through S1's `captureSource` option. Opt-in gated.
 */
export async function createRecordingEmbeddingAdapter(
  options: RecordFromLiveOptions,
): Promise<RecordReplayEmbeddingAdapter> {
  assertRealAiEnabled();
  const { embedding } = await createRealAdapters(options.real);
  return new RecordReplayEmbeddingAdapter({
    mode: "record",
    cassette: options.cassette,
    captureSource: embedding,
    dimension: embedding.dimension,
  });
}

/**
 * Builds a record-mode chat adapter whose capture source is a LIVE real chat adapter,
 * injected through S1's `captureSource` option. Opt-in gated.
 */
export async function createRecordingChatModelAdapter(
  options: RecordFromLiveOptions,
): Promise<RecordReplayChatModelAdapter> {
  assertRealAiEnabled();
  const { chat } = await createRealAdapters(options.real);
  return new RecordReplayChatModelAdapter({
    mode: "record",
    cassette: options.cassette,
    captureSource: chat,
  });
}
