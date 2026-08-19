/**
 * DeepSeek Harness normalizer — ADR 0062 slice 3.
 *
 * The DeepSeek Harness exposes a live `SessionEvent` feed rather than a spawned
 * `stream-json` transport: its frames are already event-shaped (`kind`-tagged),
 * so the dialect is a thin renaming onto the canonical union. Restore is the
 * harness's in-process `seed`/`restore` pair, so the resume shim is the SDK
 * `restore(id)` call. Streaming + resume-by-id → `durable-resume`.
 */
import type { DraftEvent, HarnessNormalizer, ResumeShim } from "./types.ts";
import { asRecord, optNumber, optString, reqString } from "./record.ts";

const HARNESS = "deepseek";

function toDrafts(record: unknown): readonly DraftEvent[] {
  const obj = asRecord(HARNESS, record);
  switch (obj.kind) {
    case "message": {
      const text = optString(HARNESS, obj, "content") ?? optString(HARNESS, obj, "text");
      if (text === undefined || text.length === 0) return [];
      const role = optString(HARNESS, obj, "role");
      return [{ type: role === "user" ? "user" : role === "system" ? "system" : "assistant", text }];
    }
    case "reasoning": {
      const text = optString(HARNESS, obj, "content") ?? optString(HARNESS, obj, "text");
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
    case "tool_result": {
      const callId = reqString(HARNESS, obj, "id");
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
    case "usage":
      return [
        {
          type: "usage",
          inputTokens: optNumber(HARNESS, obj, "input") ?? optNumber(HARNESS, obj, "inputTokens") ?? 0,
          outputTokens: optNumber(HARNESS, obj, "output") ?? optNumber(HARNESS, obj, "outputTokens") ?? 0,
          ...(typeof obj.model === "string" ? { model: obj.model } : {}),
        },
      ];
    default:
      return [];
  }
}

export const deepseekNormalizer: HarnessNormalizer = {
  harness: HARNESS,
  capabilities: { streaming: true, resumeById: true },
  toDrafts,
  resume(sessionId: string): ResumeShim {
    return { transport: "sdk", sessionId, call: "restore", args: [sessionId] };
  },
};
