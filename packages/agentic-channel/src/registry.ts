/**
 * The connection registry with liveness.
 *
 * S1 tracks every authenticated connection and its last-seen time; a connection
 * not seen within the liveness TTL ages out on {@link ConnectionRegistry.sweep}.
 * Presence detail (instance / declared capability / host / family) is left blank
 * by S1 and filled in by the S2 register/heartbeat family module through
 * {@link ConnectionRegistry.setPresence} — S1 owns liveness, S2 owns presence.
 */
import type { Capability } from "@nanobpm/agentic-protocol";
import { systemClock } from "./clock.ts";
import type { Clock } from "./clock.ts";

/** Presence attributes a family module (S2) attaches to a live connection. */
export interface Presence {
  /** The worker instance id declared on `register`. */
  instance?: string;
  /** The enrolment capability declared on `register` (never a routing token). */
  capability?: Capability;
}

/** A tracked, authenticated connection. */
export interface RegisteredConnection {
  /** The connection id (matches {@link ChannelConnection.id}). */
  readonly id: string;
  /** The authenticated principal (ADR 0028 identity) from the handshake. */
  readonly identity: string;
  /** When the connection was accepted, in epoch ms. */
  readonly connectedAt: number;
  /** Last time any inbound frame or keepalive pong was seen, in epoch ms. */
  lastSeen: number;
  /** Presence detail, populated by the S2 family module (blank until then). */
  presence: Presence;
}

export interface ConnectionRegistryOptions {
  /** Liveness TTL in ms; a connection unseen for longer ages out. Default 30000. */
  ttlMs?: number;
  /** Injectable clock (deterministic tests). Default {@link systemClock}. */
  clock?: Clock;
}

const DEFAULT_TTL_MS = 30_000;

export class ConnectionRegistry {
  readonly #byId = new Map<string, RegisteredConnection>();
  readonly #ttlMs: number;
  readonly #clock: Clock;

  constructor(options: ConnectionRegistryOptions = {}) {
    this.#ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    this.#clock = options.clock ?? systemClock;
  }

  /** The liveness TTL in ms. */
  get ttlMs(): number {
    return this.#ttlMs;
  }

  /** Number of tracked connections. */
  get size(): number {
    return this.#byId.size;
  }

  /**
   * Start tracking a newly authenticated connection. `connectedAt` and
   * `lastSeen` are set to now; presence starts blank.
   */
  add(id: string, identity: string): RegisteredConnection {
    const now = this.#clock.now();
    const entry: RegisteredConnection = {
      id,
      identity,
      connectedAt: now,
      lastSeen: now,
      presence: {},
    };
    this.#byId.set(id, entry);
    return entry;
  }

  /** Update a connection's liveness to now. No-op if unknown. */
  touch(id: string): void {
    const entry = this.#byId.get(id);
    if (entry !== undefined) {
      entry.lastSeen = this.#clock.now();
    }
  }

  /** Merge presence detail onto a tracked connection (used by S2). No-op if unknown. */
  setPresence(id: string, patch: Presence): void {
    const entry = this.#byId.get(id);
    if (entry !== undefined) {
      entry.presence = { ...entry.presence, ...patch };
    }
  }

  /** Look up a tracked connection. */
  get(id: string): RegisteredConnection | undefined {
    return this.#byId.get(id);
  }

  /** Whether a connection is tracked. */
  has(id: string): boolean {
    return this.#byId.has(id);
  }

  /** Stop tracking a connection, returning the removed entry if present. */
  remove(id: string): RegisteredConnection | undefined {
    const entry = this.#byId.get(id);
    this.#byId.delete(id);
    return entry;
  }

  /** All tracked connections, in insertion order. */
  list(): RegisteredConnection[] {
    return [...this.#byId.values()];
  }

  /**
   * Age out every connection whose last-seen time is older than the TTL and
   * return the removed entries, so the hub can close their sockets. `now`
   * defaults to the clock; pass an explicit value for deterministic tests.
   */
  sweep(now: number = this.#clock.now()): RegisteredConnection[] {
    const stale: RegisteredConnection[] = [];
    for (const entry of this.#byId.values()) {
      if (now - entry.lastSeen > this.#ttlMs) {
        stale.push(entry);
      }
    }
    for (const entry of stale) {
      this.#byId.delete(entry.id);
    }
    return stale;
  }
}
