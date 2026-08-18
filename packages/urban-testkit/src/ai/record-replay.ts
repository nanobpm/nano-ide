// Record/replay (cassette-on-disk) adapters with a pluggable capture-source (issue #297, slice S1).
//
// On REPLAY the adapter reads a JSON cassette keyed by the canonical request and returns
// the recorded response byte-stably; a missing cassette, a missing entry, or a corrupted
// (edited/mismatched) entry FAILS LOUDLY (throws) — never a silent pass.
//
// On RECORD the adapter obtains responses from an INJECTABLE capture-source adapter,
// defaulting to the deterministic fake (so recording is exercised network-free in S1).
// The injection point (constructor `captureSource` option + `setCaptureSource`) lets S4
// wire a real adapter as the capture source WITHOUT editing this file.

import { readFile, writeFile } from "node:fs/promises";
import { declareRecordReplayBacking } from "./inventory.ts";
import { describeText } from "./text.ts";
import type {
  ChatInput,
  ChatModelAdapter,
  ChatResult,
  EmbeddingModelAdapter,
  ImagePart,
} from "./seams.ts";
import { FakeChatModelAdapter, FakeEmbeddingModelAdapter } from "./fakes.ts";

export type RecordReplayMode = "record" | "replay";

function isNumberArray(value: unknown): value is number[] {
  return Array.isArray(value) && value.every((item) => typeof item === "number");
}

function isChatResult(value: unknown): value is ChatResult {
  return typeof value === "object" && value !== null && "text" in value && typeof value.text === "string";
}

function isCassetteData(value: unknown): value is { entries: Record<string, unknown> } {
  return (
    typeof value === "object" &&
    value !== null &&
    "entries" in value &&
    typeof value.entries === "object" &&
    value.entries !== null &&
    !Array.isArray(value.entries)
  );
}

/**
 * A cassette: a keyed map of recorded responses persisted as JSON on disk. Loading a
 * missing/malformed file throws.
 */
export class Cassette {
  readonly #path: string | null;
  readonly #entries: Record<string, unknown>;

  constructor(path: string | null = null, entries: Record<string, unknown> = {}) {
    this.#path = path;
    this.#entries = entries;
  }

  /** Loads a cassette from disk. Throws if the file is missing or malformed. */
  static async load(path: string): Promise<Cassette> {
    let raw: string;
    try {
      raw = await readFile(path, "utf8");
    } catch (cause) {
      throw new Error(`cassette not found or unreadable: ${path}`, { cause });
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (cause) {
      throw new Error(`cassette is not valid JSON: ${path}`, { cause });
    }
    if (!isCassetteData(parsed)) {
      throw new Error(`cassette is missing the { entries } shape: ${path}`);
    }
    return new Cassette(path, { ...parsed.entries });
  }

  has(key: string): boolean {
    return Object.hasOwn(this.#entries, key);
  }

  get(key: string): unknown {
    return this.#entries[key];
  }

  set(key: string, value: unknown): void {
    this.#entries[key] = value;
  }

  /** Persists the cassette to `path` (or the load path). Throws when no path is known. */
  async save(path: string | null = null): Promise<void> {
    const target = path ?? this.#path;
    if (target === null) {
      throw new Error("cannot save a cassette without a path");
    }
    await writeFile(target, `${JSON.stringify({ entries: this.#entries }, null, 2)}\n`, "utf8");
  }
}

function embedKey(text: string): string {
  return `embed\n${JSON.stringify(text)}`;
}

function assertEmbeddingDimensionMatch(sourceDimension: number, adapterDimension: number): void {
  if (sourceDimension !== adapterDimension) {
    throw new Error(
      `capture source dimension (${sourceDimension}) must match this adapter's dimension (${adapterDimension})`,
    );
  }
}

function assertEmbeddingVectorLength(vector: number[], dimension: number, source: string): void {
  if (vector.length !== dimension) {
    throw new Error(
      `${source} vector length (${vector.length}) must match this adapter's dimension (${dimension})`,
    );
  }
}

function canonicalImage(image: ImagePart): { kind: "image"; mediaType: string; data: string } {
  return { kind: image.kind, mediaType: image.mediaType, data: image.data };
}

function chatKey(input: ChatInput): string {
  return `chat\n${JSON.stringify({
    prompt: input.prompt,
    system: input.system ?? null,
    image: input.image ? canonicalImage(input.image) : null,
  })}`;
}

interface RecordReplayEmbeddingOptions {
  readonly mode: RecordReplayMode;
  readonly cassette: Cassette;
  readonly captureSource?: EmbeddingModelAdapter;
  readonly modelId?: string;
  readonly dimension?: number;
}

/** Record/replay wrapper for the embedding seam. */
export class RecordReplayEmbeddingAdapter implements EmbeddingModelAdapter {
  readonly modelId: string;
  readonly dimension: number;
  readonly #mode: RecordReplayMode;
  readonly #cassette: Cassette;
  #captureSource: EmbeddingModelAdapter;

  constructor(options: RecordReplayEmbeddingOptions) {
    this.#mode = options.mode;
    this.#cassette = options.cassette;
    this.#captureSource = options.captureSource ?? new FakeEmbeddingModelAdapter(options.dimension);
    this.modelId = options.modelId ?? `record-replay(${this.#captureSource.modelId})`;
    this.dimension = options.dimension ?? this.#captureSource.dimension;
    if (options.captureSource !== undefined && options.dimension !== undefined) {
      assertEmbeddingDimensionMatch(options.captureSource.dimension, options.dimension);
    }
  }

  /** Injects the capture source used in record mode (S4 wires a real adapter here). */
  setCaptureSource(source: EmbeddingModelAdapter): void {
    assertEmbeddingDimensionMatch(source.dimension, this.dimension);
    this.#captureSource = source;
  }

  async embed(text: string): Promise<number[]> {
    const key = embedKey(text);
    if (this.#mode === "replay") {
      if (!this.#cassette.has(key)) {
        throw new Error(`cassette miss (no recorded embedding for request): ${describeText(key)}`);
      }
      const stored = this.#cassette.get(key);
      if (!isNumberArray(stored)) {
        throw new Error(`cassette entry is corrupt (expected number[]): ${describeText(key)}`);
      }
      assertEmbeddingVectorLength(stored, this.dimension, "replayed cassette");
      return [...stored];
    }
    const response = await this.#captureSource.embed(text);
    assertEmbeddingVectorLength(response, this.dimension, "capture source");
    this.#cassette.set(key, [...response]);
    return [...response];
  }
}

interface RecordReplayChatOptions {
  readonly mode: RecordReplayMode;
  readonly cassette: Cassette;
  readonly captureSource?: ChatModelAdapter;
  readonly modelId?: string;
}

/** Record/replay wrapper for the chat seam. */
export class RecordReplayChatModelAdapter implements ChatModelAdapter {
  readonly modelId: string;
  readonly #mode: RecordReplayMode;
  readonly #cassette: Cassette;
  #captureSource: ChatModelAdapter;

  constructor(options: RecordReplayChatOptions) {
    this.#mode = options.mode;
    this.#cassette = options.cassette;
    this.#captureSource = options.captureSource ?? new FakeChatModelAdapter();
    this.modelId = options.modelId ?? `record-replay(${this.#captureSource.modelId})`;
  }

  /** Injects the capture source used in record mode (S4 wires a real adapter here). */
  setCaptureSource(source: ChatModelAdapter): void {
    this.#captureSource = source;
  }

  async chat(input: ChatInput): Promise<ChatResult> {
    const key = chatKey(input);
    if (this.#mode === "replay") {
      if (!this.#cassette.has(key)) {
        throw new Error(`cassette miss (no recorded chat for request): ${describeText(key)}`);
      }
      const stored = this.#cassette.get(key);
      if (!isChatResult(stored)) {
        throw new Error(`cassette entry is corrupt (expected { text }): ${describeText(key)}`);
      }
      return { text: stored.text };
    }
    const response = await this.#captureSource.chat(input);
    this.#cassette.set(key, { text: response.text });
    return { text: response.text };
  }
}

declareRecordReplayBacking("EmbeddingModelAdapter");
declareRecordReplayBacking("ChatModelAdapter");
