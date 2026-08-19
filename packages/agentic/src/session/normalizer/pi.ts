/**
 * pi / little-coder normalizer — ADR 0062 slice 3.
 *
 * Driven with `pi -p --mode json` (or `--mode rpc`): a JSON-RPC 2.0 notification
 * stream. Session content arrives as `method` notifications
 * (`session/message`, `session/reasoning`, `session/toolCall`,
 * `session/toolResult`, `session/usage`) with a `params` payload. Restore is
 * `--session-id <id>` (create-if-missing — the same flag both resumes an
 * existing session and starts one under a chosen id); `-r` is the short alias and
 * `--fork` branches. Streaming + resume-by-id → `durable-resume`.
 */
import type { DraftEvent, HarnessNormalizer, ResumeShim } from "./types.ts";
import { asRecord, isRecord, optNumber, optString, reqString } from "./record.ts";

const HARNESS = "pi";

function params(obj: Record<string, unknown>): Record<string, unknown> {
  return isRecord(obj.params) ? obj.params : {};
}

function toDrafts(record: unknown): readonly DraftEvent[] {
  const obj = asRecord(HARNESS, record);
  const method = obj.method;
  if (typeof method !== "string") return []; // a JSON-RPC result/ack, not a notification
  const p = params(obj);
  switch (method) {
    case "session/message": {
      const text = optString(HARNESS, p, "text");
      if (text === undefined || text.length === 0) return [];
      const role = optString(HARNESS, p, "role");
      return [{ type: role === "user" ? "user" : role === "system" ? "system" : "assistant", text }];
    }
    case "session/reasoning": {
      const text = optString(HARNESS, p, "text");
      const providerContinuation = optString(HARNESS, p, "continuation");
      return [
        {
          type: "reasoning",
          ...(text !== undefined ? { text } : {}),
          ...(providerContinuation !== undefined ? { providerContinuation } : {}),
        },
      ];
    }
    case "session/toolCall": {
      const callId = reqString(HARNESS, p, "id");
      return [{ type: "tool-call", id: `call:${callId}`, callId, name: reqString(HARNESS, p, "name"), args: p.args }];
    }
    case "session/toolResult": {
      const callId = reqString(HARNESS, p, "id");
      return [{ type: "tool-result", id: `result:${callId}`, callId, ok: p.ok !== false, result: p.result }];
    }
    case "session/usage":
      return [
        {
          type: "usage",
          inputTokens: optNumber(HARNESS, p, "inputTokens") ?? 0,
          outputTokens: optNumber(HARNESS, p, "outputTokens") ?? 0,
          ...(typeof p.model === "string" ? { model: p.model } : {}),
        },
      ];
    default:
      return [];
  }
}

export const piNormalizer: HarnessNormalizer = {
  harness: HARNESS,
  capabilities: { streaming: true, resumeById: true },
  toDrafts,
  resume(sessionId: string): ResumeShim {
    // create-if-missing: `--session-id <id>` resumes it when it exists and starts
    // it under that id when it does not.
    return { transport: "cli", sessionId, args: ["--session-id", sessionId] };
  },
};
