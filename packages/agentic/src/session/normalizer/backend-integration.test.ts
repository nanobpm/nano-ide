import assert from "node:assert/strict";
import { test } from "node:test";
import type { ActivationKey } from "../adapter.ts";
import { SessionBackend } from "../backend.ts";
import { InMemorySessionLog } from "../log.ts";
import { claudeNormalizer } from "./claude.ts";
import { copilotNormalizer } from "./copilot.ts";
import { normalizeSession } from "./link.ts";

const KEY: ActivationKey = { processInstanceKey: "pik-1", elementId: "implement-task" };

function seqIds(prefix: string): () => string {
  let n = 0;
  return () => `${prefix}-${n++}`;
}

/**
 * ADR 0062 slice-3 acceptance, end to end for a reference dialect: a driven
 * SDK/`-p` session emits normalized {@link SessionEvent}s into the slice-1
 * authoritative log; the harness's native restore hands the mind back to a fresh
 * incarnation, which continues the same session.
 */
test("[@github/copilot] driven session emits normalized events, native resume restores, agent continues", () => {
  // A driven copilot-sdk session's mind stream.
  const firstLeg = normalizeSession(
    copilotNormalizer,
    [
      { type: "user_message", text: "refactor the parser" },
      { type: "reasoning", text: "planning", reasoningOpaque: "CONT-1" },
      { type: "assistant_message", text: "starting" },
      { type: "tool_call", id: "t1", name: "write_file", arguments: { path: "a.ts" } },
      { type: "tool_result", id: "t1", output: "written" },
    ],
    { newId: seqIds("a") },
  );

  // Incarnation 1 taps the normalized mind into the authoritative log.
  const log = new InMemorySessionLog();
  const b1 = new SessionBackend(log, KEY, 1, { newCheckpointId: seqIds("cp") });
  for (const ev of firstLeg) b1.emit(ev);
  const cp = b1.checkpoint("sha-1", []);
  assert.equal(cp.offset, firstLeg.length);

  // The harness's native restore invocation is resolved by the resume shim
  // (copilot-sdk `resumeSession(id)`), and a fresh incarnation replays the seed.
  const shim = copilotNormalizer.resume("copilot-session-xyz");
  assert.deepEqual(shim, { transport: "sdk", sessionId: "copilot-session-xyz", call: "resumeSession", args: ["copilot-session-xyz"] });

  const b2 = new SessionBackend(log, KEY, 2, { newCheckpointId: seqIds("cp2") });
  const seed = b2.restore();
  assert.equal(seed.nextOffset, firstLeg.length, "the seed resumes at the checkpoint offset");
  assert.deepEqual(
    seed.events.map((e) => ({ id: e.id, type: e.type })),
    firstLeg.map((e) => ({ id: e.id, type: e.type })),
    "the restored seed is exactly the normalized first-leg mind",
  );
  // The resume-critical reasoning continuation survived the round trip.
  const reasoning = seed.events.find((e) => e.type === "reasoning");
  assert.ok(reasoning && reasoning.type === "reasoning" && reasoning.providerContinuation === "CONT-1");

  // The resumed agent continues: its new mind is threaded onto the last restored
  // event and appended after the checkpoint offset — one causal session.
  const lastId = seed.events[seed.events.length - 1].id;
  const secondLeg = normalizeSession(
    copilotNormalizer,
    [{ type: "assistant_message", text: "continuing after resume" }],
    { parentId: lastId, newId: seqIds("b") },
  );
  const appended = secondLeg.map((e) => b2.emit(e));
  assert.equal(appended[0].offset, firstLeg.length, "continues appending after the checkpoint");
  assert.equal(appended[0].incarnation, 2, "the continuation is stamped with the new incarnation");
  assert.equal(appended[0].parentId, lastId, "the continuation extends the pre-resume causal chain");
});

test("[claude-code] a driven -p stream-json session restores and continues via --resume", () => {
  const firstLeg = normalizeSession(
    claudeNormalizer,
    [
      { type: "user", message: { content: [{ type: "text", text: "add a test" }] } },
      {
        type: "assistant",
        message: {
          content: [
            { type: "thinking", thinking: "reason", signature: "SIG" },
            { type: "text", text: "on it" },
          ],
        },
      },
    ],
    { newId: seqIds("c") },
  );
  const log = new InMemorySessionLog();
  const b1 = new SessionBackend(log, KEY, 1, { newCheckpointId: seqIds("cp") });
  for (const ev of firstLeg) b1.emit(ev);
  b1.checkpoint("sha", []);

  assert.deepEqual(claudeNormalizer.resume("sess-1"), { transport: "cli", sessionId: "sess-1", args: ["--resume", "sess-1"] });

  const b2 = new SessionBackend(log, KEY, 2, { newCheckpointId: seqIds("cp2") });
  const seed = b2.restore();
  assert.equal(seed.events.length, firstLeg.length);
  assert.equal(seed.nextOffset, firstLeg.length);
});
