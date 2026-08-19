// AI adapter seams (issue #297, slice S1).
//
// The `/ai` surface tracks EXACTLY TWO adapter seams for the completeness guard:
//   - `EmbeddingModelAdapter` — text → embedding vector (semantic similarity).
//   - `ChatModelAdapter`      — prompt (+ optional image) → text (LLM-as-a-judge).
//
// Multimodal (image + prompt) judging is folded INTO the chat seam via an optional
// image part on the chat input; there is NO separate multimodal seam. Keeping the
// surface at two seams lets S4 (real backends) and S5 (completeness guard) cover it
// fully.

/** A textual content part. */
export interface TextPart {
  readonly kind: "text";
  readonly text: string;
}

/** An image content part (base64-encoded), folded into the chat seam. */
export interface ImagePart {
  readonly kind: "image";
  /** MIME media type, e.g. `image/png`. */
  readonly mediaType: string;
  /** Base64-encoded image bytes. */
  readonly data: string;
}

/** A single content part carried by a chat input. */
export type ContentPart = TextPart | ImagePart;

/**
 * Input to the chat seam. Carries the prompt and an OPTIONAL image part so the same
 * seam serves both plain-text judging and the multimodal (vision-demo) judge.
 */
export interface ChatInput {
  /** The prompt / instruction sent to the model. */
  readonly prompt: string;
  /** Optional system preamble. */
  readonly system?: string;
  /** Optional image part — present only for multimodal (vision) judging. */
  readonly image?: ImagePart;
}

/** Result of a chat call. */
export interface ChatResult {
  readonly text: string;
}

/**
 * The chat seam. A single interface serving plain-text and multimodal judging; the
 * optional {@link ChatInput.image} is what makes it multimodal — no separate seam.
 */
export interface ChatModelAdapter {
  /** Identifier of the backing model. */
  readonly modelId: string;
  chat(input: ChatInput): Promise<ChatResult>;
}

/** The embedding seam: text → a fixed-dimension embedding vector. */
export interface EmbeddingModelAdapter {
  /** Identifier of the backing model. */
  readonly modelId: string;
  /** Dimension of the vectors this adapter returns. */
  readonly dimension: number;
  embed(text: string): Promise<number[]>;
}
