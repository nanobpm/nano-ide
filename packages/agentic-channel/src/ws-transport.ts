/**
 * The production WebSocket transport for the agentic hub.
 *
 * A thin adapter over the `ws` server that binds the app's OWN port (or attaches
 * to an existing app HTTP server so it shares that port), captures the ADR 0028
 * identity token + capability credential from the upgrade request, and hands the
 * hub a transport-agnostic {@link ChannelConnection} per peer. The Camunda-8
 * engine transport is a separate connection and is never touched here.
 */
import { randomUUID } from "node:crypto";
import type { IncomingMessage, Server as HttpServer } from "node:http";
import { WebSocketServer } from "ws";
import type { RawData, WebSocket } from "ws";
import type { ChannelConnection, ChannelTransport, CloseCode, HandshakeRequest } from "./connection.ts";

export interface WebSocketChannelTransportOptions {
  /** Port to bind (the app's own port). Use 0 for an ephemeral port. Ignored if `server` is set. */
  port?: number;
  /** Host/interface to bind. Ignored if `server` is set. */
  host?: string;
  /** Path the channel is served on. Default `/agentic`. */
  path?: string;
  /** Attach to an existing app HTTP server (share the app's port) instead of binding a new one. */
  server?: HttpServer;
}

const DEFAULT_PATH = "/agentic";

/** Normalise Node's header map to a flat, lower-cased string record. */
function flattenHeaders(req: IncomingMessage): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(req.headers)) {
    const name = key.toLowerCase();
    if (typeof value === "string") {
      headers[name] = value;
    } else if (Array.isArray(value)) {
      headers[name] = value.join(", ");
    }
  }
  return headers;
}

/** Parse the upgrade request into the handshake the authenticator reads. */
function handshakeFrom(req: IncomingMessage): HandshakeRequest {
  const url = new URL(req.url ?? "/", "http://localhost");
  const query: Record<string, string> = {};
  for (const [key, value] of url.searchParams) {
    query[key] = value;
  }
  const headers = flattenHeaders(req);
  return {
    token: query.token,
    credential: query.capability ?? headers["x-capability-credential"],
    remote: req.socket.remoteAddress ?? undefined,
    headers,
    query,
  };
}

/** Coerce `ws` RawData into a single contiguous byte view for the codec. */
function toBytes(data: RawData): Uint8Array {
  if (Array.isArray(data)) {
    return Buffer.concat(data);
  }
  if (data instanceof ArrayBuffer) {
    return new Uint8Array(data);
  }
  return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
}

/** One `ws` socket wrapped as a {@link ChannelConnection}. */
class WsConnection implements ChannelConnection {
  readonly id: string;
  readonly handshake: HandshakeRequest;
  readonly #ws: WebSocket;

  constructor(id: string, ws: WebSocket, handshake: HandshakeRequest) {
    this.id = id;
    this.#ws = ws;
    this.handshake = handshake;
  }

  send(bytes: Uint8Array): void {
    if (this.#ws.readyState === this.#ws.OPEN) {
      this.#ws.send(bytes, { binary: true });
    }
  }

  close(code?: CloseCode, reason?: string): void {
    if (code === undefined) {
      this.#ws.close();
    } else {
      this.#ws.close(code, reason);
    }
  }

  onMessage(listener: (bytes: Uint8Array) => void): void {
    this.#ws.on("message", (data: RawData) => listener(toBytes(data)));
  }

  onClose(listener: (code?: CloseCode, reason?: string) => void): void {
    this.#ws.on("close", (code: number, reason: Buffer) => listener(code, reason.toString()));
  }

  onPong(listener: () => void): void {
    this.#ws.on("pong", () => listener());
  }

  onPing(listener: () => void): void {
    this.#ws.on("ping", () => listener());
  }

  ping(): void {
    if (this.#ws.readyState === this.#ws.OPEN) {
      this.#ws.ping();
    }
  }
}

export class WebSocketChannelTransport implements ChannelTransport {
  readonly #wss: WebSocketServer;
  #listener: ((conn: ChannelConnection) => void) | undefined;

  constructor(options: WebSocketChannelTransportOptions = {}) {
    const path = options.path ?? DEFAULT_PATH;
    this.#wss = options.server
      ? new WebSocketServer({ server: options.server, path })
      : new WebSocketServer({ port: options.port ?? 0, host: options.host, path });

    this.#wss.on("connection", (ws: WebSocket, req: IncomingMessage) => {
      const conn = new WsConnection(randomUUID(), ws, handshakeFrom(req));
      this.#listener?.(conn);
    });
  }

  onConnection(listener: (conn: ChannelConnection) => void): void {
    this.#listener = listener;
  }

  /** Resolve once the server is listening on its port. */
  ready(): Promise<void> {
    if (this.#wss.address() !== null) {
      return Promise.resolve();
    }
    return new Promise((resolve, reject) => {
      const onListening = () => {
        this.#wss.off("error", onError);
        resolve();
      };
      const onError = (err: Error) => {
        this.#wss.off("listening", onListening);
        reject(err);
      };
      this.#wss.once("listening", onListening);
      this.#wss.once("error", onError);
    });
  }

  get address(): { readonly port: number } | null {
    const addr = this.#wss.address();
    if (addr !== null && typeof addr === "object" && "port" in addr) {
      return { port: addr.port };
    }
    return null;
  }

  close(): Promise<void> {
    return new Promise((resolve, reject) => {
      for (const client of this.#wss.clients) {
        client.terminate();
      }
      this.#wss.close((err) => (err ? reject(err) : resolve()));
    });
  }
}
