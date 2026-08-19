/**
 * A minimal JSON-RPC 2.0 peer for ACP — ADR 0062, slice 2.
 *
 * ACP is symmetric: the client sends requests/notifications to the agent
 * (`initialize`, `session/*`) and the agent sends requests/notifications back to
 * the client (`session/update`, `session/request_permission`). {@link AcpConnection}
 * is the bidirectional peer over an {@link AcpTransport}: it correlates responses
 * to outbound requests by id, dispatches inbound notifications and requests to
 * registered handlers, and answers an unhandled inbound request with a
 * JSON-RPC "method not found" instead of hanging the agent.
 *
 * It is intentionally tiny and dependency-free — the repo has no JSON-RPC library
 * and this is the only surface that needs one, so a focused peer beats pulling a
 * general framework (and avoids a drift surface).
 */
import { isRecord } from "./protocol.ts";
import type { AcpTransport } from "./transport.ts";

/** A handler for an inbound agent→client request; its resolved value is the result. */
export type AcpRequestHandler = (params: unknown) => unknown | Promise<unknown>;

/** A handler for an inbound agent→client notification (no response). */
export type AcpNotificationHandler = (params: unknown) => void;

/** A JSON-RPC error returned by, or raised toward, the peer. */
export class AcpRpcError extends Error {
  readonly code: number;
  readonly data: unknown;
  constructor(code: number, message: string, data?: unknown) {
    super(message);
    this.name = "AcpRpcError";
    this.code = code;
    this.data = data;
  }
}

const METHOD_NOT_FOUND = -32601;
const INTERNAL_ERROR = -32603;

interface Pending {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
}

export class AcpConnection {
  readonly #transport: AcpTransport;
  readonly #pending = new Map<number, Pending>();
  readonly #notificationHandlers = new Map<string, AcpNotificationHandler>();
  readonly #requestHandlers = new Map<string, AcpRequestHandler>();
  #nextId = 1;
  #closed = false;

  constructor(transport: AcpTransport) {
    this.#transport = transport;
    transport.onMessage((message) => this.#dispatch(message));
    transport.onError((error) => this.#failAll(error));
  }

  /** Send a request and resolve with its `result` (or reject with its `error`). */
  request(method: string, params?: unknown): Promise<unknown> {
    if (this.#closed) {
      return Promise.reject(new Error(`ACP connection is closed; cannot call ${method}`));
    }
    const id = this.#nextId++;
    return new Promise<unknown>((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      this.#transport.send({ jsonrpc: "2.0", id, method, params });
    });
  }

  /** Send a fire-and-forget notification (no id, no response). */
  notify(method: string, params?: unknown): void {
    if (this.#closed) return;
    this.#transport.send({ jsonrpc: "2.0", method, params });
  }

  /** Register the handler for an inbound notification `method` (last wins). */
  onNotification(method: string, handler: AcpNotificationHandler): void {
    this.#notificationHandlers.set(method, handler);
  }

  /** Register the handler for an inbound request `method` (last wins). */
  onRequest(method: string, handler: AcpRequestHandler): void {
    this.#requestHandlers.set(method, handler);
  }

  /** Close the connection, rejecting every in-flight request. */
  close(): void {
    if (this.#closed) return;
    this.#failAll(new Error("ACP connection closed"));
    this.#closed = true;
    this.#transport.close();
  }

  #dispatch(message: unknown): void {
    if (!isRecord(message)) return;
    const hasId = "id" in message && (typeof message.id === "number" || typeof message.id === "string");
    const isResponse = hasId && ("result" in message || "error" in message);
    if (isResponse) {
      this.#handleResponse(message);
      return;
    }
    if (typeof message.method === "string") {
      if (hasId) {
        this.#handleInboundRequest(message.method, message.id, message.params);
      } else {
        this.#handleInboundNotification(message.method, message.params);
      }
    }
  }

  #handleResponse(message: Record<string, unknown>): void {
    const id = message.id;
    if (typeof id !== "number") return; // we only ever issue numeric ids
    const pending = this.#pending.get(id);
    if (pending === undefined) return;
    this.#pending.delete(id);
    if ("error" in message && message.error !== undefined && message.error !== null) {
      pending.reject(toRpcError(message.error));
      return;
    }
    pending.resolve("result" in message ? message.result : undefined);
  }

  #handleInboundNotification(method: string, params: unknown): void {
    const handler = this.#notificationHandlers.get(method);
    if (handler !== undefined) handler(params);
  }

  #handleInboundRequest(method: string, id: unknown, params: unknown): void {
    const handler = this.#requestHandlers.get(method);
    if (handler === undefined) {
      this.#transport.send({
        jsonrpc: "2.0",
        id,
        error: { code: METHOD_NOT_FOUND, message: `method not found: ${method}` },
      });
      return;
    }
    Promise.resolve()
      .then(() => handler(params))
      .then(
        (result) => this.#transport.send({ jsonrpc: "2.0", id, result: result ?? null }),
        (reason: unknown) => this.#transport.send({ jsonrpc: "2.0", id, error: errorPayload(reason) }),
      );
  }

  #failAll(error: Error): void {
    for (const pending of this.#pending.values()) pending.reject(error);
    this.#pending.clear();
  }
}

function toRpcError(error: unknown): AcpRpcError {
  if (isRecord(error)) {
    const code = typeof error.code === "number" ? error.code : INTERNAL_ERROR;
    const message = typeof error.message === "string" ? error.message : "ACP request failed";
    return new AcpRpcError(code, message, error.data);
  }
  return new AcpRpcError(INTERNAL_ERROR, "ACP request failed with a non-object error");
}

function errorPayload(reason: unknown): { code: number; message: string; data?: unknown } {
  if (reason instanceof AcpRpcError) {
    return { code: reason.code, message: reason.message, data: reason.data };
  }
  if (reason instanceof Error) {
    return { code: INTERNAL_ERROR, message: reason.message };
  }
  return { code: INTERNAL_ERROR, message: String(reason) };
}
