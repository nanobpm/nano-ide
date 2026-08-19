/**
 * Kimi normalizer — ADR 0062 slice 3.
 *
 * Driven with `kimi -p --output-format stream-json`. Kimi tags each frame with an
 * `event` discriminator and folds a tool call and its result under one `tool`
 * event distinguished by `phase`. Restore is `-S [id]` (`-c` continues the
 * latest). Streaming + resume-by-id → `durable-resume`.
 */
import { type DraftEvent, type HarnessNormalizer, NormalizerDialectError, type ResumeShim } from "./types.ts";
import { asRecord, optNumber, optString, reqString } from "./record.ts";

const HARNESS = "kimi";

function toDrafts(record: unknown): readonly DraftEvent[] {
  const obj = asRecord(HARNESS, record);
  switch (obj.event) {
    case "text": {
      const text = optString(HARNESS, obj, "text");
      if (text === undefined || text.length === 0) return [];
      const role = optString(HARNESS, obj, "role");
      return [{ type: role === "user" ? "user" : role === "system" ? "system" : "assistant", text }];
    }
    case "reasoning": {
      const text = optString(HARNESS, obj, "text");
      const providerContinuation = optString(HARNESS, obj, "continuation");
      return [
        {
          type: "reasoning",
          ...(text !== undefined ? { text } : {}),
          ...(providerContinuation !== undefined ? { providerContinuation } : {}),
        },
      ];
    }
    case "tool": {
      const callId = reqString(HARNESS, obj, "id");
      const phase = optString(HARNESS, obj, "phase");
      if (phase === "result") {
        return [
          {
            type: "tool-result",
            id: `result:${callId}`,
            callId,
            ok: obj.ok !== false,
            result: obj.output ?? obj.result,
          },
        ];
      }
      if (phase === "call" || phase === undefined) {
        return [
          {
            type: "tool-call",
            id: `call:${callId}`,
            callId,
            name: reqString(HARNESS, obj, "name"),
            args: obj.arguments ?? obj.args,
          },
        ];
      }
      throw new NormalizerDialectError(HARNESS, `unknown tool phase ${JSON.stringify(phase)}`);
    }
    case "usage":
      return [
        {
          type: "usage",
          inputTokens: optNumber(HARNESS, obj, "prompt_tokens") ?? 0,
          outputTokens: optNumber(HARNESS, obj, "completion_tokens") ?? 0,
          ...(typeof obj.model === "string" ? { model: obj.model } : {}),
        },
      ];
    default:
      return [];
  }
}

export const kimiNormalizer: HarnessNormalizer = {
  harness: HARNESS,
  capabilities: { streaming: true, resumeById: true },
  toDrafts,
  resume(sessionId: string): ResumeShim {
    return { transport: "cli", sessionId, args: ["-S", sessionId] };
  },
};
