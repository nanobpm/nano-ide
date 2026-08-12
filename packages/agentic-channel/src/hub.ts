/**
 * The app-tier agentic hub.
 *
 * Stands up over a {@link ChannelTransport} bound to the app's OWN port (the
 * Camunda-8 engine transport is a separate connection and untouched). For each
 * accepted connection it:
 *   1. authenticates the handshake (ADR 0028 identity + capability credential),
 *   2. tracks it in the {@link ConnectionRegistry} with liveness,
 *   3. decodes inbound frames with the S0 codec and routes each to its family
 *      handler via the {@link FamilyRouter} registration seam — never a switch,
 *   4. ages out connections that stop sending (TTL sweep).
 *
 * Family behaviour (presence, relay, blackboard, …) is NOT baked in here: each
 * wave-2 slice attaches its family as its own module through
 * {@link AgenticHub.registerFamilyHandler}.
 */
import { decodeFrame, encodeFrame, FrameDecodeError } from "@nanobpm/agentic-protocol";
import type { Frame } from "@nanobpm/agentic-protocol";
import type { Authenticator } from "./auth.ts";
import { systemClock } from "./clock.ts";
import type { Clock } from "./clock.ts";
import type { ChannelConnection, ChannelTransport, CloseCode, HandshakeRequest } from "./connection.ts";
import { FamilyRouter } from "./dispatch.ts";
import type { FamilyHandler } from "./dispatch.ts";
import { ConnectionRegistry } from "./registry.ts";

/** Application close code used when a connection ages out on the liveness TTL. */
export const LIVENESS_TIMEOUT = 4408;

/**
 * The per-connection context threaded to every family handler. A handler
 * (S2/S5/S7) uses it to reply on the same connection and to attach presence in
 * the shared {@link ConnectionRegistry}.
 */
export interface HubConnection {
  /** The connection id. */
  readonly id: string;
  /** The authenticated principal (ADR 0028 identity). */
  readonly identity: string;
  /** What the transport captured at connect time. */
  readonly handshake: HandshakeRequest;
  /** The shared registry — handlers attach presence via `registry.setPresence(id, …)`. */
  readonly registry: ConnectionRegistry;
  /** Encode and send one frame back on this connection. */
  send(frame: Frame): void;
  /** Close this connection. */
  close(code?: CloseCode, reason?: string): void;
}

export interface AgenticHubOptions {
  /** The listening transport bound to the app's own port. */
  transport: ChannelTransport;
  /** How connections authenticate. */
  authenticator: Authenticator;
  /** A pre-populated router, or omit to let the hub create an empty one. */
  router?: FamilyRouter<HubConnection>;
  /** A shared registry, or omit to let the hub create one. */
  registry?: ConnectionRegistry;
  /** Injectable clock (deterministic tests). Default {@link systemClock}. */
  clock?: Clock;
  /**
   * How often to sweep for aged-out connections, in ms. Default: a third of the
   * registry TTL. Pass 0 to disable the internal timer (tests call
   * {@link AgenticHub.sweepNow} explicitly).
   */
  sweepIntervalMs?: number;
  /** Notified of a decode/handler error; the offending connection is kept. */
  onError?: (err: unknown, connectionId?: string) => void;
}

export class AgenticHub {
  readonly router: FamilyRouter<HubConnection>;
  readonly registry: ConnectionRegistry;
  readonly #transport: ChannelTransport;
  readonly #authenticator: Authenticator;
  readonly #clock: Clock;
  readonly #onError: (err: unknown, connectionId?: string) => void;
  readonly #conns = new Map<string, ChannelConnection>();
  #sweepTimer: ReturnType<typeof setInterval> | undefined;

  constructor(options: AgenticHubOptions) {
    this.#transport = options.transport;
    this.#authenticator = options.authenticator;
    this.router = options.router ?? new FamilyRouter<HubConnection>();
    this.registry = options.registry ?? new ConnectionRegistry({ clock: options.clock });
    this.#clock = options.clock ?? systemClock;
    this.#onError = options.onError ?? (() => {});

    this.#transport.onConnection((conn) => {
      void this.#accept(conn);
    });

    const sweepInterval = options.sweepIntervalMs ?? Math.max(1, Math.floor(this.registry.ttlMs / 3));
    if (sweepInterval > 0) {
      this.#sweepTimer = setInterval(() => this.sweepNow(), sweepInterval);
      // Do not keep the process alive solely for the liveness sweep.
      this.#sweepTimer.unref?.();
    }
  }

  /**
   * Attach the handler that owns a message family. Convenience delegate to the
   * router's registration seam — this is the canonical extension point every
   * family module (S2/S5/S7) uses.
   */
  registerFamilyHandler(...args: Parameters<FamilyRouter<HubConnection>["registerFamilyHandler"]>): void {
    this.router.registerFamilyHandler(...args);
  }

  /** The bound address of the underlying transport once listening. */
  get address(): { readonly port: number } | null {
    return this.#transport.address;
  }

  /** The number of currently tracked connections. */
  get connectionCount(): number {
    return this.registry.size;
  }

  async #accept(conn: ChannelConnection): Promise<void> {
    // Register the close listener BEFORE awaiting auth. The authenticator may be
    // async, and a peer can disconnect while it is in flight; the connection
    // contract permits only a single close listener, so this one handler covers
    // both the mid-auth race and the connection's normal post-registration life.
    let closed = false;
    conn.onClose(() => {
      closed = true;
      this.registry.remove(conn.id);
      this.#conns.delete(conn.id);
    });

    let auth: Awaited<ReturnType<Authenticator>>;
    try {
      auth = await this.#authenticator(conn.handshake);
    } catch (err) {
      this.#onError(err, conn.id);
      conn.close(AUTH_INTERNAL, "authentication error");
      return;
    }
    if (!auth.ok) {
      conn.close(auth.code, auth.reason);
      return;
    }
    // The peer vanished while auth was in flight — never track a dead socket.
    if (closed) {
      return;
    }

    this.#conns.set(conn.id, conn);
    this.registry.add(conn.id, auth.grant.identity);

    const hubConn: HubConnection = {
      id: conn.id,
      identity: auth.grant.identity,
      handshake: conn.handshake,
      registry: this.registry,
      send: (frame: Frame) => conn.send(encodeFrame(frame)),
      close: (code?: CloseCode, reason?: string) => conn.close(code, reason),
    };

    conn.onMessage((bytes) => this.#onMessage(conn.id, hubConn, bytes));
    conn.onPong?.(() => this.registry.touch(conn.id));
    conn.onPing?.(() => this.registry.touch(conn.id));
  }

  #onMessage(id: string, hubConn: HubConnection, bytes: Uint8Array): void {
    // Any inbound bytes are proof of life at the transport level — refresh
    // liveness before decoding so an actively-transmitting peer is never swept
    // as "silent", even if the bytes fail to decode into a well-formed frame.
    this.registry.touch(id);
    let frame: Frame;
    try {
      frame = decodeFrame(bytes);
    } catch (err) {
      // A malformed frame is a per-message fault, not a connection fault: report
      // it and keep the connection (and its liveness) intact.
      if (err instanceof FrameDecodeError) {
        this.#onError(err, id);
        return;
      }
      throw err;
    }
    this.router.route(frame, hubConn).catch((err: unknown) => this.#onError(err, id));
  }

  /**
   * Age out connections past the liveness TTL and close their sockets. Called
   * automatically by the internal timer; exposed for deterministic tests.
   */
  sweepNow(): void {
    const stale = this.registry.sweep(this.#clock.now());
    for (const entry of stale) {
      const conn = this.#conns.get(entry.id);
      this.#conns.delete(entry.id);
      conn?.close(LIVENESS_TIMEOUT, "liveness timeout");
    }
  }

  /** Stop the liveness sweep and release the transport's port. */
  async close(): Promise<void> {
    if (this.#sweepTimer !== undefined) {
      clearInterval(this.#sweepTimer);
      this.#sweepTimer = undefined;
    }
    // Actively close tracked connections so shutdown is deterministic across
    // transports: ChannelTransport.close() is only specified to stop accepting
    // and release the port, not to terminate live connections. Each close()
    // fires the connection's onClose handler, which clears it from the registry
    // and #conns; snapshot first to avoid mutating the map mid-iteration.
    for (const conn of [...this.#conns.values()]) {
      conn.close();
    }
    this.#conns.clear();
    await this.#transport.close();
  }
}

/** Application close code for an internal authentication error. */
const AUTH_INTERNAL = 4500;
