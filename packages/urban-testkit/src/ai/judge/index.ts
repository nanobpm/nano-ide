// LLM-as-a-judge matcher (issue #297, slice S3). Replaces the S1 placeholder.
//
// `satisfiesJudge(actual, criteria, options?)` builds a judge prompt from the criteria
// and the actual text, sends it through the S1 `ChatModelAdapter` seam (default = the
// deterministic `FakeChatModelAdapter`, zero network), parses the canonical
// `{ pass, rationale }` verdict via S1's shared `parseVerdict`, and passes on a `pass`
// verdict — otherwise it throws an assertion error surfacing the judge's rationale and
// the criteria.
//
// Multimodal (image + prompt) judging rides the SAME chat seam via `ChatInput.image`;
// there is NO separate multimodal seam. It is an opt-in per-call input carried on the
// options object, served deterministically by the fake (which accepts the image shape).

import { registerTextMatcher } from "../assertion.ts";
import type { JudgeConfig, JudgeOptions } from "../config.ts";
import { FakeChatModelAdapter } from "../fakes.ts";
import type { ChatInput, ChatModelAdapter, ImagePart } from "../seams.ts";
import { describeText } from "../text.ts";
import { parseVerdict } from "../verdict.ts";

/** Builds the judge prompt from the criteria and the actual text. */
export type JudgePromptTemplate = (criteria: string, actual: string) => string;

/**
 * The default judge prompt. Emits `CRITERIA:` and `ACTUAL:` sections and asks for a JSON
 * verdict — the structure the chat seam's canonical verdict contract expects, so the
 * deterministic fake judge (which keys off those sections) evaluates it meaningfully.
 */
export function defaultJudgePrompt(criteria: string, actual: string): string {
  return [
    "You are a strict evaluator. Decide whether the ACTUAL text satisfies the CRITERIA.",
    'Respond with a JSON verdict of the shape {"pass": boolean, "rationale": string}.',
    "",
    `CRITERIA:\n${criteria}`,
    "",
    `ACTUAL:\n${actual}`,
  ].join("\n");
}

interface JudgeDefaults {
  readonly adapter?: ChatModelAdapter;
  readonly promptTemplate?: JudgePromptTemplate;
}

let defaults: JudgeDefaults = {};

/**
 * Sets global judge defaults (adapter, prompt template). Per-call `options` override
 * these. The default adapter remains the deterministic fake until reconfigured.
 */
export function configureJudge(config: JudgeConfig): void {
  defaults = { adapter: config.adapter, promptTemplate: config.promptTemplate };
}

function resolveAdapter(options?: JudgeOptions): ChatModelAdapter {
  return options?.adapter ?? defaults.adapter ?? new FakeChatModelAdapter();
}

function resolveTemplate(options?: JudgeOptions): JudgePromptTemplate {
  return options?.promptTemplate ?? defaults.promptTemplate ?? defaultJudgePrompt;
}

/**
 * Judges whether `actual` satisfies `criteria` using the configured chat seam. Resolves
 * on a `pass` verdict; otherwise throws an `Error` whose message surfaces the judge's
 * rationale and the criteria. An optional `options.image` rides the same chat seam
 * (multimodal) — no separate seam.
 */
export async function satisfiesJudge(
  actual: string,
  criteria: string,
  options?: JudgeOptions,
): Promise<void> {
  const adapter = resolveAdapter(options);
  const prompt = resolveTemplate(options)(criteria, actual);
  const input: ChatInput = options?.image ? { prompt, image: options.image } : { prompt };
  const result = await adapter.chat(input);
  const verdict = parseVerdict(result.text);
  if (verdict.pass) {
    return;
  }
  throw new Error(
    `satisfiesJudge failed — criteria: ${describeText(criteria)}; judge rationale: ${describeText(
      verdict.rationale,
    )}`,
    { cause: { criteria, rationale: verdict.rationale } },
  );
}

function isChatModelAdapter(value: unknown): value is ChatModelAdapter {
  return (
    typeof value === "object" &&
    value !== null &&
    "modelId" in value &&
    typeof value.modelId === "string" &&
    "chat" in value &&
    typeof value.chat === "function"
  );
}

function isImagePart(value: unknown): value is ImagePart {
  return (
    typeof value === "object" &&
    value !== null &&
    "kind" in value &&
    value.kind === "image" &&
    "mediaType" in value &&
    typeof value.mediaType === "string" &&
    "data" in value &&
    typeof value.data === "string"
  );
}

function isPromptTemplate(value: unknown): value is JudgePromptTemplate {
  return typeof value === "function";
}

/**
 * Narrows the untyped fluent-dispatch options argument into a {@link JudgeOptions},
 * reading only the recognised, validated fields (no `as` casts). Unknown/mis-typed
 * fields are dropped; a non-object — or an array, which is a `typeof "object"` but
 * never a valid options bag — is rejected loudly so caller mistakes surface instead
 * of silently collapsing every field to `undefined`.
 */
export function narrowJudgeOptions(value: unknown): JudgeOptions | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("satisfiesJudge options must be an object");
  }
  const adapter =
    "adapter" in value && isChatModelAdapter(value.adapter) ? value.adapter : undefined;
  const promptTemplate =
    "promptTemplate" in value && isPromptTemplate(value.promptTemplate)
      ? value.promptTemplate
      : undefined;
  const image = "image" in value && isImagePart(value.image) ? value.image : undefined;
  return { adapter, promptTemplate, image };
}

// Install the matcher on S1's default registry so importing the `/ai` barrel wires it up.
registerTextMatcher("satisfiesJudge", async (actual, args) => {
  const [criteria, options] = args;
  if (typeof criteria !== "string") {
    throw new TypeError("satisfiesJudge(criteria): criteria must be a string");
  }
  await satisfiesJudge(actual, criteria, narrowJudgeOptions(options));
});
