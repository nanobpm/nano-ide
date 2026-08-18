// Deterministic, network-free fake adapters — the DEFAULT backends (issue #297, slice S1).
//
// Both fakes are pure functions of their input: same input → same output, forever. They
// perform zero network I/O and are safe to run in CI.

import { declareFakeBacking } from "./inventory.ts";
import type { ChatInput, ChatModelAdapter, ChatResult, EmbeddingModelAdapter } from "./seams.ts";
import { serializeVerdict } from "./verdict.ts";

const DEFAULT_EMBEDDING_DIMENSION = 64;

/** FNV-1a — a small, deterministic, dependency-free string hash. */
function fnv1a(text: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index++) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((token) => token.length > 0);
}

/**
 * A deterministic bag-of-tokens embedding: each token increments the vector slot its
 * hash maps to. Texts that share tokens get higher cosine similarity, identical texts get
 * cosine 1, disjoint texts get 0 — meaningful yet fully reproducible.
 */
export class FakeEmbeddingModelAdapter implements EmbeddingModelAdapter {
  readonly modelId = "fake-embedding";
  readonly dimension: number;

  constructor(dimension: number = DEFAULT_EMBEDDING_DIMENSION) {
    if (!Number.isInteger(dimension) || dimension <= 0) {
      throw new Error("embedding dimension must be a positive integer");
    }
    this.dimension = dimension;
  }

  async embed(text: string): Promise<number[]> {
    const vector = new Array<number>(this.dimension).fill(0);
    for (const token of tokenize(text)) {
      vector[fnv1a(token) % this.dimension] += 1;
    }
    return vector;
  }
}

/**
 * Extracts a labelled `LABEL:` section from a prompt, up to the next uppercase label or
 * end of string. Returns `null` when the label is absent.
 */
function extractSection(prompt: string, label: string): string | null {
  const pattern = new RegExp(`${label}:\\s*([\\s\\S]*?)(?=\\n[A-Z][A-Z ]*:|$)`, "i");
  const match = prompt.match(pattern);
  return match ? match[1].trim() : null;
}

/**
 * A deterministic, rule-driven fake judge. When the prompt carries `CRITERIA:` and
 * `ACTUAL:` sections, it PASSES iff every significant criteria token (length ≥ 3) is
 * present among the actual tokens; otherwise it fails and names the missing tokens. With
 * no structured sections it defaults to a pass. The verdict is returned as canonical
 * verdict JSON (see {@link serializeVerdict}).
 *
 * The optional image part is accepted transparently — multimodal input must not throw.
 */
export class FakeChatModelAdapter implements ChatModelAdapter {
  readonly modelId = "fake-chat";

  async chat(input: ChatInput): Promise<ChatResult> {
    const criteria = extractSection(input.prompt, "CRITERIA");
    const actual = extractSection(input.prompt, "ACTUAL");
    if (criteria === null || actual === null) {
      return {
        text: serializeVerdict({
          pass: true,
          rationale: "no structured CRITERIA/ACTUAL sections; defaulting to pass",
        }),
      };
    }
    const actualTokens = new Set(tokenize(actual));
    const missing = tokenize(criteria)
      .filter((token) => token.length >= 3)
      .filter((token) => !actualTokens.has(token));
    if (missing.length === 0) {
      return {
        text: serializeVerdict({ pass: true, rationale: "all criteria terms present in actual" }),
      };
    }
    return {
      text: serializeVerdict({
        pass: false,
        rationale: `missing criteria terms: ${[...new Set(missing)].join(", ")}`,
      }),
    };
  }
}

declareFakeBacking("EmbeddingModelAdapter");
declareFakeBacking("ChatModelAdapter");
