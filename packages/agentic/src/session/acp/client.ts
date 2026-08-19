/**
 * The ACP ingestion backend — ADR 0062, slice 2 (the preferred adapter target).
 *
 * {@link AcpSessionClient} connects an ACP-speaking harness (reference:
 * `opencode acp`; also Claude via `claude-code-acp`, the Gemini lineage) to a
 * Slice-1 {@link SessionEventSink} — normalising the harness's `session/update`
 * stream into canonical {@link SessionEvent}s and driving/steering the session
 * over JSON-RPC. It realises the three ADR 0062 §5 primitives:
 *
 *  - `session/update` → **emit**: each notification is classified
 *    ({@link classifyUpdate}), streamed message chunks are coalesced into whole
 *    `assistant`/`reasoning`/`user` events, and the `tool_call`/`tool_call_update`
 *    lifecycle becomes canonical `tool-call`/`tool-result` events.
 *  - `session/load` → **restore**: replays the harness's prior history (delivered
 *    as `session/update`s during the load) back into the sink.
 *  - `agentCapabilities.loadSession` (from `initialize`) → the **durable-resume
 *    capability probe** the nano-workforce enrolment gate (slice 5) consumes.
 *
 * This backend owns event **identity** and **causality** (the `id`/`parentId`
 * chain) exactly as `events.ts` prescribes — ACP carries neither — while the sink
 * (a {@link SessionAdapter}) owns ordering and fencing. Keeping those split lets a
 * `SessionBackend` be passed straight in as the sink with no adapter.
 */
import { randomUUID } from "node:crypto";
import type { SessionEvent } from "../events.ts";
import { AcpConnection } from "./jsonrpc.ts";
import { type AcpClassifiedUpdate, classifyUpdate } from "./normalize.ts";
import {
  ACP_CLIENT_METHOD,
  ACP_METHOD,
  ACP_PROTOCOL_VERSION,
  type AcpPromptCapabilities,
  isRecord,
  parseInitializeResult,
  parseSessionId,
} from "./protocol.ts";
import type { AcpTransport } from "./transport.ts";

/**
 * The narrow port the ingestion client writes canonical events to. A Slice-1
 * {@link SessionAdapter} (e.g. a `SessionBackend`) satisfies it structurally, so
 * the ACP stream can feed the authoritative log directly; a test can pass a
 * plain collector.
 */
export interface SessionEventSink {
  emit(event: SessionEvent): void;
}

/** A single ACP content block sent in a prompt. `text` is the baseline shape. */
export interface AcpTextContentBlock {
  readonly type: "text";
  readonly text: string;
}

/** The prompt payload: a content-block array, or a bare string (wrapped as text). */
export type AcpPromptInput = string | readonly AcpTextContentBlock[];

/** The durable-resume capability probe read from the `initialize` handshake. */
export interface AcpCapabilityProbe {
  /** The protocol version the agent negotiated. */
  readonly protocolVersion: number;
  /** The raw `agentCapabilities.loadSession` flag. */
  readonly loadSession: boolean;
  /**
   * The nano-workforce enrolment-gate signal (slice 5): `true` iff the agent can
   * durably resume via `session/load`. Equal to {@link loadSession} — named for
   * the gate that consumes it, so the enrolment site reads intent, not wire detail.
   */
  readonly durableResume: boolean;
  /** The agent's advertised prompt-content capabilities. */
  readonly promptCapabilities: AcpPromptCapabilities;
  /** The full, unmodified `agentCapabilities` object for consumers that need more. */
  readonly agentCapabilities: unknown;
}

/** The result of a completed `session/prompt`, plus the events it produced. */
export interface AcpPromptResult {
  /** The agent's stop reason (`end_turn`, `cancelled`, …) when it reports one. */
  readonly stopReason: string | null;
  /** The canonical events emitted while this prompt ran, in emission order. */
  readonly events: readonly SessionEvent[];
}

/** Parameters shared by `session/new` and `session/load`. */
export interface AcpSessionParams {
  /** The session working directory (absolute path). */
  readonly cwd: string;
  /** MCP servers to attach; defaults to none. */
  readonly mcpServers?: readonly unknown[];
}

export interface AcpSessionClientOptions {
  /** Injectable event-id generator (deterministic tests). Default `crypto.randomUUID`. */
  readonly newEventId?: () => string;
  /** Client name/version reported in `initialize`. */
  readonly clientInfo?: { readonly name: string; readonly version: string };
  /**
   * How to answer an agent's `session/request_permission`. Default: select the
   * first "allow"-flavoured option the agent offers (or a cancel outcome when
   * none is), so a driven session is never silently blocked on approval.
   */
  readonly onPermissionRequest?: (params: unknown) => unknown;
}

interface MessageBuffer {
  readonly role: "assistant" | "reasoning" | "user";
  readonly messageId: string | null;
  readonly text: string;
}

/**
 * The ACP ingestion client. Bind it to a transport and a sink, `initialize`, then
 * either `newSession` + `prompt` (drive) or `restore` an existing session id.
 */
export class AcpSessionClient {
  readonly #connection: AcpConnection;
  readonly #sink: SessionEventSink;
  readonly #newEventId: () => string;
  readonly #clientInfo: { name: string; version: string };
  #lastId: string | null = null;
  #buffer: MessageBuffer | undefined;
  #collector: SessionEvent[] | null = null;
  #sessionId: string | undefined;

  constructor(connection: AcpConnection, sink: SessionEventSink, options: AcpSessionClientOptions = {}) {
    this.#connection = connection;
    this.#sink = sink;
    this.#newEventId = options.newEventId ?? randomUUID;
    this.#clientInfo = options.clientInfo ?? { name: "nano-agentic", version: "0" };
    const permit = options.onPermissionRequest ?? defaultPermissionResponse;
    connection.onNotification(ACP_CLIENT_METHOD.sessionUpdate, (params) => this.#ingest(params));
    connection.onRequest(ACP_CLIENT_METHOD.requestPermission, (params) => permit(params));
  }

  /** The active session id (after `newSession`/`restore`), or `undefined`. */
  get sessionId(): string | undefined {
    return this.#sessionId;
  }

  /**
   * Perform the `initialize` handshake and return the durable-resume capability
   * probe. Must be called before any `session/*` method.
   */
  async initialize(): Promise<AcpCapabilityProbe> {
    const result = await this.#connection.request(ACP_METHOD.initialize, {
      protocolVersion: ACP_PROTOCOL_VERSION,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      clientInfo: this.#clientInfo,
    });
    const parsed = parseInitializeResult(result);
    return {
      protocolVersion: parsed.protocolVersion,
      loadSession: parsed.agentCapabilities.loadSession,
      durableResume: parsed.agentCapabilities.loadSession,
      promptCapabilities: parsed.agentCapabilities.promptCapabilities,
      agentCapabilities: parsed.rawAgentCapabilities,
    };
  }

  /** Open a fresh session (`session/new`); stores and returns its id. */
  async newSession(params: AcpSessionParams): Promise<string> {
    const result = await this.#connection.request(ACP_METHOD.sessionNew, {
      cwd: params.cwd,
      mcpServers: params.mcpServers ?? [],
    });
    this.#sessionId = parseSessionId(result);
    return this.#sessionId;
  }

  /**
   * **restore** — load an existing session (`session/load`). The agent replays its
   * prior history as `session/update` notifications, which this client ingests
   * into the sink; when the load resolves, the pending message is flushed. Returns
   * the canonical events reconstructed from the replayed history, in order.
   *
   * Only valid against an agent whose probe reported `durableResume: true`.
   */
  async restore(sessionId: string, params: AcpSessionParams): Promise<readonly SessionEvent[]> {
    const collected = await this.#collecting(() =>
      this.#connection.request(ACP_METHOD.sessionLoad, {
        sessionId,
        cwd: params.cwd,
        mcpServers: params.mcpServers ?? [],
      }),
    );
    this.#sessionId = sessionId;
    return collected.events;
  }

  /**
   * **drive** — send a prompt (`session/prompt`) and resolve when the turn ends.
   * All assistant output arrives as `session/update` notifications and is emitted
   * to the sink during the call; the final buffered message is flushed on
   * completion.
   */
  async prompt(input: AcpPromptInput): Promise<AcpPromptResult> {
    if (this.#sessionId === undefined) {
      throw new Error("prompt requires an active session — call newSession() or restore() first");
    }
    const prompt = typeof input === "string" ? [{ type: "text", text: input }] : input;
    const collected = await this.#collecting(() =>
      this.#connection.request(ACP_METHOD.sessionPrompt, { sessionId: this.#sessionId, prompt }),
    );
    return { stopReason: readStopReason(collected.result), events: collected.events };
  }

  /** **steer** — request cancellation of the running turn (`session/cancel`, a notification). */
  cancel(): void {
    if (this.#sessionId === undefined) return;
    this.#connection.notify(ACP_METHOD.sessionCancel, { sessionId: this.#sessionId });
  }

  /** Close the underlying connection and flush any pending buffered message. */
  close(): void {
    this.#flushMessage();
    this.#connection.close();
  }

  async #collecting(op: () => Promise<unknown>): Promise<{ result: unknown; events: SessionEvent[] }> {
    const events: SessionEvent[] = [];
    const previous = this.#collector;
    this.#collector = events;
    try {
      const result = await op();
      // Every session/update queued before the response has been ingested by now
      // (ordered transport delivery); flush the final in-flight message.
      this.#flushMessage();
      return { result, events };
    } finally {
      this.#collector = previous;
    }
  }

  #ingest(params: unknown): void {
    if (!isRecord(params)) return;
    const update = classifyUpdate(params.update);
    switch (update.kind) {
      case "message":
        this.#appendMessage(update);
        return;
      case "tool-call": {
        this.#flushMessage();
        const { id, parentId } = this.#nextIdentity();
        this.#push({ type: "tool-call", id, parentId, callId: update.callId, name: update.name, args: update.args });
        return;
      }
      case "tool-result": {
        this.#flushMessage();
        const { id, parentId } = this.#nextIdentity();
        this.#push({ type: "tool-result", id, parentId, callId: update.callId, ok: update.ok, result: update.result });
        return;
      }
      case "ignored":
        return;
    }
  }

  #appendMessage(update: Extract<AcpClassifiedUpdate, { kind: "message" }>): void {
    const buffer = this.#buffer;
    if (buffer !== undefined && buffer.role === update.role && sameMessage(buffer.messageId, update.messageId)) {
      this.#buffer = { role: buffer.role, messageId: buffer.messageId, text: buffer.text + update.text };
      return;
    }
    this.#flushMessage();
    this.#buffer = { role: update.role, messageId: update.messageId, text: update.text };
  }

  #flushMessage(): void {
    const buffer = this.#buffer;
    if (buffer === undefined) return;
    this.#buffer = undefined;
    const { id, parentId } = this.#nextIdentity();
    switch (buffer.role) {
      case "assistant":
        this.#push({ type: "assistant", id, parentId, text: buffer.text });
        return;
      case "reasoning":
        this.#push({ type: "reasoning", id, parentId, text: buffer.text });
        return;
      case "user":
        this.#push({ type: "user", id, parentId, text: buffer.text });
        return;
    }
  }

  #nextIdentity(): { id: string; parentId: string | null } {
    const id = this.#newEventId();
    const parentId = this.#lastId;
    this.#lastId = id;
    return { id, parentId };
  }

  #push(event: SessionEvent): void {
    this.#sink.emit(event);
    this.#collector?.push(event);
  }
}

/**
 * Two message chunks belong to the same logical message when their `messageId`s
 * are equal, or when neither carries one (the agent omitted it) — in which case
 * consecutive same-role chunks coalesce until a role change or a tool boundary.
 */
function sameMessage(a: string | null, b: string | null): boolean {
  if (a === null && b === null) return true;
  return a === b;
}

function readStopReason(result: unknown): string | null {
  if (isRecord(result) && typeof result.stopReason === "string") return result.stopReason;
  return null;
}

/**
 * Select the first option whose kind reads as an approval from a
 * `session/request_permission` request, so a driven session proceeds without a
 * human in the loop; cancel when the agent offers no allow option. Full
 * interactive-permission and client-side `fs`/`terminal` support is out of this
 * slice's scope (this backend advertises neither capability at `initialize`).
 */
function defaultPermissionResponse(params: unknown): unknown {
  if (isRecord(params) && Array.isArray(params.options)) {
    for (const option of params.options) {
      if (!isRecord(option)) continue;
      const kind = option.kind;
      if (typeof kind === "string" && kind.startsWith("allow") && typeof option.optionId === "string") {
        return { outcome: { outcome: "selected", optionId: option.optionId } };
      }
    }
    const first = params.options[0];
    if (isRecord(first) && typeof first.optionId === "string") {
      return { outcome: { outcome: "selected", optionId: first.optionId } };
    }
  }
  return { outcome: { outcome: "cancelled" } };
}

/**
 * Open an ACP ingestion client over `transport`, emitting into `sink`. Wraps the
 * transport in an {@link AcpConnection} and returns the ready client; call
 * {@link AcpSessionClient.initialize} first.
 */
export function openAcpSession(
  transport: AcpTransport,
  sink: SessionEventSink,
  options: AcpSessionClientOptions = {},
): AcpSessionClient {
  return new AcpSessionClient(new AcpConnection(transport), sink, options);
}
