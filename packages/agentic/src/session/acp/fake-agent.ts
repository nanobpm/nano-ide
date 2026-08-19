/**
 * A scriptable in-memory fake ACP agent — test-only (excluded from the build,
 * like `../test-db.ts`). It plays the *agent* side of the ACP peer over an
 * {@link AcpTransport} so the client's `initialize`/`session/*` flow and the
 * `session/update` → canonical `SessionEvent` normalisation can be exercised
 * end-to-end without spawning a real `opencode acp` process.
 *
 * It reuses the production {@link AcpConnection} for its own peer, so the tests
 * drive the exact JSON-RPC wire the real harness would.
 */
import { AcpConnection } from "./jsonrpc.ts";
import { isRecord } from "./protocol.ts";
import type { AcpTransport } from "./transport.ts";

export interface FakeAcpAgentScript {
  /** Advertised `agentCapabilities.loadSession` (the durable-resume probe). Default `false`. */
  readonly loadSession?: boolean;
  /** The protocol version the agent negotiates. Default `1`. */
  readonly protocolVersion?: number;
  /** `update` objects the agent streams (as `session/update`) while a prompt runs. */
  readonly promptUpdates?: readonly unknown[];
  /** The `stopReason` the `session/prompt` resolves with. Default `"end_turn"`. */
  readonly promptStopReason?: string;
  /** `update` objects the agent replays (as `session/update`) during `session/load`. */
  readonly loadUpdates?: readonly unknown[];
  /** The session id `session/new` hands out. Default `"sess-fake"`. */
  readonly sessionId?: string;
}

function sessionIdOf(params: unknown, fallback: string): string {
  if (isRecord(params) && typeof params.sessionId === "string") {
    return params.sessionId;
  }
  return fallback;
}

/** Wire a fake agent onto `transport` and return its connection (for `close()`). */
export function startFakeAcpAgent(transport: AcpTransport, script: FakeAcpAgentScript = {}): AcpConnection {
  const connection = new AcpConnection(transport);
  const sessionId = script.sessionId ?? "sess-fake";
  const loadSession = script.loadSession ?? false;

  connection.onRequest("initialize", () => ({
    protocolVersion: script.protocolVersion ?? 1,
    agentCapabilities: {
      loadSession,
      promptCapabilities: { image: false, audio: false, embeddedContext: false },
    },
    authMethods: [],
  }));

  connection.onRequest("session/new", () => ({ sessionId }));

  connection.onRequest("session/load", (params) => {
    const sid = sessionIdOf(params, sessionId);
    for (const update of script.loadUpdates ?? []) {
      connection.notify("session/update", { sessionId: sid, update });
    }
    return { modes: null, configOptions: null };
  });

  connection.onRequest("session/prompt", (params) => {
    const sid = sessionIdOf(params, sessionId);
    for (const update of script.promptUpdates ?? []) {
      connection.notify("session/update", { sessionId: sid, update });
    }
    return { stopReason: script.promptStopReason ?? "end_turn" };
  });

  return connection;
}
