/**
 * `@github/copilot` normalizer — ADR 0062 slice 3, reference dialect A.
 *
 * Copilot runs in-process through `copilot-sdk`: the mind source is its own
 * `SessionEvent` stream (`session.on(...)`, or the `events.jsonl` transcript it
 * writes), and restore is the SDK's `resumeSession(id)` (the `sessionFsProvider`
 * seam is the same call under a different persistence root, so the resume shim is
 * identical). Copilot both streams and resumes-by-id → it advertises
 * `durable-resume`.
 *
 * ## Resume-critical fidelity: `reasoningOpaque`
 *
 * ADR 0062 §5 lets a native adapter *prefer the native transcript for restore*
 * when it carries more than the ACP models. Copilot's reasoning events carry a
 * `reasoningOpaque` blob — the provider reasoning-continuation handle that must
 * be replayed verbatim to continue the model's reasoning across a resume. The
 * canonical `ReasoningEvent` has a home for exactly this (`providerContinuation`),
 * so we map it straight through, untouched. Dropping it (as a lossy ACP
 * projection might) would silently break reasoning continuation on resume — so
 * this dialect is the authoritative ingestion path for Copilot.
 */
import type { DraftEvent, HarnessNormalizer, ResumeShim } from "./types.ts";
import { asRecord, contentText, optNumber, optString, reqString } from "./record.ts";

const HARNESS = "@github/copilot";

/**
 * Map one `copilot-sdk` `SessionEvent` to canonical drafts. Copilot's event
 * `type`s are close to ours but not identical (`assistant_message` vs
 * `assistant`, `reasoningOpaque` vs `providerContinuation`, `turn_started` vs
 * `turn-start`); this is exactly the per-dialect translation the slice exists to
 * own.
 */
function toDrafts(record: unknown): readonly DraftEvent[] {
  const obj = asRecord(HARNESS, record);
  switch (obj.type) {
    case "system":
    case "system_message":
      return [{ type: "system", text: reqString(HARNESS, obj, "text") }];
    case "user":
    case "user_message":
      return [{ type: "user", text: reqString(HARNESS, obj, "text") }];
    case "assistant":
    case "assistant_message": {
      const text = contentText(obj.text ?? obj.content);
      return text === undefined ? [] : [{ type: "assistant", text }];
    }
    case "reasoning": {
      const text = optString(HARNESS, obj, "text");
      // Copilot names the continuation blob `reasoningOpaque`; accept the
      // canonical spelling too so a pre-normalized feed round-trips.
      const providerContinuation =
        optString(HARNESS, obj, "reasoningOpaque") ?? optString(HARNESS, obj, "providerContinuation");
      return [
        {
          type: "reasoning",
          ...(text !== undefined ? { text } : {}),
          ...(providerContinuation !== undefined ? { providerContinuation } : {}),
        },
      ];
    }
    case "tool_call": {
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
      // Copilot marks failure with an `isError` flag; the payload lives in
      // `output` either way.
      const ok = obj.isError === true ? false : obj.error == null;
      return [
        {
          type: "tool-result",
          id: `result:${callId}`,
          callId,
          ok,
          result: obj.output ?? obj.result ?? obj.error,
        },
      ];
    }
    case "turn_started":
      return [{ type: "turn-start", turn: turnIndex(obj) }];
    case "turn_completed":
    case "turn_ended":
      return [{ type: "turn-end", turn: turnIndex(obj) }];
    case "usage": {
      const model = optString(HARNESS, obj, "model");
      return [
        {
          type: "usage",
          inputTokens: usageCount(obj, "inputTokens", "input_tokens"),
          outputTokens: usageCount(obj, "outputTokens", "output_tokens"),
          ...(model !== undefined ? { model } : {}),
        },
      ];
    }
    default:
      // Transport frames Copilot emits that carry no session-log meaning
      // (heartbeats, session-ready acks) normalize to nothing.
      return [];
  }
}

function turnIndex(obj: Record<string, unknown>): number {
  return optNumber(HARNESS, obj, "turn") ?? 0;
}

function usageCount(obj: Record<string, unknown>, camel: string, snake: string): number {
  return optNumber(HARNESS, obj, camel) ?? optNumber(HARNESS, obj, snake) ?? 0;
}

/**
 * The `@github/copilot` fallback normalizer. `streaming`/`resumeById` are both
 * true, so {@link capabilityProbe} derives `durable-resume: true`.
 */
export const copilotNormalizer: HarnessNormalizer = {
  harness: HARNESS,
  capabilities: { streaming: true, resumeById: true },
  toDrafts,
  resume(sessionId: string): ResumeShim {
    // In-process SDK restore: `resumeSession(id)` (the sessionFsProvider seam is
    // the same call under a different persistence root).
    return { transport: "sdk", sessionId, call: "resumeSession", args: [sessionId] };
  },
};
