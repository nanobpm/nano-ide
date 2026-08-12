/**
 * The blackboard store — S7's durable layer over the app DataLayer.
 *
 * A per-scope advisory shared store. Agents READ it on dispatch and WRITE to it
 * during their work ("I now also touch state.rs", "constraint X changed") so
 * parallel siblings coordinate without a human relay. It is a faithful port of
 * nano-workforce's `plan_blackboard` (issues #51 / #49 D4) — the same kinds,
 * idempotent `dedupe_key` append, `file-claim` conflict reporting and
 * `since`/cursor incremental reads — generalised from a hard-wired `plan_key` to
 * a capability-derived `scope`, so any Urban app gets it for free.
 *
 * Design invariants (unchanged from the HTTP hook):
 *  - ADVISORY ONLY. It never gates a sequence flow; it is shared *knowledge*,
 *    read fresh, and is not part of deterministic replay.
 *  - IDEMPOTENT append. A re-POST carrying a stable `dedupeKey` collapses to one
 *    row (backed by a partial UNIQUE index; we also short-circuit here).
 *  - SCOPE-BOUND. Every row carries the `scope` it was written under; reads and
 *    conflict detection never cross scopes.
 *
 * The store speaks only the tiny synchronous SQLite subset the runtime exposes
 * ({@link SqliteDb}), so it works against any app DataLayer source without
 * pulling in the whole runtime (identical to the S2 presence / S6 transcript
 * stores' `SqliteDb`).
 */
import { BLACKBOARD_SCHEMA_SQL, BLACKBOARD_TABLE } from "./schema.ts";

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

/** A monotonic wall clock, injectable for deterministic tests. */
export interface Clock {
  now(): number;
}

/** The default clock: `Date.now()`. */
export const systemClock: Clock = { now: () => Date.now() };

/** The recognised blackboard entry kinds (verbatim from nano-workforce). */
export const BLACKBOARD_KINDS = ["file-claim", "constraint-change", "scope-change", "learning", "note"] as const;
export type BlackboardKind = (typeof BLACKBOARD_KINDS)[number];

/** Coerce an arbitrary `kind` to a known value, defaulting to "note". */
export function normalizeKind(kind: unknown): BlackboardKind {
  return BLACKBOARD_KINDS.find((k) => k === kind) ?? "note";
}

/** What a writer supplies to {@link BlackboardStore.append}. */
export interface BlackboardInput {
  /** The writing task's slug (or "system" for host writes). */
  readonly authorTask?: string;
  /** The entry kind; unrecognised values normalise to "note". */
  readonly kind?: unknown;
  /** Repo-relative paths this entry concerns (feeds `file-claim` conflicts). */
  readonly files?: readonly string[];
  /** The human/agent-readable note. Required and non-blank. */
  readonly body: string;
  /** Optional wave index the writer was dispatched in. */
  readonly wave?: number | null;
  /** Idempotency key; a repeat append under the same `scope` is a no-op. */
  readonly dedupeKey?: string;
}

/** The parsed, agent-facing view of an entry (files decoded to an array). */
export interface BlackboardEntry {
  readonly id: number;
  readonly authorTask: string;
  readonly kind: string;
  readonly files: string[];
  readonly body: string;
  readonly wave: number | null;
  readonly createdAt: string;
}

/**
 * An advisory conflict-of-intent: a sibling has already claimed a file this
 * writer is about to claim. Reported per (file, prior claim) so the later
 * claimer can back off, coordinate, or escalate. First-writer-wins is advisory
 * only — the blackboard NEVER locks; merge-time gates are the real safety net.
 */
export interface ClaimConflict {
  readonly file: string;
  readonly authorTask: string;
  readonly id: number;
  readonly body: string;
  readonly createdAt: string;
}

/** One incremental read: entries after `since` (write order) plus the `cursor`. */
export interface BlackboardPage {
  readonly entries: BlackboardEntry[];
  /**
   * The board's current head id — the true head even when `since` filters every
   * entry out, so a caller that is fully caught up learns it is caught up
   * (cursor unchanged). `0` for an empty board.
   */
  readonly cursor: number;
}

export interface BlackboardStoreOptions {
  /** Injectable clock for deterministic `created_at` in tests. Default {@link systemClock}. */
  readonly clock?: Clock;
}

/** The raw DB row shape (snake_case columns) as read back from SQLite. */
interface DbRow {
  id: number;
  scope: string;
  author_task: string;
  kind: string;
  files: string | null;
  body: string;
  wave: number | null;
  dedupe_key: string | null;
  created_at: string;
}

function decodeFiles(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const v: unknown = JSON.parse(raw);
    return Array.isArray(v)
      ? v.map((x) => String(x).trim()).filter((s) => s !== "")
      : [];
  } catch {
    return [];
  }
}

function normaliseFiles(files: readonly string[] | undefined): string[] {
  return (files ?? []).map((f) => String(f).trim()).filter((s) => s !== "");
}

function toEntry(r: DbRow): BlackboardEntry {
  return {
    id: r.id,
    authorTask: r.author_task,
    kind: r.kind,
    files: decodeFiles(r.files),
    body: r.body,
    wave: r.wave,
    createdAt: r.created_at,
  };
}

/**
 * True only for a UNIQUE / PRIMARY-KEY / duplicate violation — never a
 * foreign-key or other constraint failure. We match the *specific* violation
 * (extended SQLite codes, or the specific words) rather than the bare word
 * "constraint", so a `FOREIGN KEY constraint failed` (real corruption, not a
 * benign duplicate) is always rethrown rather than silently swallowed.
 */
export function isUniqueViolation(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const code = "code" in err ? err.code : undefined;
  if (code === "SQLITE_CONSTRAINT_UNIQUE" || code === "SQLITE_CONSTRAINT_PRIMARYKEY") return true;
  const message = "message" in err ? err.message : undefined;
  return typeof message === "string" && /(unique|primary key) constraint failed|duplicate/i.test(message);
}

export class BlackboardStore {
  readonly #db: SqliteDb;
  readonly #clock: Clock;

  constructor(db: SqliteDb, options: BlackboardStoreOptions = {}) {
    this.#db = db;
    this.#clock = options.clock ?? systemClock;
  }

  /**
   * Apply the canonical blackboard DDL (idempotent). Callers that let the app
   * DataLayer migration runner apply `db/migrations/003_agentic_blackboard.sql`
   * do not need this — the family module calls it so the store is usable against
   * a bare source too. The DDL is identical to the migration (drift-guarded).
   */
  ensureSchema(): void {
    this.#db.exec(BLACKBOARD_SCHEMA_SQL);
  }

  /**
   * Append an entry to a board, idempotently. A blank `body` is rejected. When a
   * `dedupeKey` is supplied and an entry already exists for it under this
   * `scope`, the write is a no-op and the existing id is returned
   * (`inserted: false`) — so an engine job retry re-appending the same fact
   * never duplicates.
   */
  append(scope: string, input: BlackboardInput): { inserted: boolean; id: number } {
    const body = typeof input.body === "string" ? input.body.trim() : "";
    if (!body) throw new Error("blackboard entry requires a non-empty body");
    const dedupeKey = input.dedupeKey?.trim() || undefined;
    if (dedupeKey) {
      const existing = this.#findByDedupe(scope, dedupeKey);
      if (existing !== undefined) return { inserted: false, id: existing };
    }
    const files = normaliseFiles(input.files);
    try {
      const { lastInsertRowid } = this.#db.run(
        `INSERT INTO ${BLACKBOARD_TABLE}
           (scope, author_task, kind, files, body, wave, dedupe_key, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          scope,
          input.authorTask?.trim() || "system",
          normalizeKind(input.kind),
          files.length ? JSON.stringify(files) : null,
          body,
          typeof input.wave === "number" ? input.wave : null,
          dedupeKey ?? null,
          new Date(this.#clock.now()).toISOString(),
        ],
      );
      return { inserted: true, id: Number(lastInsertRowid) };
    } catch (err) {
      // Idempotent write-back under concurrency: two appends sharing a dedupeKey
      // can both miss the pre-check above, then one loses the race on the UNIQUE
      // (scope, dedupe_key) index. Convert that collision into a no-op by
      // re-reading the winner's row, so a retry never throws.
      if (dedupeKey && isUniqueViolation(err)) {
        const existing = this.#findByDedupe(scope, dedupeKey);
        if (existing !== undefined) return { inserted: false, id: existing };
      }
      throw err;
    }
  }

  /**
   * One incremental read of a board: entries with `id > since` in write order,
   * plus the board's current head `cursor`. An agent polling mid-flight passes
   * `cursor` back as the next `since`, so it pulls only what siblings added since
   * its last read.
   */
  readPage(scope: string, opts: { since?: number } = {}): BlackboardPage {
    const since = opts.since ?? 0;
    // Read the head id independently so the cursor is the board's true head even
    // when `since` filters every entry out (a caught-up poller learns it is
    // caught up), and let SQL page with `id > since` against the (scope, id)
    // index instead of loading the whole board to filter client-side.
    const head = this.#db.all<{ cursor: number | bigint | null }>(
      `SELECT MAX(id) AS cursor FROM ${BLACKBOARD_TABLE} WHERE scope = ?`,
      [scope],
    );
    const cursor = Number(head[0]?.cursor ?? 0);
    const rows = this.#db.all<DbRow>(
      `SELECT * FROM ${BLACKBOARD_TABLE} WHERE scope = ? AND id > ? ORDER BY id`,
      [scope, since],
    );
    const entries = rows.map(toEntry);
    return { entries, cursor };
  }

  /** A board's entries in write order (id asc). `since` returns only `id > since`. */
  read(scope: string, opts: { since?: number } = {}): BlackboardEntry[] {
    return this.readPage(scope, opts).entries;
  }

  /**
   * Prior `file-claim` entries by OTHER authors under this `scope` that overlap
   * `files`. A writer's own earlier claim is never a conflict with itself. Pass
   * `beforeId` to restrict to strictly prior claims (`id < beforeId`) — the
   * family computes conflicts AFTER inserting its own claim and sets `beforeId`
   * to that new id, so first-writer-wins is decided by insertion order and a
   * sibling claim that raced in concurrently is still surfaced without matching
   * the writer's own just-written row.
   */
  detectFileClaimConflicts(
    scope: string,
    opts: { authorTask?: string; files: readonly string[]; beforeId?: number },
  ): ClaimConflict[] {
    const want = new Set(normaliseFiles(opts.files));
    if (want.size === 0) return [];
    const me = opts.authorTask?.trim() || "";
    const beforeId = opts.beforeId;
    // Push `id < beforeId` into SQL (the common path per the docstring) so we
    // scan only strictly-prior claims via the (scope, id) index rather than
    // loading every file-claim for the scope and filtering client-side.
    const clauses = ["scope = ?", "kind = 'file-claim'"];
    const params: unknown[] = [scope];
    if (beforeId != null) {
      clauses.push("id < ?");
      params.push(beforeId);
    }
    const rows = this.#db.all<DbRow>(
      `SELECT * FROM ${BLACKBOARD_TABLE} WHERE ${clauses.join(" AND ")} ORDER BY id`,
      params,
    );
    const out: ClaimConflict[] = [];
    for (const r of rows) {
      if ((r.author_task || "") === me) continue;
      for (const f of new Set(decodeFiles(r.files))) {
        if (want.has(f)) {
          out.push({ file: f, authorTask: r.author_task, id: r.id, body: r.body, createdAt: r.created_at });
        }
      }
    }
    return out;
  }

  /** Number of entries under a scope. */
  count(scope: string): number {
    const rows = this.#db.all<{ n: number }>(`SELECT COUNT(*) AS n FROM ${BLACKBOARD_TABLE} WHERE scope = ?`, [scope]);
    return rows[0]?.n ?? 0;
  }

  #findByDedupe(scope: string, dedupeKey: string): number | undefined {
    const rows = this.#db.all<{ id: number }>(
      `SELECT id FROM ${BLACKBOARD_TABLE} WHERE scope = ? AND dedupe_key = ?`,
      [scope, dedupeKey],
    );
    return rows[0]?.id;
  }
}
