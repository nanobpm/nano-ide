/**
 * Qwen Code normalizer — ADR 0062 slice 3.
 *
 * Driven with `qwen -p -o stream-json`. Qwen Code descends from the Gemini CLI,
 * so its streaming dialect speaks that lineage: `content` frames tagged with a
 * `role`, `thought` frames for reasoning, and `tool_call_request` /
 * `tool_call_response` pairs. Restore is `-r <id>` (`-c` continues the latest).
 * Streaming + resume-by-id → `durable-resume`.
 */
import type { DraftEvent, HarnessNormalizer, ResumeShim } from "./types.ts";
import { asRecord, optNumber, optString, reqString } from "./record.ts";

const HARNESS = "qwen-code";

function toDrafts(record: unknown): readonly DraftEvent[] {
  const obj = asRecord(HARNESS, record);
  switch (obj.type) {
    case "content": {
      const role = optString(HARNESS, obj, "role");
      const text = optString(HARNESS, obj, "text");
      if (text === undefined || text.length === 0) return [];
      return [{ type: role === "user" ? "user" : "assistant", text }];
    }
    case "thought": {
      // Gemini-lineage reasoning: a bold `subject` + `description` body.
      const subject = optString(HARNESS, obj, "subject");
      const description = optString(HARNESS, obj, "description");
      const text = [subject, description].filter((s): s is string => s !== undefined && s.length > 0).join(": ");
      const providerContinuation = optString(HARNESS, obj, "thoughtSignature");
      return [
        {
          type: "reasoning",
          ...(text.length > 0 ? { text } : {}),
          ...(providerContinuation !== undefined ? { providerContinuation } : {}),
        },
      ];
    }
    case "tool_call_request": {
      const callId = reqString(HARNESS, obj, "callId");
      return [
        { type: "tool-call", id: `call:${callId}`, callId, name: reqString(HARNESS, obj, "name"), args: obj.args },
      ];
    }
    case "tool_call_response": {
      const callId = reqString(HARNESS, obj, "callId");
      return [
        {
          type: "tool-result",
          id: `result:${callId}`,
          callId,
          ok: obj.error == null,
          result: obj.responseParts ?? obj.error,
        },
      ];
    }
    case "usage_metadata":
      return [
        {
          type: "usage",
          inputTokens: optNumber(HARNESS, obj, "promptTokenCount") ?? 0,
          outputTokens: optNumber(HARNESS, obj, "candidatesTokenCount") ?? 0,
          ...(typeof obj.model === "string" ? { model: obj.model } : {}),
        },
      ];
    default:
      return [];
  }
}

export const qwenNormalizer: HarnessNormalizer = {
  harness: HARNESS,
  capabilities: { streaming: true, resumeById: true },
  toDrafts,
  resume(sessionId: string): ResumeShim {
    return { transport: "cli", sessionId, args: ["-r", sessionId] };
  },
};
