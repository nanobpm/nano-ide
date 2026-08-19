/**
 * The ACP transport seam — ADR 0062, slice 2.
 *
 * ACP frames JSON-RPC 2.0 as **newline-delimited JSON over stdio** (one complete
 * message per line, UTF-8, no `Content-Length` headers — that is LSP/MCP framing,
 * not ACP). {@link AcpConnection} speaks only to this narrow {@link AcpTransport}
 * port, so the JSON-RPC peer never knows whether it is wired to a spawned
 * `opencode acp` subprocess ({@link ./spawn.ts}) or, in a test, to an in-memory
 * fake agent ({@link inMemoryTransportPair}). Transport is a seam, never
 * re-implemented per backend (AGENTS.md: no drift surfaces).
 */

/**
 * A bidirectional stream of already-parsed JSON-RPC messages. Implementations own
 * the newline framing and `JSON.parse`/`stringify` at the byte boundary; the peer
 * above works purely in terms of JSON values.
 */
export interface AcpTransport {
  /** Serialise and write one JSON-RPC message toward the peer. */
  send(message: unknown): void;
  /**
   * Register the handler for inbound messages. Called once by the connection on
   * construction. A malformed line is surfaced via {@link onError} rather than
   * delivered here.
   */
  onMessage(handler: (message: unknown) => void): void;
  /** Register a handler for transport-level errors (e.g. an unparseable line). */
  onError(handler: (error: Error) => void): void;
  /** Close the transport and release its underlying resource. Idempotent. */
  close(): void;
}

/**
 * Split a byte stream into complete newline-delimited JSON messages. Handles
 * chunk boundaries that fall mid-line (buffering the remainder) and ignores
 * blank lines. Each decoded value is handed to `onMessage`; a line that fails to
 * parse goes to `onError` and does not abort the stream.
 */
export class NewlineJsonDecoder {
  #buffer = "";
  readonly #onMessage: (message: unknown) => void;
  readonly #onError: (error: Error) => void;

  constructor(onMessage: (message: unknown) => void, onError: (error: Error) => void) {
    this.#onMessage = onMessage;
    this.#onError = onError;
  }

  /** Feed a decoded string chunk; emits every complete line it now contains. */
  push(chunk: string): void {
    this.#buffer += chunk;
    let newlineIndex = this.#buffer.indexOf("\n");
    while (newlineIndex !== -1) {
      const line = this.#buffer.slice(0, newlineIndex).trim();
      this.#buffer = this.#buffer.slice(newlineIndex + 1);
      if (line.length > 0) this.#deliver(line);
      newlineIndex = this.#buffer.indexOf("\n");
    }
  }

  #deliver(line: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (cause) {
      this.#onError(new Error(`ACP transport received a non-JSON line: ${line.slice(0, 200)}`, { cause }));
      return;
    }
    this.#onMessage(parsed);
  }
}

/** Serialise a JSON-RPC message as a single ACP wire line (JSON + `\n`). */
export function encodeMessageLine(message: unknown): string {
  return `${JSON.stringify(message)}\n`;
}

/**
 * A pair of transports wired directly to each other in memory: what one `send`s
 * the other receives (after a `queueMicrotask` hop, so delivery is asynchronous
 * like a real pipe and never re-enters the sender synchronously). The reference
 * substrate for driving a fake agent in tests without spawning a process.
 */
export function inMemoryTransportPair(): { client: AcpTransport; agent: AcpTransport } {
  const client = new InMemoryTransport();
  const agent = new InMemoryTransport();
  client.connect(agent);
  agent.connect(client);
  return { client, agent };
}

class InMemoryTransport implements AcpTransport {
  #peer: InMemoryTransport | undefined;
  #onMessage: ((message: unknown) => void) | undefined;
  #onError: ((error: Error) => void) | undefined;
  #closed = false;

  connect(peer: InMemoryTransport): void {
    this.#peer = peer;
  }

  send(message: unknown): void {
    if (this.#closed) return;
    // Round-trip through the wire encoding so an in-memory test exercises the same
    // JSON serialisation a real pipe would.
    const line = encodeMessageLine(message);
    const peer = this.#peer;
    queueMicrotask(() => peer?.receive(line));
  }

  receive(line: string): void {
    if (this.#closed) return;
    const handler = this.#onMessage;
    if (handler === undefined) return;
    const onError =
      this.#onError ??
      ((error: Error) => {
        throw error;
      });
    const decoder = new NewlineJsonDecoder(handler, onError);
    decoder.push(line);
  }

  onMessage(handler: (message: unknown) => void): void {
    this.#onMessage = handler;
  }

  onError(handler: (error: Error) => void): void {
    this.#onError = handler;
  }

  close(): void {
    this.#closed = true;
  }
}
