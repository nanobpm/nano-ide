/**
 * `@nanobpm/agentic/session/acp` — the ACP ingestion backend (ADR 0062, slice 2).
 *
 * The preferred harness-facing backend of the `@nanobpm/agentic/session` contract
 * (ADR 0062 §5): an Agent Client Protocol (protocol v1) client that connects to an
 * ACP-speaking harness (`opencode acp`, `claude-code-acp`, the Gemini lineage),
 * runs the `initialize` handshake to probe `agentCapabilities.loadSession`, and
 * normalises the `session/update` stream into canonical {@link SessionEvent}s —
 * driving via `session/prompt`, steering via `session/cancel`, and **restoring**
 * prior history via `session/load`.
 *
 * Exports, in the order a consumer meets them:
 *  - {@link openAcpSession} / {@link AcpSessionClient} — the ingestion client and
 *    its capability probe / prompt-result types;
 *  - {@link classifyUpdate} + {@link ACP_FIDELITY_GAPS} — the pure wire→canonical
 *    normaliser and the enumerated ADR 0062 §5 fidelity gaps that justify slice 3;
 *  - the {@link AcpConnection} JSON-RPC peer and the {@link AcpTransport} seam,
 *    with {@link spawnAcpTransport} (a real harness subprocess) and
 *    {@link inMemoryTransportPair} (an in-memory peer for tests);
 *  - the ACP wire vocabulary ({@link ACP_METHOD}, guards) from `protocol.ts`.
 */
export {
  AcpSessionClient,
  type AcpCapabilityProbe,
  type AcpPromptInput,
  type AcpPromptResult,
  type AcpSessionClientOptions,
  type AcpSessionParams,
  type AcpTextContentBlock,
  openAcpSession,
  type SessionEventSink,
} from "./client.ts";

export {
  ACP_FIDELITY_GAPS,
  type AcpClassifiedUpdate,
  type AcpFidelityGap,
  classifyUpdate,
} from "./normalize.ts";

export {
  AcpConnection,
  type AcpNotificationHandler,
  type AcpRequestHandler,
  AcpRpcError,
} from "./jsonrpc.ts";

export {
  type AcpTransport,
  encodeMessageLine,
  inMemoryTransportPair,
  NewlineJsonDecoder,
} from "./transport.ts";

export { type SpawnAcpOptions, type SpawnedAcpTransport, spawnAcpTransport } from "./spawn.ts";

export {
  ACP_CLIENT_METHOD,
  ACP_METHOD,
  ACP_PROTOCOL_VERSION,
  type AcpAgentCapabilities,
  type AcpInitializeResult,
  type AcpPromptCapabilities,
  AcpProtocolError,
  contentBlockText,
  parseInitializeResult,
  parseSessionId,
} from "./protocol.ts";
