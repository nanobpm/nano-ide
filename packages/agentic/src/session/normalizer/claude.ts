/**
 * Claude Code normalizer — ADR 0062 slice 3, reference dialect B.
 *
 * Driven with `claude -p --output-format stream-json` (paired with
 * `--input-format stream-json` to feed it), Claude Code streams one JSON object
 * per line. A turn arrives as an `assistant` frame whose `message.content` is an
 * array of typed parts — `text`, `thinking` (with an encrypted `signature`),
 * `tool_use` — and tool outputs come back as a `user` frame carrying
 * `tool_result` parts. Restore is the native `--resume <id>` (`-c` continues the
 * latest, `--from-pr` seeds from a PR — both resume-by-latest, not by-id, so the
 * id-restore shim is `--resume`). Streaming + resume-by-id → `durable-resume`.
 *
 * ## Resume-critical fidelity: `thinking.signature`
 *
 * Claude's `thinking` parts carry a `signature`: the provider's opaque, encrypted
 * reasoning-continuation token that must be replayed verbatim to continue
 * extended thinking across a resume (ADR 0062 §5). We map it to the canonical
 * `ReasoningEvent.providerContinuation`, so the native transcript remains the
 * authoritative restore path for Claude just as it does for Copilot.
 */
import { type DraftEvent, type HarnessNormalizer, NormalizerDialectError, type ResumeShim } from "./types.ts";
import { asArray, asRecord, isRecord, optNumber, optString, reqString } from "./record.ts";

const HARNESS = "claude-code";

function messageContent(obj: Record<string, unknown>): readonly unknown[] {
  const message = obj.message;
  if (!isRecord(message)) {
    throw new NormalizerDialectError(HARNESS, `${String(obj.type)} frame must carry a "message" object`);
  }
  const content = message.content;
  // Claude also permits a bare-string message content for a plain text turn.
  if (typeof content === "string") return [{ type: "text", text: content }];
  return asArray(HARNESS, content, "message.content");
}

function usageDrafts(usage: unknown, model: string | undefined): DraftEvent[] {
  if (!isRecord(usage)) return [];
  return [
    {
      type: "usage",
      inputTokens: optNumber(HARNESS, usage, "input_tokens") ?? 0,
      outputTokens: optNumber(HARNESS, usage, "output_tokens") ?? 0,
      ...(model !== undefined ? { model } : {}),
    },
  ];
}

function toDrafts(record: unknown): readonly DraftEvent[] {
  const obj = asRecord(HARNESS, record);
  switch (obj.type) {
    case "system":
      // The `init` system frame is session metadata (tools, model, cwd), not a
      // conversational system turn — it carries no canonical text.
      return [];
    case "assistant": {
      const message = isRecord(obj.message) ? obj.message : {};
      const model = optString(HARNESS, message, "model");
      const drafts: DraftEvent[] = [];
      for (const part of messageContent(obj)) {
        if (!isRecord(part)) continue;
        switch (part.type) {
          case "text": {
            const text = optString(HARNESS, part, "text");
            if (text !== undefined && text.length > 0) drafts.push({ type: "assistant", text });
            break;
          }
          case "thinking": {
            const text = optString(HARNESS, part, "thinking");
            const signature = optString(HARNESS, part, "signature");
            drafts.push({
              type: "reasoning",
              ...(text !== undefined ? { text } : {}),
              ...(signature !== undefined ? { providerContinuation: signature } : {}),
            });
            break;
          }
          case "tool_use": {
            const callId = reqString(HARNESS, part, "id");
            drafts.push({
              type: "tool-call",
              id: `call:${callId}`,
              callId,
              name: reqString(HARNESS, part, "name"),
              args: part.input,
            });
            break;
          }
          default:
            break;
        }
      }
      // A turn's usage rides on its assistant message.
      drafts.push(...usageDrafts(message.usage, model));
      return drafts;
    }
    case "user": {
      const drafts: DraftEvent[] = [];
      for (const part of messageContent(obj)) {
        if (!isRecord(part)) continue;
        if (part.type === "tool_result") {
          const callId = reqString(HARNESS, part, "tool_use_id");
          drafts.push({
            type: "tool-result",
            id: `result:${callId}`,
            callId,
            ok: part.is_error !== true,
            result: part.content,
          });
        } else if (part.type === "text") {
          const text = optString(HARNESS, part, "text");
          if (text !== undefined && text.length > 0) drafts.push({ type: "user", text });
        }
      }
      return drafts;
    }
    case "result":
      // Terminal accounting frame: fold its top-level usage in whenever present.
      // Like every other frame's usage (and every other normalizer), this maps to
      // its own canonical `usage` event — assistant frames emit their own
      // per-message usage and the linker never dedupes; consumers aggregate.
      return usageDrafts(obj.usage, optString(HARNESS, obj, "model"));
    default:
      return [];
  }
}

/** The Claude Code fallback normalizer. Streaming + resume-by-id → durable. */
export const claudeNormalizer: HarnessNormalizer = {
  harness: HARNESS,
  capabilities: { streaming: true, resumeById: true },
  toDrafts,
  resume(sessionId: string): ResumeShim {
    return { transport: "cli", sessionId, args: ["--resume", sessionId] };
  },
};
