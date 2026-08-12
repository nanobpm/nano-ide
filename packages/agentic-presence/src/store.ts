/**
 * The presence & registry store — S2's durable layer over the app DataLayer.
 *
 * S1 owns *connection* liveness in-memory (touch-on-frame + a TTL sweep that
 * closes silent sockets). S2 layers a durable *presence* registry on top: one
 * row per registered worker instance, carrying its declared capability
 * (cognition/weight/family/host — an enrolment attribute, never a routing
 * token), the connection it registered on, and its own `last_seen` liveness
 * refreshed by heartbeats. Rows age out on the presence TTL via {@link sweep}.
 *
 * The store speaks only the tiny synchronous SQLite subset the runtime exposes
 * ({@link SqliteDb}), so it works against any app DataLayer source without
 * pulling in the whole runtime.
 */
import type { Capability } from "@nanobpm/agentic-protocol";
import { systemClock } from "@nanobpm/agentic-channel";
import type { Clock } from "@nanobpm/agentic-channel";
import { PRESENCE_SCHEMA_SQL, PRESENCE_TABLE } from "./schema.ts";

/**
 * The minimal synchronous SQLite handle the store needs — structurally the same
 * surface the Urban runtime's DataLayer exposes (`host.openSqlite`). Kept local
 * so the store depends on a shape, not on the runtime package.
 */
export interface SqliteDb {
  /** Execute one or more statements with no result (DDL, migrations). */
  exec(sql: string): void;
  /** Run a parameterised statement, returning the changed-row count. */
  run(sql: string, params?: unknown[]): { changes: number; lastInsertRowid: number | bigint };
  /** Run a parameterised query, returning all rows as plain objects. */
  all<T = Record<string, unknown>>(sql: string, params?: unknown[]): T[];
}

/** A durable presence row for one registered worker instance. */
export interface PresenceRow {
  /** The worker instance id (`register.instance`) — the primary key. */
  readonly instance: string;
  /** The channel connection the instance last registered on. */
  readonly connectionId: string;
  /** The authenticated principal (ADR 0028 identity) of that connection. */
  readonly identity: string;
  /** The declared enrolment capability (never a routing token). */
  readonly capability: Capability;
  /** When the instance first registered, ISO-8601. */
  readonly registeredAt: string;
  /** Last liveness refresh (register/heartbeat), epoch ms. */
  readonly lastSeen: number;
}

/** Input to {@link PresenceStore.register}. */
export interface RegisterInput {
  readonly instance: string;
  readonly connectionId: string;
  readonly identity: string;
  readonly capability: Capability;
}

export interface PresenceStoreOptions {
  /** Presence liveness TTL in ms; a row unseen for longer ages out. Default 30000. */
  ttlMs?: number;
  /** Injectable clock for deterministic tests. Default {@link systemClock}. */
  clock?: Clock;
}

const DEFAULT_TTL_MS = 30_000;

/**
 * Raised when a `register` would overwrite an instance already owned by a
 * different authenticated identity. Presence rows are bound to the identity
 * that first registered them, so one authenticated peer can never take over
 * (or change the identity of) another peer's instance.
 */
export class PresenceOwnershipError extends Error {
  readonly instance: string;
  constructor(instance: string) {
    super(`instance "${instance}" is registered to a different identity`);
    this.name = "PresenceOwnershipError";
    this.instance = instance;
  }
}

/** The raw DB row shape (snake_case columns) as read back from SQLite. */
interface DbRow {
  instance: string;
  connection_id: string;
  identity: string;
  cognition: string | null;
  weight: number | null;
  family: string | null;
  host: string | null;
  registered_at: string;
  last_seen: number;
}

function buildCapability(row: DbRow): Capability {
  const cap: {
    cognition?: string;
    weight?: number;
    family?: string;
    host?: string;
  } = {};
  if (row.cognition !== null) cap.cognition = row.cognition;
  if (row.weight !== null) cap.weight = row.weight;
  if (row.family !== null) cap.family = row.family;
  if (row.host !== null) cap.host = row.host;
  return cap;
}

function toRow(row: DbRow): PresenceRow {
  return {
    instance: row.instance,
    connectionId: row.connection_id,
    identity: row.identity,
    capability: buildCapability(row),
    registeredAt: row.registered_at,
    lastSeen: row.last_seen,
  };
}

export class PresenceStore {
  readonly #db: SqliteDb;
  readonly #ttlMs: number;
  readonly #clock: Clock;

  constructor(db: SqliteDb, options: PresenceStoreOptions = {}) {
    this.#db = db;
    this.#ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    this.#clock = options.clock ?? systemClock;
  }

  /** The presence liveness TTL in ms. */
  get ttlMs(): number {
    return this.#ttlMs;
  }

  /**
   * Apply the canonical presence DDL (idempotent). Callers that let the app
   * DataLayer migration runner apply `db/migrations/001_agentic_presence.sql`
   * do not need this — but the family module calls it so the store is usable
   * against a bare source too. The DDL is identical to the migration (guarded).
   */
  ensureSchema(): void {
    this.#db.exec(PRESENCE_SCHEMA_SQL);
  }

  /**
   * Register (or re-register) an instance. A first registration stamps
   * `registered_at`; a re-registration (e.g. after a reconnect on a new
   * connection) keeps the original `registered_at` and refreshes everything
   * else, including `last_seen`. Returns the stored row.
   *
   * Ownership is bound to the authenticated `identity` that first registered the
   * instance: a re-register from the same identity (the reconnect case) is
   * allowed, but one from a *different* identity is rejected with a
   * {@link PresenceOwnershipError} and leaves the existing row untouched — no
   * peer can take over another peer's instance or rewrite its identity.
   */
  register(input: RegisterInput): PresenceRow {
    const now = this.#clock.now();
    const cap = input.capability;
    const { changes } = this.#db.run(
      `INSERT INTO ${PRESENCE_TABLE}
         (instance, connection_id, identity, cognition, weight, family, host, registered_at, last_seen)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(instance) DO UPDATE SET
         connection_id = excluded.connection_id,
         identity      = excluded.identity,
         cognition     = excluded.cognition,
         weight        = excluded.weight,
         family        = excluded.family,
         host          = excluded.host,
         last_seen     = excluded.last_seen
       WHERE ${PRESENCE_TABLE}.identity = excluded.identity`,
      [
        input.instance,
        input.connectionId,
        input.identity,
        cap.cognition ?? null,
        cap.weight ?? null,
        cap.family ?? null,
        cap.host ?? null,
        new Date(now).toISOString(),
        now,
      ],
    );
    // An UPSERT that neither inserts (instance already present) nor updates (the
    // identity guard filtered the row out) reports zero changes: the instance is
    // owned by another identity. Reject rather than silently leaving it stale.
    if (changes === 0) {
      throw new PresenceOwnershipError(input.instance);
    }
    const row = this.get(input.instance);
    if (row === undefined) {
      throw new Error(`presence row vanished immediately after register: ${input.instance}`);
    }
    return row;
  }

  /**
   * Refresh an instance's liveness to now. Returns `true` if the instance was
   * registered, `false` if there is no such row (a heartbeat before register).
   * When `identity` is given, the refresh is scoped to the owning identity, so a
   * heartbeat from a foreign identity is a silent no-op (and cannot probe for
   * the existence of another peer's instance).
   */
  heartbeat(instance: string, identity?: string): boolean {
    const { changes } =
      identity === undefined
        ? this.#db.run(`UPDATE ${PRESENCE_TABLE} SET last_seen = ? WHERE instance = ?`, [this.#clock.now(), instance])
        : this.#db.run(`UPDATE ${PRESENCE_TABLE} SET last_seen = ? WHERE instance = ? AND identity = ?`, [
            this.#clock.now(),
            instance,
            identity,
          ]);
    return changes > 0;
  }

  /**
   * Remove an instance's presence row. Returns `true` if a row was removed. When
   * `identity` is given, the removal is scoped to the owning identity, so a
   * deregister from a foreign identity is a silent no-op.
   */
  deregister(instance: string, identity?: string): boolean {
    const { changes } =
      identity === undefined
        ? this.#db.run(`DELETE FROM ${PRESENCE_TABLE} WHERE instance = ?`, [instance])
        : this.#db.run(`DELETE FROM ${PRESENCE_TABLE} WHERE instance = ? AND identity = ?`, [instance, identity]);
    return changes > 0;
  }

  /**
   * Remove every presence row registered on a now-dead connection (e.g. one S1
   * closed on its own liveness sweep). Returns the removed instance ids so the
   * caller can react. Presence also ages out via {@link sweep}; this is the
   * eager path when a disconnect is observed.
   */
  removeByConnection(connectionId: string): string[] {
    const removed = this.#db
      .all<{ instance: string }>(`SELECT instance FROM ${PRESENCE_TABLE} WHERE connection_id = ?`, [connectionId])
      .map((r) => r.instance);
    if (removed.length > 0) {
      this.#db.run(`DELETE FROM ${PRESENCE_TABLE} WHERE connection_id = ?`, [connectionId]);
    }
    return removed;
  }

  /**
   * Age out every presence row whose `last_seen` is older than the TTL and
   * return the removed rows. `now` defaults to the clock; pass an explicit value
   * for deterministic tests. Matches S1's liveness predicate (`now - lastSeen >
   * ttl`).
   */
  sweep(now: number = this.#clock.now()): PresenceRow[] {
    const cutoff = now - this.#ttlMs;
    const stale = this.#db
      .all<DbRow>(`SELECT * FROM ${PRESENCE_TABLE} WHERE last_seen < ?`, [cutoff])
      .map(toRow);
    if (stale.length > 0) {
      this.#db.run(`DELETE FROM ${PRESENCE_TABLE} WHERE last_seen < ?`, [cutoff]);
    }
    return stale;
  }

  /** Look up a single instance's presence row. */
  get(instance: string): PresenceRow | undefined {
    const rows = this.#db.all<DbRow>(`SELECT * FROM ${PRESENCE_TABLE} WHERE instance = ?`, [instance]);
    const row = rows[0];
    return row === undefined ? undefined : toRow(row);
  }

  /** Every presence row, ordered by first registration then instance id. */
  list(): PresenceRow[] {
    return this.#db
      .all<DbRow>(`SELECT * FROM ${PRESENCE_TABLE} ORDER BY registered_at, instance`)
      .map(toRow);
  }

  /** Number of registered instances. */
  count(): number {
    const rows = this.#db.all<{ n: number }>(`SELECT COUNT(*) AS n FROM ${PRESENCE_TABLE}`);
    return rows[0]?.n ?? 0;
  }
}
