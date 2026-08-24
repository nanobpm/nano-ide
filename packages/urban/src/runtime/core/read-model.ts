// read-model — the declare-once, compile-to-both derived read-model primitive (ADR 0065).
//
// An Urban app presents derived operator state that is a *pure function of canonical inputs* — a
// task's display stage, an instance's status edge, whether it is parked on a human. nano-workforce
// #412 made those display projections SQLite VIEWs so the stored/derived value could not tear from
// its inputs, but two drift surfaces survived that this module closes:
//
//   • Surface #2 — a derived column authored TWICE: once as SQL (CASE/EXISTS) inside the VIEW, and
//     once as a TS oracle (a `deriveStage`-style function) the app calls in-process, kept in
//     lockstep only by a hand-written parity test (itself a drift surface).
//   • Surface #3 — every read model hand-wired end to end (migration + VIEW + page binding +
//     pages↔schema contract entry + parity test), re-authored per projection.
//
// The fix is to declare a derived read model ONCE, as a pure derivation over a base row plus named
// canonical projections, expressed in a small CLOSED expression DSL (a discriminated-union AST — NOT
// arbitrary SQL strings). A single compiler then emits BOTH backends from that one AST, so they
// cannot drift by construction:
//
//   • {@link compileToSqlSelect} — the SQLite VIEW select-list expression for the derived column.
//   • {@link compileToFn}        — a runtime TS function `(baseRow, projections) => value` computing
//                                  the same value in-process.
//
// From a {@link defineReadModel} declaration the framework then DERIVES the managed VIEW DDL
// ({@link deriveReadModelViewDdl}) and a PARITY GUARD ({@link assertReadModelParity}) an app calls
// with sample rows instead of hand-writing a bespoke parity test per projection.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────────
//  SHARED SEAMS FOR SIBLING TASKS (ADR 0065 rollout) — read this before extending:
//
//   (a) Read-model registry — {@link ReadModelRegistry} + the process-wide {@link readModelRegistry}
//       singleton. A sidecar/app registers a `defineReadModel(...)` result here; the runtime boot
//       path (see `core/modules/workers.ts`) applies every registered model's managed VIEW to the
//       app's data source. The `writer-source-inversion` task registers the derived status-edge read
//       model here. NB: this is intentionally NAMED `readModelRegistry`, distinct from the toolkit's
//       unrelated `readModels()` model-file scanner — they are different concepts.
//
//   (b) Projection-name seam — {@link ProjectionRegistry} + the process-wide {@link projectionRegistry}
//       singleton. A canonical engine-truth projection sidecar (the `canonical-projections` task,
//       landing `urban_open_user_tasks` and `urban_instance_state`) registers a projection NAME so an
//       `EXISTS(name, ...)` in the DSL resolves: the SQL backend learns which physical table/view to
//       read, and the TS backend is handed the projection's rows at evaluate time via the
//       `projections` argument. A read model can reference a projection by name even though the
//       concrete sidecar lands in a later wave.
//
//   (c) Barrel — everything here is re-exported from `packages/urban/src/runtime/index.ts` under the
//       clearly-commented "Read models" section.
// ─────────────────────────────────────────────────────────────────────────────────────────────────

// ────────────────────────────────── Expression DSL (closed AST) ──────────────────────────────────

/** The comparison operators the DSL supports, in both backends. */
export type CompareOp = "eq" | "neq" | "lt" | "lte" | "gt" | "gte";

/** A DSL literal value. Kept to the SQL/JS-portable scalars so both backends agree. */
export type Literal = string | number | boolean | null;

/**
 * The closed expression AST — a discriminated union, NOT arbitrary strings or SQL fragments. This
 * closedness is the whole point: one declaration compiles to two backends that cannot drift. Every
 * node kind is handled exhaustively by both {@link compileToSqlSelect} and {@link compileToFn}.
 *
 * `col` references a column of the BASE row. `pcol` references a column of the CORRELATED projection
 * row and is only meaningful inside an {@link ExistsExpr} `where` predicate.
 */
export type Expr =
  | LitExpr
  | ColExpr
  | ProjColExpr
  | RollupColExpr
  | CompareExpr
  | AndExpr
  | OrExpr
  | NotExpr
  | IsNullExpr
  | CaseExpr
  | ExistsExpr;

export interface LitExpr {
  readonly kind: "lit";
  readonly value: Literal;
}
export interface ColExpr {
  readonly kind: "col";
  readonly name: string;
}
export interface ProjColExpr {
  readonly kind: "pcol";
  readonly name: string;
}
export interface RollupColExpr {
  readonly kind: "rcol";
  /** The read-model rollup-lookup alias this column is read from (see {@link RollupLookupDecl}). */
  readonly lookup: string;
  /** The rollup output column referenced (a column of the looked-up `*_counts` rollup row). */
  readonly name: string;
}
export interface CompareExpr {
  readonly kind: "compare";
  readonly op: CompareOp;
  readonly left: Expr;
  readonly right: Expr;
}
export interface AndExpr {
  readonly kind: "and";
  readonly clauses: readonly Expr[];
}
export interface OrExpr {
  readonly kind: "or";
  readonly clauses: readonly Expr[];
}
export interface NotExpr {
  readonly kind: "not";
  readonly expr: Expr;
}
export interface IsNullExpr {
  readonly kind: "isNull";
  readonly expr: Expr;
}
export interface WhenClause {
  readonly when: Expr;
  readonly then: Expr;
}
export interface CaseExpr {
  readonly kind: "case";
  readonly whens: readonly WhenClause[];
  readonly else: Expr;
}
export interface ExistsExpr {
  readonly kind: "exists";
  /** The projection name referenced (resolved to a physical table via {@link ProjectionRegistry}). */
  readonly projection: string;
  /** The correlation predicate; may mix {@link pcol} (projection) and {@link col} (base) refs. */
  readonly where: Expr;
}

// ─────────────────────────────────────── Expression builders ─────────────────────────────────────

/** A literal scalar. */
export const lit = (value: Literal): LitExpr => ({ kind: "lit", value });
/** A reference to a BASE-row column. */
export const col = (name: string): ColExpr => ({ kind: "col", name });
/** A reference to a correlated PROJECTION-row column (only valid inside {@link exists}). */
export const pcol = (name: string): ProjColExpr => ({ kind: "pcol", name });
/**
 * A reference to a column of a key-correlated ROLLUP LOOKUP row (see {@link ReadModelDecl.lookups}).
 * `rcol("c", "prs_opened")` reads the `prs_opened` column of the rollup joined under alias `"c"` for
 * the base row (compiling to `LEFT JOIN <rollup> ON <key>` on the SQL side / the matching group row on
 * the TS side). Only valid in a {@link defineReadModel} whose `lookups` declares that alias.
 */
export const rcol = (lookup: string, name: string): RollupColExpr => ({ kind: "rcol", lookup, name });

const cmp = (op: CompareOp) => (left: Expr, right: Expr): CompareExpr => ({ kind: "compare", op, left, right });
export const eq = cmp("eq");
export const neq = cmp("neq");
export const lt = cmp("lt");
export const lte = cmp("lte");
export const gt = cmp("gt");
export const gte = cmp("gte");

export const and = (...clauses: Expr[]): AndExpr => ({ kind: "and", clauses });
export const or = (...clauses: Expr[]): OrExpr => ({ kind: "or", clauses });
export const not = (expr: Expr): NotExpr => ({ kind: "not", expr });
/** `<expr> IS NULL` — a null test (1/0 in SQL; `value == null` in TS). `not(isNull(x))` is `IS NOT NULL`. */
export const isNull = (expr: Expr): IsNullExpr => ({ kind: "isNull", expr });
/** Sugar for `not(isNull(expr))` — `<expr> IS NOT NULL`. */
export const isNotNull = (expr: Expr): NotExpr => ({ kind: "not", expr: { kind: "isNull", expr } });

/** Build a `CASE WHEN … THEN … [WHEN …] ELSE … END` expression. */
export const caseWhen = (whens: WhenClause[], otherwise: Expr): CaseExpr => ({
  kind: "case",
  whens,
  else: otherwise,
});
/** Sugar for a single `{ when, then }` clause used by {@link caseWhen}. */
export const when = (whenExpr: Expr, thenExpr: Expr): WhenClause => ({ when: whenExpr, then: thenExpr });

/** `EXISTS (SELECT 1 FROM <projection> WHERE <where>)` — a correlated existence test. */
export const exists = (projection: string, where: Expr): ExistsExpr => ({ kind: "exists", projection, where });

// ───────────────────────────────────────── Projection seam ───────────────────────────────────────

/**
 * A canonical projection the DSL's {@link exists} can reference by name. A sidecar (the
 * `canonical-projections` task) provides one per engine-truth projection so the SQL backend knows
 * which physical table/view to read and the TS backend can be handed matching rows.
 */
export interface ProjectionSource {
  /** The stable DSL name used in `exists(name, …)`. */
  readonly name: string;
  /**
   * The physical SQLite table/view the SQL backend reads for `EXISTS`. Defaults to {@link name} when
   * the stable DSL name already matches the physical relation; a sidecar sets it explicitly when the
   * two differ (e.g. a stable DSL name like `urban_instance_state` mapped onto an `_urban_`-prefixed
   * engine-truth table).
   */
  readonly sqlTable?: string;
}

/** The in-memory rows the TS backend sees for one evaluation, keyed by projection name. */
export type ProjectionRows = Record<string, ReadonlyArray<Record<string, unknown>>>;

/** A base row fed to the TS backend / parity guard. */
export type BaseRow = Record<string, unknown>;

/**
 * The projection-name registry (seam (b)). A canonical engine-truth projection sidecar registers its
 * name here so a `defineReadModel` authored anywhere can `exists(name, …)` over it. Advisory/idempotent:
 * re-registering the same name with a matching `sqlTable` is a no-op; a conflicting `sqlTable` throws
 * so two sidecars cannot silently claim one name.
 */
export class ProjectionRegistry {
  readonly #byName = new Map<string, ProjectionSource>();

  register(source: ProjectionSource): void {
    const key = foldSqlIdentifier(source.name);
    const existing = this.#byName.get(key);
    const sqlTable = source.sqlTable ?? source.name;
    if (existing) {
      if (existing.name !== source.name) {
        // Case-only variant of an already-registered name (e.g. "Foo" vs "foo"). SQLite folds
        // identifiers, so both denote ONE physical relation; allowing both would silently alias.
        throw new Error(
          `projection "${source.name}" already registered as "${existing.name}"; SQLite folds ` +
            `identifiers case-insensitively, so names differing only in case denote one relation`,
        );
      }
      const existingTable = existing.sqlTable ?? existing.name;
      if (existingTable !== sqlTable) {
        throw new Error(
          `projection "${source.name}" already registered to table "${existingTable}"; ` +
            `refusing to re-register to "${sqlTable}"`,
        );
      }
      return;
    }
    assertSqlIdentifier("projection name", source.name);
    assertSqlIdentifier("projection table", sqlTable);
    this.#byName.set(key, { name: source.name, sqlTable });
  }

  /** The physical SQL table/view for a projection name; falls back to the name itself if unregistered
   *  (so a read model compiles against a not-yet-landed sidecar, which supplies the same-named table). */
  sqlTableFor(name: string): string {
    return this.#byName.get(foldSqlIdentifier(name))?.sqlTable ?? name;
  }

  has(name: string): boolean {
    return this.#byName.has(foldSqlIdentifier(name));
  }

  names(): string[] {
    return [...this.#byName.values()].map((s) => s.name);
  }

  /** Reset all registrations. Mirrors {@link ReadModelRegistry.clear} so tests and dev harnesses can
   *  restore this process-wide singleton to a deterministic empty state (isolation across test runs). */
  clear(): void {
    this.#byName.clear();
  }
}

/**
 * Process-wide projection registry — the concrete registration point sidecars import and call. The
 * `canonical-projections` task registers `urban_open_user_tasks` and `urban_instance_state` here.
 */
export const projectionRegistry = new ProjectionRegistry();

// ─────────────────────────────────────────── SQL backend ─────────────────────────────────────────

/** Options for {@link compileToSqlSelect}. */
export interface SqlCompileOptions {
  /** The alias the managed VIEW gives the base table (so `col("x")` → `<baseAlias>."x"`). */
  readonly baseAlias?: string;
  /** Resolve a projection NAME to its physical SQL table/view. Defaults to {@link projectionRegistry}. */
  readonly resolveProjectionTable?: (name: string) => string;
  /**
   * Resolve a {@link col} reference to its qualified SQL expression, overriding the default
   * `<baseAlias>."name"`. A rollup over a key-JOIN uses this to map a flat output-column name onto the
   * correct joined relation (`col("pr_status")` → `"r"."status"`) so the closed {@link Expr} predicate
   * machinery is reused unchanged across single-relation and join sources.
   */
  readonly resolveColumn?: (name: string) => string;
  /**
   * Resolve an {@link rcol} reference (a key-correlated rollup-lookup column) to its qualified SQL
   * expression. {@link defineReadModel} supplies this from its `lookups` so the lookup's NULL default
   * (a LEFT-JOIN miss) compiles to `COALESCE(<alias>."name", <default>)`.
   */
  readonly resolveRollupColumn?: (lookup: string, name: string) => string;
}

const DEFAULT_BASE_ALIAS = "base";
/**
 * Resolve and validate the base-table alias. A caller-provided `baseAlias` is interpolated straight
 * into DDL/SQL, so it must be a real identifier — validating here is the single source of truth for
 * every call site (VIEW DDL + derivation compile).
 */
function resolveBaseAlias(alias: string | undefined): string {
  return assertSqlIdentifier("base alias", alias ?? DEFAULT_BASE_ALIAS);
}

/** A conservative SQL identifier guard — we interpolate names directly into DDL/SQL. This is the
 *  single source of truth for "is this a legal identifier"; the manifest validator imports it (rather
 *  than re-declaring the regex) so a name accepted at author time is accepted at VIEW provisioning too
 *  (No Drift Surfaces — a divergence would let a manifest validate but fail at boot). */
export const SQL_IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;
/** True iff `name` is a legal SQL identifier per {@link SQL_IDENT}. The boolean twin of
 *  {@link assertSqlIdentifier}, for callers (e.g. the manifest validator) that collect issues rather
 *  than throw. */
export function isSqlIdentifier(name: string): boolean {
  return SQL_IDENT.test(name);
}
export function assertSqlIdentifier(kind: string, name: string): string {
  if (!SQL_IDENT.test(name)) {
    throw new Error(`invalid ${kind} "${name}": must match ${SQL_IDENT.source}`);
  }
  return name;
}
/** Object-name prefixes reserved for engine/runtime internals. Tables and views whose names begin
 *  with one of these are Nano bookkeeping (`_urban_*` / `_nano_*`) or SQLite internals (`sqlite_*`):
 *  the provenance recorder skips them (`modules/datasource.ts`) and the datasource `schema()` surface
 *  filters them out (`modules/gateway.ts`), so they are invisible to `/app/data`, DB Manager, and forms.
 *  This is the single source of truth for that prefix set (No Drift Surfaces — a manifest that provisions
 *  a `_urban_*` VIEW would otherwise validate yet be unreadable by the documented pages surface). */
export const RESERVED_OBJECT_PREFIXES = ["_urban_", "_nano_", "sqlite_"] as const;
/** True iff `name` begins with a {@link RESERVED_OBJECT_PREFIXES} prefix. Case-insensitive, matching
 *  SQLite's ASCII identifier folding (a `_URBAN_x` table resolves to the same reserved object as
 *  `_urban_x`), so a reserved name cannot slip through by casing. */
export function isReservedObjectName(name: string): boolean {
  const folded = name.toLowerCase();
  return RESERVED_OBJECT_PREFIXES.some((p) => folded.startsWith(p));
}
function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}
/**
 * Fold a (validated, ASCII) SQL identifier to its canonical case. SQLite compares identifiers
 * case-insensitively, so names differing only in case (`"TASKS"` vs `"tasks"`) denote the SAME
 * object; every identifier equality check and dedup key in this module MUST fold through here or it
 * will miss such collisions and fail opaquely later at provisioning. `SQL_IDENT` restricts
 * identifiers to ASCII `[A-Za-z0-9_]`, so `toLowerCase()` matches SQLite's ASCII case folding exactly.
 */
function foldSqlIdentifier(name: string): string {
  return name.toLowerCase();
}

const SQL_COMPARE: Record<CompareOp, string> = {
  eq: "=",
  neq: "<>",
  lt: "<",
  lte: "<=",
  gt: ">",
  gte: ">=",
};

function sqlLiteral(value: Literal): string {
  if (value === null) return "NULL";
  if (typeof value === "boolean") return value ? "1" : "0";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error(`non-finite numeric literal cannot compile to SQL: ${value}`);
    return String(value);
  }
  return `'${value.replace(/'/g, "''")}'`;
}

/**
 * Compile ONE derivation expression to a SQLite select-list expression string — the derived column's
 * body inside the managed VIEW. Both backends walk the SAME AST, so the SQL here and the function
 * {@link compileToFn} produces cannot diverge.
 */
export function compileToSqlSelect(expr: Expr, options: SqlCompileOptions = {}): string {
  const baseAlias = resolveBaseAlias(options.baseAlias);
  const resolveTable = options.resolveProjectionTable ?? ((n: string) => projectionRegistry.sqlTableFor(n));

  // Reserved alias for the EXISTS projection relation, derived so it can never equal `baseAlias`: a
  // projection whose physical table name happens to match the base alias would otherwise shadow the
  // outer base row inside the sub-select, silently breaking `col(...)` correlation. Depth-indexed so
  // nested EXISTS predicates each bind `pcol(...)` to their own projection, not the innermost one.
  // SQLite compares identifiers case-insensitively, so a `baseAlias` that differs only by case (e.g.
  // "__URBAN_PROJ_0") would still collide with the reserved alias — guard case-insensitively.
  const projAliasAt = (depth: number): string => {
    let alias = `__urban_proj_${depth}`;
    while (foldSqlIdentifier(alias) === foldSqlIdentifier(baseAlias)) alias = `_${alias}`;
    return alias;
  };

  const walk = (node: Expr, projTable: string | undefined, existsDepth: number): string => {
    switch (node.kind) {
      case "lit":
        return sqlLiteral(node.value);
      case "col":
        return options.resolveColumn ? options.resolveColumn(node.name) : `${quoteIdent(baseAlias)}.${quoteIdent(node.name)}`;
      case "pcol":
        if (!projTable) {
          throw new Error(`pcol("${node.name}") used outside an EXISTS projection context`);
        }
        return `${quoteIdent(projTable)}.${quoteIdent(node.name)}`;
      case "rcol":
        if (!options.resolveRollupColumn) {
          throw new Error(`rcol("${node.lookup}", "${node.name}") used outside a rollup-lookup context`);
        }
        return options.resolveRollupColumn(node.lookup, node.name);
      case "compare":
        // SQLite comparisons against NULL yield NULL, but the TS backend (compareValues) collapses any
        // nullish operand to `false`/0. COALESCE the SQL result to 0 so both backends agree on NULL inputs.
        return `COALESCE((${walk(node.left, projTable, existsDepth)} ${SQL_COMPARE[node.op]} ${walk(node.right, projTable, existsDepth)}), 0)`;
      case "and":
        // `NULL AND 0`/`NULL OR 0` can yield NULL in SQLite, but the TS backend coerces each clause through
        // `truthy(...)` (NULL → false), so COALESCE the boolean expression to 0 to keep the 0/1 domain aligned.
        return node.clauses.length
          ? `COALESCE((${node.clauses.map((c) => walk(c, projTable, existsDepth)).join(" AND ")}), 0)`
          : "1";
      case "or":
        return node.clauses.length
          ? `COALESCE((${node.clauses.map((c) => walk(c, projTable, existsDepth)).join(" OR ")}), 0)`
          : "0";
      case "not":
        // `NOT NULL` is NULL in SQLite, while the TS backend returns `!truthy(NULL)` → true. Compile as
        // `NOT COALESCE(x, 0)` so `not(NULL)` is 1 in both backends under the shared "NULL → false" rule.
        return `(NOT COALESCE(${walk(node.expr, projTable, existsDepth)}, 0))`;
      case "isNull":
        // `x IS NULL` yields 1/0 in SQLite (never NULL), matching the TS backend's `value == null` test.
        return `(${walk(node.expr, projTable, existsDepth)} IS NULL)`;
      case "case": {
        const whens = node.whens
          .map((w) => `WHEN ${walk(w.when, projTable, existsDepth)} THEN ${walk(w.then, projTable, existsDepth)}`)
          .join(" ");
        return `CASE ${whens} ELSE ${walk(node.else, projTable, existsDepth)} END`;
      }
      case "exists": {
        const table = assertSqlIdentifier("projection table", resolveTable(node.projection));
        // Alias the projection relation to a reserved name distinct from `baseAlias` so `col(...)` in the
        // predicate always correlates to the OUTER base row (via `pcol` binds to this alias). The closed
        // AST keeps the correlation explicit and injection-free.
        const projAlias = projAliasAt(existsDepth);
        return `EXISTS (SELECT 1 FROM ${quoteIdent(table)} AS ${quoteIdent(projAlias)} WHERE ${walk(node.where, projAlias, existsDepth + 1)})`;
      }
    }
  };
  return walk(expr, undefined, 0);
}

// ─────────────────────────────────────────── TS backend ──────────────────────────────────────────

/** The resolved single rollup-lookup rows for one evaluation, keyed by the FOLDED (case-insensitive,
 *  SQLite-folded) lookup alias — see {@link rcol}, whose `node.lookup` is folded the same way on read.
 *  Every declared lookup alias maps to exactly one resolved row: the matched rollup group with its
 *  missing/NULL columns already filled from the lookup's declared defaults (the TS twin of the VIEW's
 *  `COALESCE(alias.col, default)`). A LEFT-JOIN miss is therefore represented as a defaults/NULL-filled
 *  row — NOT an absent alias — so `rcol` always reads a stable object. Framework resolvers
 *  ({@link ReadModel.evaluate}, the parity guard) populate this; a raw `fnFor` caller on a model with
 *  lookups must pass the resolved map. */
export type LookupRows = Record<string, Record<string, unknown>>;

/** The compiled runtime derivation: same value as the SQL VIEW, computed in-process. */
export type DerivationFn = (baseRow: BaseRow, projections?: ProjectionRows, lookups?: LookupRows) => unknown;

function compareValues(op: CompareOp, left: unknown, right: unknown): boolean {
  // SQL comparisons against NULL yield NULL, which is falsy in WHERE/CASE-WHEN contexts. Mirror that:
  // any NULL/undefined operand makes eq/lt/… false and neq false too (SQL `x <> NULL` is also NULL).
  const nullish = left === null || left === undefined || right === null || right === undefined;
  if (nullish) return false;
  // Compare through the SAME scalar normalisation as ordering so the TS backend matches SQLite:
  // booleans compile to 1/0 in SQL (see sqlLiteral), so `eq(col("x"), lit(true))` must be true when
  // `x` is 1 (strict `===` would make `1 === true` false and drift); and 64-bit INTEGER keys arriving
  // as `bigint` compare EXACTLY (never truncated through `Number()` — see compareOrderable).
  const cmp = compareOrderable(orderable(left), orderable(right));
  switch (op) {
    case "eq":
      return cmp === 0;
    case "neq":
      // A NaN (incomparable, e.g. NaN against a real number) is "not equal" → true.
      return cmp !== 0;
    case "lt":
      return cmp < 0;
    case "lte":
      return cmp <= 0;
    case "gt":
      return cmp > 0;
    case "gte":
      return cmp >= 0;
  }
}

/** Normalise a scalar to an orderable primitive for comparison, matching SQLite affinity: numbers
 *  compare numerically, booleans as 0/1, `bigint` INTEGERs are kept EXACT (so 64-bit keys past 2^53
 *  don't collapse together), everything else as its string form. Avoids unsafe casts. */
function orderable(value: unknown): number | bigint | string {
  if (typeof value === "number") return value;
  // SQLite INTEGERs can reach the TS backend as `bigint` (e.g. a 64-bit key in a base row). Keep the
  // exact `bigint` — truncating via `Number()` would collapse two distinct keys beyond Number.MAX_-
  // SAFE_INTEGER to one value and silently drift from the SQL VIEW (compareOrderable compares exactly).
  if (typeof value === "bigint") return value;
  if (typeof value === "string") return value;
  if (typeof value === "boolean") return value ? 1 : 0;
  return String(value);
}

/** Three-way compare two {@link orderable} scalars the way SQLite's WHERE/ORDER BY would, WITHOUT
 *  truncating 64-bit `bigint` keys through `Number()`. Returns a negative/zero/positive number, or
 *  `NaN` only when two real numbers are genuinely incomparable (a `NaN` operand) — callers treat that
 *  as "not equal, not ordered". */
function compareOrderable(left: number | bigint | string, right: number | bigint | string): number {
  const leftText = typeof left === "string";
  const rightText = typeof right === "string";

  // Mixed numeric-vs-text. This TS backend mirrors the VIEW as exercised by the parity guard, whose
  // TEMP fixtures declare NO column affinity: with affinity-free operands SQLite orders purely by
  // storage class (NULL < INTEGER/REAL < TEXT) and applies no numeric-affinity coercion, so a numeric
  // value always sorts BEFORE a text value and is never equal to one — even a numeric-looking "42".
  // (A real base table that declared an INTEGER/TEXT affinity WOULD coerce across classes; the guard's
  // affinity-free fixtures are what pins the two backends to this deterministic, coercion-free ordering.)
  // Return that definite ordering directly: coercing the numeric side through `Number()` (as a naive
  // fallback would) truncates a 64-bit `bigint` and could collapse distinct keys, reintroducing SQL/TS
  // drift for both equality and ordering.
  if (leftText !== rightText) return leftText ? 1 : -1;

  // Both TEXT → SQLite BINARY collation (byte / code-unit comparison).
  if (leftText && rightText) {
    if (left < right) return -1;
    if (left > right) return 1;
    return 0;
  }

  // Both numeric → stay in the integer domain when both are integral, so keys past
  // Number.MAX_SAFE_INTEGER don't round together.
  const lb = asExactBigInt(left);
  const rb = asExactBigInt(right);
  if (lb !== undefined && rb !== undefined) return lb < rb ? -1 : lb > rb ? 1 : 0;
  // A `bigint` reaching here pairs with a non-integer real, where exact integer comparison is moot;
  // coerce it to a number so the operands share a type.
  const l = typeof left === "bigint" ? Number(left) : left;
  const r = typeof right === "bigint" ? Number(right) : right;
  if (l < r) return -1;
  if (l > r) return 1;
  return l === r ? 0 : Number.NaN;
}

/** The exact `bigint` for an integer-valued numeric scalar, or `undefined` when it isn't an integer
 *  (a real/`NaN` number, or a string) — the caller then compares via `Number` instead. */
function asExactBigInt(value: number | bigint | string): bigint | undefined {
  if (typeof value === "bigint") return value;
  if (typeof value === "number" && Number.isInteger(value)) return BigInt(value);
  return undefined;
}

/** True in SQL's CASE-WHEN / boolean sense, mirroring SQLite's numeric coercion: non-null, non-zero. */
function truthy(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (typeof value === "bigint") return value !== 0n;
  if (typeof value === "string") {
    // SQLite coerces a string to a number in a boolean context (`CASE WHEN '0'`/`'abc'` are false,
    // `'2abc'` is true via its leading numeric prefix). Mirror that so the TS backend cannot drift.
    const numeric = Number.parseFloat(value);
    return Number.isFinite(numeric) && numeric !== 0;
  }
  return true;
}

/**
 * Compile ONE derivation expression to a TS function computing the SAME value as {@link compileToSqlSelect}.
 * The function reads the base row for `col`, and — for `exists` — the `projections` argument for the
 * named projection's rows (the TS side of the projection-name seam). Both backends walk the SAME AST.
 */
export function compileToFn(expr: Expr): DerivationFn {
  const evalNode = (
    node: Expr,
    baseRow: BaseRow,
    projections: ProjectionRows,
    lookups: LookupRows,
    projRow?: Record<string, unknown>,
  ): unknown => {
    switch (node.kind) {
      case "lit":
        return node.value;
      case "col":
        return lookupColumn(baseRow, node.name);
      case "pcol":
        if (!projRow) throw new Error(`pcol("${node.name}") evaluated outside an EXISTS projection context`);
        return lookupColumn(projRow, node.name);
      case "rcol": {
        // Read the resolved row by the FOLDED alias: lookup aliases are identifier-validated and deduped
        // case-insensitively (SQLite folding), and the SQL `resolveRollupColumn` resolves `node.lookup`
        // through `foldSqlIdentifier` too, so a raw case-sensitive `lookups[node.lookup]` would let
        // `rcol("C", …)` pass validation against a lookup declared `as: "c"` yet fail here at runtime.
        // Read by OWN property (via {@link readOwn}) so an identifier-legal `__proto__` alias over a bare
        // `fnFor` caller's plain `{}` can't resolve `Object.prototype` (truthy) and bypass the guard below.
        const row = readOwn(lookups, foldSqlIdentifier(node.lookup));
        // Every declared lookup alias is resolved to a full row up front (a LEFT-JOIN miss becomes a
        // defaults/NULL-filled row, never an absent alias — see LookupRows). A missing alias here means a
        // raw `fnFor` caller skipped lookup resolution; fail loudly rather than silently reading NULL.
        if (!row) {
          throw new Error(
            `rcol("${node.lookup}", "${node.name}") evaluated without a resolved lookup row — ` +
              `use ReadModel.evaluate() (or pass the model's resolved lookups) instead of a bare fnFor call`,
          );
        }
        return lookupColumn(row, node.name);
      }
      case "compare":
        return compareValues(
          node.op,
          evalNode(node.left, baseRow, projections, lookups, projRow),
          evalNode(node.right, baseRow, projections, lookups, projRow),
        );
      case "and":
        return node.clauses.every((c) => truthy(evalNode(c, baseRow, projections, lookups, projRow)));
      case "or":
        return node.clauses.some((c) => truthy(evalNode(c, baseRow, projections, lookups, projRow)));
      case "not":
        return !truthy(evalNode(node.expr, baseRow, projections, lookups, projRow));
      case "isNull": {
        const v = evalNode(node.expr, baseRow, projections, lookups, projRow);
        return v === null || v === undefined;
      }
      case "case": {
        for (const w of node.whens) {
          if (truthy(evalNode(w.when, baseRow, projections, lookups, projRow))) {
            return evalNode(w.then, baseRow, projections, lookups, projRow);
          }
        }
        return evalNode(node.else, baseRow, projections, lookups, projRow);
      }
      case "exists": {
        // Read by OWN property so a projection literally named `__proto__` over a bare `fnFor` caller's
        // plain `{}` resolves to no rows (empty EXISTS) instead of the inherited `Object.prototype`.
        const rows = readOwn(projections, node.projection) ?? [];
        return rows.some((r) => truthy(evalNode(node.where, baseRow, projections, lookups, r)));
      }
    }
  };
  return (baseRow, projections = {}, lookups = {}) => evalNode(expr, baseRow, projections, lookups);
}

/** Resolve a column value the way SQLite resolves an identifier: an exact-key match first, then a
 *  case-insensitive fallback. SQLite folds ASCII identifier case even for quoted identifiers, so the
 *  VIEW's `col("Status")` binds to a table declared with column `status`; a plain case-sensitive JS
 *  `row["Status"]` would miss it and return null, breaking VIEW/TS parity on the no-edge fallback and on
 *  `keyField` correlation. Fold here so both backends read the same column. (A table cannot declare two
 *  columns differing only in case, so the fallback is unambiguous.) Returns `null` for a missing column,
 *  preserving the previous `?? null` contract. */
export function lookupColumn(row: Record<string, unknown>, name: string): unknown {
  if (Object.hasOwn(row, name)) return row[name] ?? null;
  const folded = name.toLowerCase();
  for (const key of Object.keys(row)) {
    if (key.toLowerCase() === folded) return row[key] ?? null;
  }
  return null;
}

/** Read a dictionary entry by OWN property only. A model-controlled identifier (a lookup alias or
 *  projection name) reaching a bare `fnFor` caller's plain-`{}` dictionary must not resolve an inherited
 *  prototype member: `dict["__proto__"]` / `dict["toString"]` on a `{}` return truthy `Object.prototype` /
 *  function values, which would slip past a `?? default` / missing-key guard and read from the prototype
 *  chain. The canonical resolved dictionaries are `Object.create(null)`, but this keeps the bare-caller
 *  path safe too (the sibling of the OWN-key checks in {@link lookupColumn}/{@link resolveCandidateRows}). */
function readOwn<T>(dict: Record<string, T>, key: string): T | undefined {
  return Object.hasOwn(dict, key) ? dict[key] : undefined;
}

/** Read a rollup lookup's candidate rows from the caller-supplied `lookupRows` dictionary by its alias,
 *  resolved the way SQLite folds identifiers: an exact OWN-key match first, then a case-insensitive
 *  OWN-key fallback (the sibling of {@link lookupColumn}). Lookup aliases are case-insensitive SQL
 *  identifiers — declared/deduped via `foldSqlIdentifier`, and `rcol` reads them folded — so candidates
 *  supplied under a different casing (e.g. `{ C: [...] }` for an alias declared `c`) must still be found;
 *  a raw case-sensitive `lookupRows[alias]` would silently treat them as "no candidates" and NULL/default-
 *  fill, drifting from the folded treatment everywhere else. OWN-key checks (not the prototype-walking
 *  `in`) also keep an identifier-legal `__proto__` alias from resolving to `Object.prototype` (inherited,
 *  non-array) and throwing in the caller's `.filter(...)`. */
function resolveCandidateRows(
  lookupRows: Record<string, ReadonlyArray<Record<string, unknown>>>,
  alias: string,
): ReadonlyArray<Record<string, unknown>> {
  if (Object.hasOwn(lookupRows, alias)) return lookupRows[alias];
  const folded = foldSqlIdentifier(alias);
  for (const key of Object.keys(lookupRows)) {
    if (foldSqlIdentifier(key) === folded) return lookupRows[key];
  }
  return [];
}

// ───────────────────────────────────────── defineReadModel ───────────────────────────────────────

/** The declarative read-model input passed to {@link defineReadModel}. */
export interface ReadModelDecl {
  /** The managed VIEW name (also the read-model identifier). */
  readonly name: string;
  /** The base table the VIEW selects from; the derived columns are functions of its rows. */
  readonly baseTable: string;
  /**
   * The derived columns: name → derivation expression. Each is authored ONCE and compiled to both a
   * SQLite select-list expression and a TS function.
   */
  readonly derive: Record<string, Expr>;
  /**
   * Optional: whether the managed VIEW re-exports the base columns (`base.*`) alongside the derived
   * ones. Defaults to true (a read model is usually the base row PLUS its derived columns).
   */
  readonly selectBaseColumns?: boolean;
  /**
   * Optional key-correlated ROLLUP LOOKUPS (ADR 0065, #468). Each declares a `LEFT JOIN <rollup> ON
   * <key>` so a derived column can read the rollup's `*_counts` columns for the base row via
   * {@link rcol}. This is the per-row half of the layering: the aggregate is single-sourced in
   * {@link defineRollup}; the read model consumes its columns for a `CASE`-style per-row signal (the
   * `plan_delivery`/`plan_wave_progress` shape). The join `on` must map the rollup's FULL group key so
   * the lookup is single-valued (no fan-out of base rows).
   */
  readonly lookups?: readonly RollupLookupDecl[];
}

/** One key-correlated rollup lookup on a {@link defineReadModel} (see {@link ReadModelDecl.lookups}). */
export interface RollupLookupDecl {
  /** The alias `rcol(alias, …)` reads this lookup's columns under (a SQL identifier). */
  readonly as: string;
  /** The rollup whose `*_counts` VIEW is joined (its `name` is the physical relation, its columns the
   *  readable set). Pass the {@link Rollup} object so the read model can validate referenced columns. */
  readonly rollup: Rollup;
  /**
   * The equi-join key: each `{ base, rollup }` pair equates a base column to a rollup group-key column.
   * Must cover the rollup's ENTIRE `groupBy` so the joined row is unique (≤1 match per base row).
   */
  readonly on: ReadonlyArray<{ readonly base: string; readonly rollup: string }>;
  /**
   * Optional per-column defaults substituted when the join misses (no matching rollup group) or the
   * rollup value is NULL — the `COALESCE(<alias>."col", <default>)` in the hand-authored VIEWs. Applied
   * identically in both backends so an epic with no PRs reads `0` rather than NULL.
   */
  readonly defaults?: Record<string, Literal>;
}

/** A compiled read model: the declaration plus its derived SQL, derived functions, and managed VIEW. */
export interface ReadModel {
  readonly decl: ReadModelDecl;
  /** Projection names referenced by any derived column's `exists` (for registry/validation). */
  readonly projectionNames: string[];
  /** The SQLite select-list expression for one derived column. */
  sqlSelectFor(column: string, options?: SqlCompileOptions): string;
  /** The TS derivation function for one derived column. */
  fnFor(column: string): DerivationFn;
  /** Evaluate ALL derived columns for a base row in-process (the TS backend of the whole model). The
   *  optional `lookupRows` supplies each rollup-lookup's candidate rows (keyed by lookup alias); the
   *  model resolves the single matching group row per lookup (applying declared defaults) before
   *  evaluating {@link rcol} references. */
  evaluate(
    baseRow: BaseRow,
    projections?: ProjectionRows,
    lookupRows?: Record<string, ReadonlyArray<Record<string, unknown>>>,
  ): Record<string, unknown>;
  /** Resolve each declared rollup lookup's single matching group row for `baseRow` (match on the join
   *  keys, fill declared defaults), producing the {@link LookupRows} a {@link DerivationFn} reads via
   *  {@link rcol}. The single source of the lookup-resolution rule: {@link evaluate} and the parity guard
   *  both call this so they can never drift. Throws if a lookup's candidate set yields MORE than one
   *  match for the join key — the lookup is required to be single-valued (its join covers the rollup's
   *  full group key), so multiple matches would fan out in SQL while TS silently picked one. */
  resolveLookups(
    baseRow: BaseRow,
    lookupRows: Record<string, ReadonlyArray<Record<string, unknown>>>,
  ): LookupRows;
  /** The managed `CREATE VIEW` DDL (seam (a) applies this at boot). Pass `{ temp: true }` to emit a
   *  `CREATE TEMP VIEW` in SQLite's TEMP schema (used by the parity guard so it never touches the
   *  application's real objects); the SELECT body is byte-identical either way. */
  viewDdl(options?: SqlCompileOptions, viewOptions?: ViewDdlOptions): string;
}

/** Shape modifiers for {@link ReadModel.viewDdl} (as opposed to the SQL compile options for its body). */
export interface ViewDdlOptions {
  /** Emit `CREATE TEMP VIEW` (SQLite TEMP schema) instead of a plain `CREATE VIEW`. */
  readonly temp?: boolean;
}

function collectProjectionNames(expr: Expr, into: Set<string>): void {
  switch (expr.kind) {
    case "exists":
      into.add(expr.projection);
      collectProjectionNames(expr.where, into);
      return;
    case "compare":
      collectProjectionNames(expr.left, into);
      collectProjectionNames(expr.right, into);
      return;
    case "and":
    case "or":
      for (const c of expr.clauses) collectProjectionNames(c, into);
      return;
    case "not":
      collectProjectionNames(expr.expr, into);
      return;
    case "isNull":
      collectProjectionNames(expr.expr, into);
      return;
    case "case":
      for (const w of expr.whens) {
        collectProjectionNames(w.when, into);
        collectProjectionNames(w.then, into);
      }
      collectProjectionNames(expr.else, into);
      return;
    default:
      return;
  }
}

/** Collect the base-row columns (`col`), per-projection columns (`pcol`, inside `exists`), and
 *  per-rollup-lookup columns (`rcol`) an expression references. Used by the parity guard to build
 *  fixture tables carrying every referenced column even when a sample supplies no rows for a
 *  projection/lookup. */
function collectColumns(
  expr: Expr,
  baseCols: Set<string>,
  projCols: Map<string, Set<string>>,
  lookupCols: Map<string, Set<string>>,
  currentProjection?: string,
): void {
  switch (expr.kind) {
    case "col":
      baseCols.add(expr.name);
      return;
    case "pcol":
      if (currentProjection) {
        const set = projCols.get(currentProjection) ?? new Set<string>();
        set.add(expr.name);
        projCols.set(currentProjection, set);
      }
      return;
    case "rcol": {
      // Canonicalize the bucket key case-insensitively (SQLite folds lookup aliases): a derivation using
      // rcol("C", …) must land in the SAME bucket as a lookup declared/seeded `as: "c"`, else the referenced
      // column is recorded under a divergent key and both consumers (the parity guard and the SQL TEMP
      // fixture builder, which fold on read) drop it — producing missing fixture columns / false parity
      // failures. Reuse an existing key whose folded form matches (e.g. the pre-seeded declared alias).
      const folded = foldSqlIdentifier(expr.lookup);
      let key = expr.lookup;
      for (const k of lookupCols.keys()) {
        if (foldSqlIdentifier(k) === folded) {
          key = k;
          break;
        }
      }
      const set = lookupCols.get(key) ?? new Set<string>();
      set.add(expr.name);
      lookupCols.set(key, set);
      return;
    }
    case "compare":
      collectColumns(expr.left, baseCols, projCols, lookupCols, currentProjection);
      collectColumns(expr.right, baseCols, projCols, lookupCols, currentProjection);
      return;
    case "and":
    case "or":
      for (const c of expr.clauses) collectColumns(c, baseCols, projCols, lookupCols, currentProjection);
      return;
    case "not":
      collectColumns(expr.expr, baseCols, projCols, lookupCols, currentProjection);
      return;
    case "isNull":
      collectColumns(expr.expr, baseCols, projCols, lookupCols, currentProjection);
      return;
    case "case":
      for (const w of expr.whens) {
        collectColumns(w.when, baseCols, projCols, lookupCols, currentProjection);
        collectColumns(w.then, baseCols, projCols, lookupCols, currentProjection);
      }
      collectColumns(expr.else, baseCols, projCols, lookupCols, currentProjection);
      return;
    case "exists": {
      if (!projCols.has(expr.projection)) projCols.set(expr.projection, new Set<string>());
      collectColumns(expr.where, baseCols, projCols, lookupCols, expr.projection);
      return;
    }
    default:
      return;
  }
}

/**
 * Declare a derived read model ONCE, as a pure derivation over a base row plus named canonical
 * projections. The returned {@link ReadModel} exposes both backends (SQL select-list + TS function)
 * and the managed VIEW DDL, all driven from the same AST so surface #2 (double-authoring) is closed.
 * Register it in the {@link readModelRegistry} to have the runtime apply its VIEW at boot (surface #3).
 */
export function defineReadModel(decl: ReadModelDecl): ReadModel {
  assertSqlIdentifier("read model name", decl.name);
  assertSqlIdentifier("base table", decl.baseTable);
  // SQLite forbids a VIEW and a table sharing one name, so a read model whose managed VIEW name equals
  // its base table would fail opaquely at provisioning (`ReadModelRegistry.ensureViews`) with a raw SQL
  // error. Reject it here, at declaration time, with an actionable message instead. Fold case first:
  // SQLite matches identifiers case-insensitively, so `name: "TASKS"` still collides with `baseTable: "tasks"`.
  if (foldSqlIdentifier(decl.name) === foldSqlIdentifier(decl.baseTable)) {
    throw new Error(
      `read model "${decl.name}" cannot share its name with its base table "${decl.baseTable}"; ` +
        `SQLite forbids a VIEW and a table having the same name, so the managed VIEW would fail to ` +
        `provision — give the read model a distinct name`,
    );
  }
  // Canonicalise the derived-column order (sort by name) so the managed VIEW DDL is independent of the
  // declaration object's key insertion order. `ReadModelRegistry.register` compares `viewDdl()` strings
  // for idempotency/conflict detection, so two declarations that differ only in `derive` key order must
  // produce byte-identical DDL — otherwise they would be flagged as conflicting definitions of the same
  // read model. Columns are accessed by name, so their SELECT order carries no semantic meaning.
  const columns = Object.keys(decl.derive).sort();
  if (columns.length === 0) {
    throw new Error(`read model "${decl.name}" declares no derived columns`);
  }
  for (const c of columns) assertSqlIdentifier("derived column", c);

  const projSet = new Set<string>();
  for (const c of columns) collectProjectionNames(decl.derive[c], projSet);
  for (const name of projSet) assertSqlIdentifier("projection name", name);

  // ── Rollup lookups (#468): validate the LEFT-JOIN key-lookups and build the alias → metadata map the
  // SQL `rcol` resolver and the TS row resolver share, so both backends read the same rollup columns. ──
  const lookups = decl.lookups ?? [];
  const baseAlias0 = DEFAULT_BASE_ALIAS;
  const lookupByAlias = new Map<string, RollupLookupDecl>();
  for (const lk of lookups) {
    assertSqlIdentifier("rollup lookup alias", lk.as);
    const key = foldSqlIdentifier(lk.as);
    if (lookupByAlias.has(key)) {
      throw new Error(`read model "${decl.name}" declares two rollup lookups under alias "${lk.as}"`);
    }
    if (key === foldSqlIdentifier(baseAlias0)) {
      throw new Error(
        `read model "${decl.name}" rollup lookup alias "${lk.as}" collides with the base alias; choose another`,
      );
    }
    if (lk.on.length === 0) throw new Error(`read model "${decl.name}" rollup lookup "${lk.as}" has an empty join key`);
    for (const pair of lk.on) {
      assertSqlIdentifier("lookup base column", pair.base);
      assertSqlIdentifier("lookup rollup column", pair.rollup);
    }
    // The join must cover the rollup's FULL group key, so the joined row is single-valued (no fan-out
    // of base rows). Compare the on-keys' rollup side against the rollup's declared groupBy set.
    const onRollupKeys = new Set(lk.on.map((p) => foldSqlIdentifier(p.rollup)));
    const groupKeys = new Set(lk.rollup.groupBy.map((g) => foldSqlIdentifier(g)));
    if (onRollupKeys.size !== groupKeys.size || [...groupKeys].some((g) => !onRollupKeys.has(g))) {
      throw new Error(
        `read model "${decl.name}" rollup lookup "${lk.as}" must join on the rollup's full group key ` +
          `[${lk.rollup.groupBy.join(", ")}] to stay single-valued; got [${lk.on.map((p) => p.rollup).join(", ")}]`,
      );
    }
    for (const dname of Object.keys(lk.defaults ?? {})) {
      if (!lk.rollup.outputColumns.includes(dname)) {
        throw new Error(
          `read model "${decl.name}" rollup lookup "${lk.as}" declares a default for "${dname}", ` +
            `not a column of rollup "${lk.rollup.projectionName}"`,
        );
      }
    }
    lookupByAlias.set(key, lk);
  }
  // Validate every `rcol(alias, name)` reference resolves to a declared lookup and a real rollup column.
  {
    const baseColsSeen = new Set<string>();
    const projColsSeen = new Map<string, Set<string>>();
    const lookupColsSeen = new Map<string, Set<string>>();
    for (const c of columns) collectColumns(decl.derive[c], baseColsSeen, projColsSeen, lookupColsSeen);
    for (const [alias, names] of lookupColsSeen) {
      const lk = lookupByAlias.get(foldSqlIdentifier(alias));
      if (!lk) {
        throw new Error(`read model "${decl.name}" references rollup-lookup alias "${alias}" with no matching lookup`);
      }
      for (const n of names) {
        if (!lk.rollup.outputColumns.includes(n)) {
          throw new Error(
            `read model "${decl.name}" reads rcol("${alias}", "${n}") but "${n}" is not a column of ` +
              `rollup "${lk.rollup.projectionName}" [${lk.rollup.outputColumns.join(", ")}]`,
          );
        }
      }
    }
  }

  const resolveRollupColumn = (alias: string, name: string): string => {
    const lk = lookupByAlias.get(foldSqlIdentifier(alias));
    if (!lk) throw new Error(`read model "${decl.name}" has no rollup lookup "${alias}"`);
    const qualified = `${quoteIdent(alias)}.${quoteIdent(name)}`;
    const dflt = lk.defaults?.[name];
    return dflt === undefined ? qualified : `COALESCE(${qualified}, ${sqlLiteral(dflt)})`;
  };
  const withLookupResolver = (options?: SqlCompileOptions): SqlCompileOptions =>
    lookups.length === 0
      ? (options ?? {})
      : { ...options, resolveRollupColumn: options?.resolveRollupColumn ?? resolveRollupColumn };

  const sqlSelectFor = (column: string, options?: SqlCompileOptions): string => {
    const expr = decl.derive[column];
    if (!expr) throw new Error(`read model "${decl.name}" has no derived column "${column}"`);
    return compileToSqlSelect(expr, withLookupResolver(options));
  };
  const fnCache = new Map<string, DerivationFn>();
  const fnFor = (column: string): DerivationFn => {
    const expr = decl.derive[column];
    if (!expr) throw new Error(`read model "${decl.name}" has no derived column "${column}"`);
    let fn = fnCache.get(column);
    if (!fn) {
      fn = compileToFn(expr);
      fnCache.set(column, fn);
    }
    return fn;
  };

  const viewDdl = (options?: SqlCompileOptions, viewOptions?: ViewDdlOptions): string => {
    const baseAlias = resolveBaseAlias(options?.baseAlias);
    const selectBase = decl.selectBaseColumns !== false;
    const derived = columns.map((c) => `${sqlSelectFor(c, options)} AS ${quoteIdent(c)}`);
    const selectList = [...(selectBase ? [`${quoteIdent(baseAlias)}.*`] : []), ...derived].join(",\n  ");
    const createView = viewOptions?.temp ? "CREATE TEMP VIEW IF NOT EXISTS" : "CREATE VIEW IF NOT EXISTS";
    // One `LEFT JOIN <rollup> ON <baseKey> = <rollupKey> …` per declared lookup, in declaration order so
    // the DDL is deterministic. The rollup's `*_counts` VIEW is joined by name (its physical relation).
    const joins = lookups.map((lk) => {
      const on = lk.on
        .map((p) => `${quoteIdent(baseAlias)}.${quoteIdent(p.base)} = ${quoteIdent(lk.as)}.${quoteIdent(p.rollup)}`)
        .join(" AND ");
      return `LEFT JOIN ${quoteIdent(lk.rollup.projectionName)} ${quoteIdent(lk.as)} ON ${on}`;
    });
    const fromClause = [`FROM ${quoteIdent(decl.baseTable)} ${quoteIdent(baseAlias)}`, ...joins].join("\n");
    return `${createView} ${quoteIdent(decl.name)} AS\n` + `SELECT\n  ${selectList}\n` + `${fromClause};`;
  };

  const resolveLookupRows = (
    baseRow: BaseRow,
    lookupRows: Record<string, ReadonlyArray<Record<string, unknown>>>,
  ): LookupRows => {
    // Null-prototype dictionary: lookup aliases are only identifier-validated, so an alias like
    // `__proto__` must set a plain own property rather than trip the magic prototype setter a normal
    // `{}` inherits from `Object.prototype` (same treatment as `evaluate()`'s derived-output map below).
    const resolved: LookupRows = Object.create(null);
    for (const lk of lookups) {
      // Read candidates by the lookup's alias via {@link resolveCandidateRows}: an OWN-property check
      // (so an identifier-legal `__proto__` alias over a plain `{}` can't resolve `lookupRows["__proto__"]`
      // to `Object.prototype` — inherited, truthy, non-array — and throw in the `.filter(...)` below), plus
      // a case-insensitive fallback so a caller supplying candidates under a different casing (e.g.
      // `{ C: [...] }` for an alias declared `c`) is still matched, mirroring the folded alias treatment
      // used by `rcol`, the resolved-row keying below, and the SQL LEFT JOIN.
      const candidates = resolveCandidateRows(lookupRows, lk.as);
      const matches = candidates.filter((r) =>
        lk.on.every((p) => compareValues("eq", lookupColumn(baseRow, p.base), lookupColumn(r, p.rollup))),
      );
      // The join covers the rollup's full group key, so a well-formed rollup yields at most one row per
      // key. More than one match means the candidate set is not single-valued: SQL's LEFT JOIN would fan
      // out to multiple rows while this TS resolver would silently keep one — the exact drift the parity
      // guard exists to prevent. Fail loudly instead.
      if (matches.length > 1) {
        throw new Error(
          `read model "${decl.name}" rollup lookup "${lk.as}" matched ${matches.length} rows for the ` +
            `join key — a lookup must be single-valued (its join covers the rollup's full group key)`,
        );
      }
      const match = matches[0];
      // Build one resolved row over EVERY rollup output column so `rcol` reads a stable object; a
      // missing/NULL value falls back to the declared default (the `COALESCE(alias.col, default)` twin).
      const row: Record<string, unknown> = Object.create(null);
      for (const name of lk.rollup.outputColumns) {
        const raw = match ? lookupColumn(match, name) : null;
        const dflt = lk.defaults?.[name];
        row[name] = raw === null || raw === undefined ? (dflt === undefined ? null : dflt) : raw;
      }
      resolved[foldSqlIdentifier(lk.as)] = row;
    }
    return resolved;
  };

  return {
    decl,
    projectionNames: [...projSet],
    sqlSelectFor,
    fnFor,
    resolveLookups: resolveLookupRows,
    evaluate: (baseRow, projections, lookupRows) => {
      // Derived column names are user-controlled and only identifier-validated, so a name like
      // `__proto__` must set a plain own property rather than trip the magic prototype setter a
      // normal `{}` inherits from `Object.prototype` (same null-prototype treatment as the
      // untrusted-key dictionaries elsewhere in this repo, e.g. `core/logger.ts`).
      const out: Record<string, unknown> = Object.create(null);
      const resolvedLookups = resolveLookupRows(baseRow, lookupRows ?? {});
      for (const c of columns) out[c] = fnFor(c)(baseRow, projections, resolvedLookups);
      return out;
    },
    viewDdl,
  };
}

/** Convenience alias for {@link ReadModel.viewDdl} — the framework-derived managed VIEW DDL. */
export function deriveReadModelViewDdl(model: ReadModel, options?: SqlCompileOptions): string {
  return model.viewDdl(options);
}

// ────────────────────────────────────────── Read-model registry ──────────────────────────────────

/**
 * The read-model registry (seam (a)). Sidecars/apps register a {@link ReadModel}; the runtime boot
 * path applies every registered model's managed VIEW to the app's data source (see
 * `core/modules/workers.ts`). Idempotent: re-registering the same name whose VIEW DDL matches is a
 * no-op; a conflicting redefinition throws so two definitions cannot silently claim one name.
 */
export class ReadModelRegistry {
  readonly #byName = new Map<string, ReadModel>();

  register(model: ReadModel): void {
    const key = foldSqlIdentifier(model.decl.name);
    const existing = this.#byName.get(key);
    if (existing) {
      if (existing.decl.name !== model.decl.name) {
        // Case-only variant (e.g. "TASKS" vs "tasks"). SQLite folds VIEW names, so both would collide
        // at `ensureViews`; reject the collision here with an actionable error instead.
        throw new Error(
          `read model "${model.decl.name}" already registered as "${existing.decl.name}"; SQLite folds ` +
            `identifiers case-insensitively, so names differing only in case denote one VIEW`,
        );
      }
      if (existing.viewDdl() !== model.viewDdl()) {
        throw new Error(`read model "${model.decl.name}" already registered with a different definition`);
      }
      return;
    }
    this.#byName.set(key, model);
  }

  all(): ReadModel[] {
    return [...this.#byName.values()];
  }

  get(name: string): ReadModel | undefined {
    return this.#byName.get(foldSqlIdentifier(name));
  }

  /** Apply every registered model's managed VIEW to a database (the boot-path entry point). Safe to
   *  call repeatedly and it is truly MANAGED: each VIEW is dropped and recreated so a changed
   *  read-model definition in code always replaces a stale VIEW body (a plain `CREATE VIEW IF NOT
   *  EXISTS` would leave the SQL backend running an old definition, reintroducing backend drift).
   *  Referenced base/projection tables need not exist yet — SQLite only resolves a VIEW's body when
   *  it is queried.
   *
   *  The DROP is `main.`-qualified on purpose: an unqualified `DROP VIEW IF EXISTS "name"` resolves
   *  TEMP first, so a stray TEMP view of the same name (e.g. leaked from a parity-guard run on a
   *  long-lived handle) would be dropped INSTEAD of the managed `main` view — and the following
   *  `CREATE VIEW IF NOT EXISTS` would then no-op against the surviving `main` view, leaving a stale
   *  managed body in production. Qualifying to `main` drops exactly the managed view we recreate. */
  ensureViews(db: { exec(sql: string): void }, options?: SqlCompileOptions): void {
    for (const model of this.#byName.values()) {
      db.exec(`DROP VIEW IF EXISTS main.${quoteIdent(model.decl.name)};`);
      db.exec(model.viewDdl(options));
    }
  }

  clear(): void {
    this.#byName.clear();
  }
}

/**
 * Process-wide read-model registry — the concrete registration point. The `writer-source-inversion`
 * task registers its derived status-edge read model here so the runtime provisions its VIEW at boot.
 */
export const readModelRegistry = new ReadModelRegistry();

// ─────────────────────────────────────────── Parity guard ────────────────────────────────────────

/** A single parity check case: a base row, the projection rows in scope for it, and (for a read model
 *  with rollup lookups) the candidate rollup rows per lookup alias. */
export interface ParitySample {
  readonly baseRow: BaseRow;
  readonly projections?: ProjectionRows;
  /** Candidate rows for each declared rollup lookup, keyed by lookup alias (see {@link rcol}). The
   *  guard inserts them into the lookup rollup's fixture table so the VIEW's `LEFT JOIN` materialises,
   *  and hands the same rows to the TS backend to resolve — closing the lookup's parity surface. */
  readonly lookups?: Record<string, ReadonlyArray<Record<string, unknown>>>;
}

/** The seam a parity guard needs to run the SQL backend: a SQLite handle it can create/query/drop. */
export interface ParityDb {
  exec(sql: string): void;
  all<T = Record<string, unknown>>(sql: string, params?: unknown[]): T[];
  run(sql: string, params?: unknown[]): { changes: number; lastInsertRowid: number | bigint };
}

/** Options for {@link assertReadModelParity}. */
export interface ParityOptions {
  /** Only check these derived columns (defaults to all). */
  readonly columns?: string[];
  /** A failure sink; defaults to throwing an `Error`. */
  readonly onMismatch?: (message: string) => never;
  /**
   * The SAME SQL compile options used to provision the runtime VIEW (e.g. a custom
   * `resolveProjectionTable` or `baseAlias`). Threaded through so the guard builds fixtures and
   * materialises the VIEW against the same physical projection tables the runtime uses — otherwise a
   * caller with a custom resolver would test a different VIEW than production and get false mismatches.
   */
  readonly sql?: SqlCompileOptions;
}

function defaultOnMismatch(message: string): never {
  throw new Error(message);
}

function normaliseSqlValue(value: unknown): unknown {
  // SQLite has no boolean type — booleans round-trip as 0/1. Normalise the TS side to match so a
  // `true`/`1` pair is parity, not a spurious mismatch.
  if (typeof value === "boolean") return value ? 1 : 0;
  if (value === undefined) return null;
  // A SQLite INTEGER can surface as `number` on one side (when it fits) and `bigint` on the other,
  // depending on the driver — the comparison below is `Object.is`, so `1n` vs `1` would be a spurious
  // mismatch. Collapse a LOSSLESS `bigint` (one that round-trips exactly through `Number`, i.e. within
  // safe-integer range) to `number`. A `bigint` past 2^53 is kept EXACT — narrowing it would collapse
  // two distinct 64-bit keys and mask a real divergence (mirrors the exactness `orderable` preserves).
  if (typeof value === "bigint" && BigInt(Number(value)) === value) return Number(value);
  return value;
}

function formatParityValue(value: unknown): string {
  // `JSON.stringify` throws a TypeError on `bigint`, which a derived INTEGER > 2^53 can reach this
  // path as. Format it explicitly so the guard always reports the parity mismatch instead of masking
  // it with a serialisation error.
  if (typeof value === "bigint") return `${value}n`;
  return JSON.stringify(value);
}

/**
 * The framework PARITY GUARD (surface #3). Given a compiled read model and sample base+projection
 * rows, it materialises the managed VIEW over throwaway in-memory tables, reads the SQL-derived
 * value for each column, computes the TS-function value for the same inputs, and asserts they agree —
 * so an app no longer hand-writes a bespoke parity test per projection. Throws (or calls
 * `onMismatch`) on the first divergence, naming the column, sample index, and both values.
 *
 * The caller supplies a SQLite handle (e.g. an in-memory DB from the node/deno host). The guard
 * builds minimal fixture tables for the base table and each referenced projection from the sample
 * rows' own keys — entirely in SQLite's TEMP schema (`CREATE TEMP TABLE`/`CREATE TEMP VIEW`, dropped
 * `temp.`-qualified) — so it needs no pre-existing schema AND can never clobber real application
 * tables/views the caller's DB happens to hold under the same names.
 */
export function assertReadModelParity(
  model: ReadModel,
  db: ParityDb,
  samples: ParitySample[],
  options: ParityOptions = {},
): void {
  const onMismatch = options.onMismatch ?? defaultOnMismatch;
  const columns = options.columns ?? Object.keys(model.decl.derive);
  // Resolve projection NAMES to physical tables with the SAME resolver (and identifier validation) the
  // SQL compiler uses, so the guard's fixtures line up with the VIEW it materialises below.
  const resolveTable = options.sql?.resolveProjectionTable ?? ((n: string) => projectionRegistry.sqlTableFor(n));

  // Validate the requested columns up front so an unknown name yields an actionable error rather than
  // a downstream `undefined` blowing up inside `collectColumns`/`fnFor`.
  for (const c of columns) {
    if (!Object.prototype.hasOwnProperty.call(model.decl.derive, c)) {
      throw new Error(`read model "${model.decl.name}" has no derived column "${c}" to check parity for`);
    }
  }

  // Collect the union of base columns, per-projection columns, and per-rollup-lookup columns across all
  // samples, so the fixture tables carry every referenced column. Seed from the AST first so a
  // projection/lookup referenced by the derivation always has its columns even when a sample supplies
  // no rows for it.
  const lookups = model.decl.lookups ?? [];
  const baseCols = new Set<string>();
  const projCols = new Map<string, Set<string>>();
  const lookupColsByAlias = new Map<string, Set<string>>();
  for (const name of model.projectionNames) projCols.set(name, new Set());
  for (const lk of lookups) {
    // Seed each lookup fixture with its join keys (so the LEFT JOIN's ON columns exist) even if no
    // `rcol` reads them, plus every column that carries a declared default.
    const set = new Set<string>();
    for (const p of lk.on) set.add(p.rollup);
    for (const d of Object.keys(lk.defaults ?? {})) set.add(d);
    lookupColsByAlias.set(lk.as, set);
  }
  for (const c of columns) collectColumns(model.decl.derive[c], baseCols, projCols, lookupColsByAlias);
  for (const s of samples) {
    for (const k of Object.keys(s.baseRow)) baseCols.add(k);
    for (const [pname, rows] of Object.entries(s.projections ?? {})) {
      // Only widen fixtures for projections the model actually references; a sample may carry extra
      // projections the read model never reads, and those get no fixture table (see insert loop below).
      const set = projCols.get(pname);
      if (!set) continue;
      for (const r of rows) for (const k of Object.keys(r)) set.add(k);
    }
    // Widen each DECLARED lookup's fixture from the sample's candidate rows read via
    // {@link resolveCandidateRows} — the same case-insensitive OWN-key resolution `resolveLookups` uses
    // (line ~1009) — so a sample supplying candidates under a different casing (e.g. `{ C: [...] }` for a
    // lookup declared `as: "c"`) still widens the right fixture instead of being silently ignored (which
    // would later insert nothing and fail parity for a non-parity reason). Keyed off `lookups`, not the
    // sample's keys, so it mirrors the resolver exactly.
    for (const lk of lookups) {
      const set = lookupColsByAlias.get(lk.as);
      if (!set) continue;
      for (const r of resolveCandidateRows(s.lookups ?? {}, lk.as)) for (const k of Object.keys(r)) set.add(k);
    }
  }

  const baseTable = model.decl.baseTable;
  const createFixture = (table: string, cols: Set<string>): void => {
    const colList = [...cols];
    // A degenerate fixture with no columns still needs a placeholder so the table is creatable.
    // TEMP tables live in SQLite's `temp` schema and shadow same-named objects in `main`, so the
    // guard never touches (nor can it clobber) the application's real base/projection tables.
    const ddl = colList.length
      ? `CREATE TEMP TABLE ${quoteIdent(table)} (${colList.map((c) => quoteIdent(c)).join(", ")});`
      : `CREATE TEMP TABLE ${quoteIdent(table)} (_placeholder);`;
    db.exec(ddl);
  };

  // Resolve each projection name to its physical fixture table (validated), rejecting a many-to-one
  // mapping up front so the guard never creates/drops one table twice for a non-parity reason.
  const projectionTables = new Map<string, string>();
  const tableOwner = new Map<string, string>();
  for (const name of model.projectionNames) {
    const table = assertSqlIdentifier("projection table", resolveTable(name));
    // A projection resolving to the base table's physical name is a mapping bug: the guard fabricates an
    // isolated fixture per relation, so it would `CREATE TEMP TABLE` (and later drop/insert) the base
    // table twice and fail for a non-parity reason. Reject it up front (mirrors the many-to-one check).
    // Case-fold: SQLite treats `"Tasks"` and `"tasks"` as the same physical table.
    if (foldSqlIdentifier(table) === foldSqlIdentifier(baseTable)) {
      throw new Error(
        `read model "${model.decl.name}" maps projection "${name}" to its base table "${baseTable}"; ` +
          `each projection needs a distinct sqlTable so the parity guard can build an isolated fixture ` +
          `for it`,
      );
    }
    // Two distinct projection names resolving to ONE physical table is a mapping bug: the guard would
    // otherwise `CREATE TABLE` (and later drop/insert) that table twice and fail for a non-parity
    // reason. Reject it up front with an actionable error instead (mirrors the column check above).
    // Key the ownership map by the case-folded table so `"Foo"` and `"foo"` are recognised as one.
    const tableKey = foldSqlIdentifier(table);
    const owner = tableOwner.get(tableKey);
    if (owner !== undefined && owner !== name) {
      throw new Error(
        `read model "${model.decl.name}" maps projections "${owner}" and "${name}" to the same ` +
          `physical table "${table}"; each projection needs a distinct sqlTable so the parity guard ` +
          `can build an isolated fixture for it`,
      );
    }
    tableOwner.set(tableKey, name);
    projectionTables.set(name, table);
  }

  // Resolve each rollup lookup's fixture table (its rollup's physical relation name). Reject a lookup
  // relation colliding with the base table or another lookup/projection, so the guard fabricates one
  // isolated fixture per relation (mirrors the projection checks above).
  const lookupTables = new Map<string, string>(); // alias -> relation
  for (const lk of lookups) {
    const table = assertSqlIdentifier("rollup lookup relation", lk.rollup.projectionName);
    const tableKey = foldSqlIdentifier(table);
    if (tableKey === foldSqlIdentifier(baseTable)) {
      throw new Error(
        `read model "${model.decl.name}" rollup lookup "${lk.as}" resolves to its base table "${baseTable}"; ` +
          `a lookup needs a distinct relation so the parity guard can build an isolated fixture for it`,
      );
    }
    const owner = tableOwner.get(tableKey);
    if (owner !== undefined) {
      throw new Error(
        `read model "${model.decl.name}" rollup lookup "${lk.as}" shares the physical relation "${table}" ` +
          `with "${owner}"; each lookup needs a distinct relation for an isolated parity fixture`,
      );
    }
    tableOwner.set(tableKey, lk.as);
    lookupTables.set(lk.as, table);
  }
  // Drop/create every fixture through this single helper so the pre-check reset (leaked objects from
  // an earlier call) and the post-check teardown (below) can never drift apart. Schema-qualified with
  // `temp.` so an unqualified name can never resolve to — and delete — a real `main` table/view.
  const dropFixtures = (): void => {
    db.exec(`DROP VIEW IF EXISTS temp.${quoteIdent(model.decl.name)};`);
    db.exec(`DROP TABLE IF EXISTS temp.${quoteIdent(baseTable)};`);
    for (const table of projectionTables.values()) db.exec(`DROP TABLE IF EXISTS temp.${quoteIdent(table)};`);
    for (const table of lookupTables.values()) db.exec(`DROP TABLE IF EXISTS temp.${quoteIdent(table)};`);
  };

  const insertRow = (table: string, row: Record<string, unknown>): void => {
    const keys = Object.keys(row);
    if (keys.length === 0) {
      // A keyless row (e.g. `{ baseRow: {} }`) still represents one input row: the fixture always
      // carries at least a `_placeholder` column, so `DEFAULT VALUES` materialises it and the VIEW
      // sees a row. Skipping it would leave the VIEW empty and fail parity for a non-parity reason.
      db.run(`INSERT INTO ${quoteIdent(table)} DEFAULT VALUES;`);
      return;
    }
    const placeholders = keys.map(() => "?").join(", ");
    db.run(
      `INSERT INTO ${quoteIdent(table)} (${keys.map((k) => quoteIdent(k)).join(", ")}) VALUES (${placeholders});`,
      keys.map((k) => normaliseSqlValue(row[k])),
    );
  };

  // Fresh fixtures in the TEMP schema. Drop first so the guard can be called repeatedly on one DB
  // without clobbering the caller's application data, and ALWAYS drop again in `finally` so leftover
  // TEMP objects can never shadow the caller's real `main` tables/view after the guard returns/throws.
  dropFixtures();
  try {
    createFixture(baseTable, baseCols);
    for (const [name, table] of projectionTables) createFixture(table, projCols.get(name) ?? new Set());
    for (const [alias, table] of lookupTables) createFixture(table, lookupColsByAlias.get(alias) ?? new Set());
    db.exec(model.viewDdl(options.sql, { temp: true }));

    samples.forEach((sample, idx) => {
      // Reset fixture data for this isolated sample.
      db.run(`DELETE FROM ${quoteIdent(baseTable)};`);
      for (const table of projectionTables.values()) db.run(`DELETE FROM ${quoteIdent(table)};`);
      for (const table of lookupTables.values()) db.run(`DELETE FROM ${quoteIdent(table)};`);
      insertRow(baseTable, sample.baseRow);
      for (const [pname, rows] of Object.entries(sample.projections ?? {})) {
        // Ignore projections the model never references — no fixture table exists for them, and they
        // cannot affect any derived column, so inserting would fail the guard for a non-parity reason.
        const table = projectionTables.get(pname);
        if (!table) continue;
        for (const r of rows) insertRow(table, r);
      }
      // Insert each DECLARED lookup's candidate rows read via {@link resolveCandidateRows} — the same
      // case-insensitive OWN-key resolution `resolveLookups` uses below — so candidates supplied under a
      // different casing (e.g. `{ C: [...] }` for a lookup declared `as: "c"`) reach the SQL fixture the
      // VIEW's LEFT JOIN reads, instead of being dropped by an exact-key `sample.lookups[alias]` lookup and
      // failing parity for a non-parity reason. Keyed off `lookups`, mirroring the resolver.
      for (const lk of lookups) {
        const table = lookupTables.get(lk.as);
        if (!table) continue;
        for (const r of resolveCandidateRows(sample.lookups ?? {}, lk.as)) insertRow(table, r);
      }

      // Read the SQL-derived values straight from the managed VIEW — the VIEW body already computes
      // each derived column, so this exercises the exact DDL the framework emits (not a recompiled copy).
      const derivedList = columns.map((c) => quoteIdent(c)).join(", ");
      const sqlRows = db.all<Record<string, unknown>>(
        `SELECT ${derivedList} FROM ${quoteIdent(model.decl.name)};`,
      );
      const sqlRow = sqlRows[0] ?? {};
      // Resolve each rollup lookup's single matching row (match on the join keys, fill declared
      // defaults) via the model's OWN resolver — the single source of the lookup-resolution rule (incl.
      // the single-valued/no-fan-out guard). Done here (rather than via `model.evaluate`) so a test that
      // overrides `model.fnFor` to inject drift still drives the compared TS value.
      const resolvedLookups = model.resolveLookups(sample.baseRow, sample.lookups ?? {});
      for (const c of columns) {
        const sqlValue = normaliseSqlValue(sqlRow[c]);
        const fnValue = normaliseSqlValue(model.fnFor(c)(sample.baseRow, sample.projections, resolvedLookups));
        if (!Object.is(sqlValue, fnValue)) {
          onMismatch(
            `read-model parity mismatch in "${model.decl.name}".${c} (sample #${idx}): ` +
              `SQL=${formatParityValue(sqlValue)} vs TS=${formatParityValue(fnValue)}`,
          );
        }
      }
    });
  } finally {
    dropFixtures();
  }
}

// ═══════════════════════════════════════════ Rollups (#468) ══════════════════════════════════════
//
// A ROLLUP is the declare-once GROUP-BY sibling of `defineReadModel`: the same "one closed AST, two
// backends that cannot drift" discipline, but for an AGGREGATE projection. `defineRollup` compiles a
// group spec to BOTH a managed `*_counts` SQLite VIEW and an in-process TS group-reduce, registers the
// result as a canonical projection (so a read model can `LEFT JOIN` it via a rollup lookup — see
// `ReadModelDecl.lookups`), and is parity-guarded by `assertRollupParity` exactly as per-row read
// models are by `assertReadModelParity`.
//
// The aggregate op set is CLOSED and FLAT (D2): count / countWhere / max / minWhere / coalesce / add —
// exactly the ops the hand-authored plan-family VIEWs use, no general expression engine. Predicates
// inside countWhere/minWhere reuse the same closed {@link Expr} DSL (compare/and/or/not/isNull/case
// over `col`), so they compile to both backends through the shared `compileToSqlSelect`/`compileToFn`.

// ──────────────────────────────────────── Aggregate AST (D2) ─────────────────────────────────────

/** A closed, flat GROUP-BY aggregate expression (D2). `coalesce`/`add` wrap other aggregates so the
 *  exact `COALESCE(MIN(…), MAX(…))` and `MAX(…)+1` shapes the plan VIEWs use are expressible; every
 *  variant is handled exhaustively by both backends (SQL + TS reduce). */
export type AggExpr = CountAgg | CountWhereAgg | MaxAgg | MinWhereAgg | CoalesceAgg | AddAgg;

export interface CountAgg {
  readonly kind: "count";
  /** When set, `COUNT(col)` (non-NULL rows); omitted → `COUNT(*)` (all group rows). */
  readonly column?: string;
}
export interface CountWhereAgg {
  readonly kind: "countWhere";
  /** `SUM(CASE WHEN pred THEN 1 ELSE 0 END)` — count of group rows satisfying the closed predicate. */
  readonly pred: Expr;
}
export interface MaxAgg {
  readonly kind: "max";
  readonly column: string;
}
export interface MinWhereAgg {
  readonly kind: "minWhere";
  /** `MIN(CASE WHEN pred THEN col END)` — min of `col` over rows satisfying `pred` (NULL if none). */
  readonly column: string;
  readonly pred: Expr;
}
export interface CoalesceAgg {
  readonly kind: "coalesce";
  readonly a: AggExpr;
  readonly b: AggExpr;
}
export interface AddAgg {
  readonly kind: "add";
  readonly expr: AggExpr;
  /** An INTEGER literal added to `expr` (e.g. `MAX(wave) + 1`). NULL + literal is NULL, both backends. */
  readonly literal: number;
}

/** `COUNT(col)` (non-NULL) when `column` is given, else `COUNT(*)`. */
export const count = (column?: string): CountAgg => (column === undefined ? { kind: "count" } : { kind: "count", column });
/** `SUM(CASE WHEN pred THEN 1 ELSE 0 END)` — the count of group rows satisfying `pred`. */
export const countWhere = (pred: Expr): CountWhereAgg => ({ kind: "countWhere", pred });
/** `MAX(col)` over the group (ignores NULLs; NULL for an all-NULL/empty group). */
export const max = (column: string): MaxAgg => ({ kind: "max", column });
/** `MIN(CASE WHEN pred THEN col END)` — the min of `col` over group rows satisfying `pred`. */
export const minWhere = (column: string, pred: Expr): MinWhereAgg => ({ kind: "minWhere", column, pred });
/** `COALESCE(a, b)` over two aggregates — `a` unless it is NULL, then `b`. */
export const coalesce = (a: AggExpr, b: AggExpr): CoalesceAgg => ({ kind: "coalesce", a, b });
/** `expr + <integer literal>` (e.g. `MAX(wave) + 1`). Rejects a non-integer literal at build time. */
export const add = (expr: AggExpr, literal: number): AddAgg => {
  if (!Number.isInteger(literal)) throw new Error(`add() literal must be an integer, got ${literal}`);
  return { kind: "add", expr, literal };
};

/** Reject an {@link Expr} that has no meaning in a rollup predicate context (no correlated projection
 *  or lookup exists there): `exists`/`pcol`/`rcol`. Keeps the rollup's predicate surface closed. */
function assertRollupPredicate(where: string, expr: Expr): void {
  switch (expr.kind) {
    case "exists":
      throw new Error(`${where}: exists(...) is not valid in a rollup predicate`);
    case "pcol":
      throw new Error(`${where}: pcol(...) is not valid in a rollup predicate`);
    case "rcol":
      throw new Error(`${where}: rcol(...) is not valid in a rollup predicate`);
    case "compare":
      assertRollupPredicate(where, expr.left);
      assertRollupPredicate(where, expr.right);
      return;
    case "and":
    case "or":
      for (const c of expr.clauses) assertRollupPredicate(where, c);
      return;
    case "not":
    case "isNull":
      assertRollupPredicate(where, expr.expr);
      return;
    case "case":
      for (const w of expr.whens) {
        assertRollupPredicate(where, w.when);
        assertRollupPredicate(where, w.then);
      }
      assertRollupPredicate(where, expr.else);
      return;
    default:
      return;
  }
}

/** Collect the source-row column names an aggregate references (its `column` plus any predicate cols),
 *  used to seed fixture tables and to validate a rollup's non-join source references. */
function collectAggColumns(agg: AggExpr, into: Set<string>): void {
  switch (agg.kind) {
    case "count":
      if (agg.column !== undefined) into.add(agg.column);
      return;
    case "max":
      into.add(agg.column);
      return;
    case "countWhere": {
      const proj = new Map<string, Set<string>>();
      collectColumns(agg.pred, into, proj, new Map());
      return;
    }
    case "minWhere": {
      into.add(agg.column);
      const proj = new Map<string, Set<string>>();
      collectColumns(agg.pred, into, proj, new Map());
      return;
    }
    case "coalesce":
      collectAggColumns(agg.a, into);
      collectAggColumns(agg.b, into);
      return;
    case "add":
      collectAggColumns(agg.expr, into);
      return;
  }
}

// ─────────────────────────────────────────── Rollup sources ──────────────────────────────────────

/** The relation a rollup groups over. `table`/`projection`/`rollup` expose their columns by name; a
 *  key-`join` exposes a FLAT namespace mapped by {@link RollupJoinSource.columns} (the two-hop reach —
 *  D4). All three are single-mechanism composable: a `rollup` source is another {@link Rollup}. */
export type RollupSource = RollupTableSource | RollupProjectionSource | RollupJoinSource | RollupRollupSource;

export interface RollupTableSource {
  readonly kind: "table";
  readonly table: string;
}
export interface RollupProjectionSource {
  readonly kind: "projection";
  readonly projection: string;
}
/** One relation in a {@link RollupJoinSource} — a base table/view/projection under a join alias. */
export interface RollupRelation {
  readonly relation: string;
  readonly alias: string;
}
export interface RollupJoinSource {
  readonly kind: "join";
  /** `"left"` (default) or `"inner"`. LEFT keeps unmatched left rows with NULL right columns. */
  readonly type?: "left" | "inner";
  readonly left: RollupRelation;
  readonly right: RollupRelation;
  /** Equi-join key(s): `left.<left> = right.<right>`. */
  readonly on: ReadonlyArray<{ readonly left: string; readonly right: string }>;
  /**
   * The FLAT output namespace: output column name → `[side, physicalColumn]`. This resolves collisions
   * (both sides may have a `status`) and is what `groupBy`/aggregate `col(...)` references resolve
   * against, so the closed predicate/aggregate machinery is reused unchanged over a join.
   */
  readonly columns: Record<string, readonly [side: "left" | "right", column: string]>;
}
export interface RollupRollupSource {
  readonly kind: "rollup";
  readonly rollup: Rollup;
}

/** A rollup over a base table. */
export const fromTable = (table: string): RollupTableSource => ({ kind: "table", table });
/** A rollup over a canonical projection (resolved to its physical relation via {@link projectionRegistry}). */
export const fromProjection = (projection: string): RollupProjectionSource => ({ kind: "projection", projection });
/** A rollup over another rollup's `*_counts` VIEW (composable — e.g. wave's two levels). */
export const fromRollup = (rollup: Rollup): RollupRollupSource => ({ kind: "rollup", rollup });
/** A rollup over a declared key-join of two relations (the two-hop reach — D4). */
export const joinSource = (spec: Omit<RollupJoinSource, "kind">): RollupJoinSource => ({ kind: "join", ...spec });

/** The in-memory rows the TS group-reduce sees per LEAF relation (base table/view/projection name). */
export type RollupInputs = Record<string, ReadonlyArray<Record<string, unknown>>>;

// ───────────────────────────────────────────── defineRollup ──────────────────────────────────────

/** The declarative rollup input passed to {@link defineRollup}. */
export interface RollupDecl {
  /** The managed VIEW name (also the rollup / canonical-projection identifier). */
  readonly name: string;
  /** The relation to group over (table / projection / key-join / another rollup). */
  readonly source: RollupSource;
  /** One or more group-key columns (referenced by name in the source's output namespace). */
  readonly groupBy: readonly string[];
  /** Optional pre-aggregation row filter (the `WHERE` — e.g. `isNotNull(col("wave"))`). */
  readonly where?: Expr;
  /** The aggregate columns: name → closed {@link AggExpr}. Authored ONCE, compiled to both backends. */
  readonly aggregates: Record<string, AggExpr>;
}

/** A compiled rollup: the declaration plus both backends and the managed VIEW DDL. */
export interface Rollup {
  readonly decl: RollupDecl;
  /** The canonical-projection name (= `decl.name`). */
  readonly projectionName: string;
  /** The group-key columns (order preserved from the declaration). */
  readonly groupBy: readonly string[];
  /** All output columns: the group keys followed by the aggregate names (aggregates sorted by name). */
  readonly outputColumns: readonly string[];
  /** Leaf relation names this rollup reads, transitively (for fixtures / feeding the TS reduce). */
  readonly sourceRelations: readonly string[];
  /** This rollup and every rollup it composes, in dependency order (dependencies first) — the order the
   *  managed VIEWs must be created in. */
  readonly viewChain: readonly Rollup[];
  /** The SQLite select-list expression for one aggregate column. */
  sqlAggFor(column: string, options?: SqlCompileOptions): string;
  /** The in-process group-reduce (the TS backend): leaf rows → one output row per group. */
  reduce(inputs: RollupInputs): Record<string, unknown>[];
  /** The managed `CREATE VIEW` DDL. `{ temp: true }` emits a `CREATE TEMP VIEW` (parity-guard use). */
  viewDdl(options?: SqlCompileOptions, viewOptions?: ViewDdlOptions): string;
  /** Fixture column requirements per leaf relation (referenced physical columns), for the parity guard. */
  fixtureColumns(): Map<string, Set<string>>;
}

const ROLLUP_SRC_ALIAS = "__urban_rollup_src";

/** Resolve a rollup source to its SQL `FROM` clause, a `col`-name → qualified-SQL resolver, its leaf
 *  relation names, and the rollup dependencies it composes. */
function compileRollupSourceSql(
  source: RollupSource,
  resolveProjectionTable: (name: string) => string,
): { from: string; resolveColumn: (name: string) => string } {
  switch (source.kind) {
    case "table": {
      const table = assertSqlIdentifier("rollup source table", source.table);
      return {
        from: `${quoteIdent(table)} ${quoteIdent(ROLLUP_SRC_ALIAS)}`,
        resolveColumn: (name) => `${quoteIdent(ROLLUP_SRC_ALIAS)}.${quoteIdent(name)}`,
      };
    }
    case "projection": {
      const table = assertSqlIdentifier("rollup source projection", resolveProjectionTable(source.projection));
      return {
        from: `${quoteIdent(table)} ${quoteIdent(ROLLUP_SRC_ALIAS)}`,
        resolveColumn: (name) => `${quoteIdent(ROLLUP_SRC_ALIAS)}.${quoteIdent(name)}`,
      };
    }
    case "rollup": {
      const table = assertSqlIdentifier("rollup source rollup", source.rollup.projectionName);
      return {
        from: `${quoteIdent(table)} ${quoteIdent(ROLLUP_SRC_ALIAS)}`,
        resolveColumn: (name) => `${quoteIdent(ROLLUP_SRC_ALIAS)}.${quoteIdent(name)}`,
      };
    }
    case "join": {
      const leftRel = assertSqlIdentifier("rollup join relation", resolveProjectionTable(source.left.relation));
      const rightRel = assertSqlIdentifier("rollup join relation", resolveProjectionTable(source.right.relation));
      const leftAlias = assertSqlIdentifier("rollup join alias", source.left.alias);
      const rightAlias = assertSqlIdentifier("rollup join alias", source.right.alias);
      const joinKw = source.type === "inner" ? "JOIN" : "LEFT JOIN";
      const on = source.on
        .map(
          (p) =>
            `${quoteIdent(leftAlias)}.${quoteIdent(assertSqlIdentifier("join key", p.left))} = ` +
            `${quoteIdent(rightAlias)}.${quoteIdent(assertSqlIdentifier("join key", p.right))}`,
        )
        .join(" AND ");
      const from =
        `${quoteIdent(leftRel)} ${quoteIdent(leftAlias)} ${joinKw} ` +
        `${quoteIdent(rightRel)} ${quoteIdent(rightAlias)} ON ${on}`;
      // Index the join-mapped output columns by their FOLDED (case-insensitive) name: SQLite folds
      // identifiers case-insensitively and the TS twin (`materializeRollupSource`) resolves these columns
      // via the case-insensitive `lookupColumn`, so a rollup predicate/groupBy that references a
      // join-mapped column with different casing must resolve here too — a case-sensitive `source.columns[name]`
      // would succeed in TS but throw in SQL. Fail fast on a case-only collision (two output columns SQLite
      // cannot tell apart), and use a `Map` so a `__proto__`-named column can't resolve off the prototype chain.
      const foldedColumns = new Map<string, readonly [side: "left" | "right", column: string]>();
      for (const [outName, mapped] of Object.entries(source.columns)) {
        const key = foldSqlIdentifier(outName);
        if (foldedColumns.has(key)) {
          throw new Error(
            `rollup join source declares output columns differing only in case ("${outName}"); ` +
              `SQLite folds identifiers case-insensitively so they would be ambiguous`,
          );
        }
        foldedColumns.set(key, mapped);
      }
      const resolveColumn = (name: string): string => {
        const mapped = foldedColumns.get(foldSqlIdentifier(name));
        if (!mapped) throw new Error(`rollup join source has no mapped column "${name}"`);
        const [side, physical] = mapped;
        const alias = side === "left" ? leftAlias : rightAlias;
        return `${quoteIdent(alias)}.${quoteIdent(assertSqlIdentifier("join column", physical))}`;
      };
      return { from, resolveColumn };
    }
  }
}

/** The TS twin of {@link compileRollupSourceSql}: materialise a source's flat rows from leaf inputs. */
function materializeRollupSource(source: RollupSource, inputs: RollupInputs): Record<string, unknown>[] {
  switch (source.kind) {
    case "table":
      return [...(inputs[source.table] ?? [])];
    case "projection":
      return [...(inputs[source.projection] ?? [])];
    case "rollup":
      return source.rollup.reduce(inputs);
    case "join": {
      const leftRows = inputs[source.left.relation] ?? [];
      const rightRows = inputs[source.right.relation] ?? [];
      const map = (l: Record<string, unknown>, r: Record<string, unknown> | undefined): Record<string, unknown> => {
        const row: Record<string, unknown> = Object.create(null);
        for (const [outName, [side, physical]] of Object.entries(source.columns)) {
          const from = side === "left" ? l : r;
          row[outName] = from ? lookupColumn(from, physical) : null;
        }
        return row;
      };
      // Build the composite join key with the SAME storage-class-tagged encoding the GROUP BY reduce
      // uses (groupKeyPart): integer number/bigint of equal value collide, numeric never equals text —
      // matching `compareValues("eq", …)`. A nullish part yields `null` (no key), because SQLite's
      // `ON l.k = r.k` never matches a NULL key, so those rows are excluded from the join entirely.
      const keyOf = (row: Record<string, unknown>, cols: readonly string[]): string | null => {
        const parts: string[] = [];
        for (const c of cols) {
          const v = lookupColumn(row, c);
          if (v === null || v === undefined) return null;
          parts.push(groupKeyPart(v));
        }
        return parts.join("\u0001");
      };
      // Index the right side once by its join key (O(|right|)) so each left row probes in O(1) rather
      // than scanning every right row (was O(|left|·|right|)).
      const rightCols = source.on.map((p) => p.right);
      const leftCols = source.on.map((p) => p.left);
      const rightByKey = new Map<string, Record<string, unknown>[]>();
      for (const r of rightRows) {
        const k = keyOf(r, rightCols);
        if (k === null) continue;
        let bucket = rightByKey.get(k);
        if (!bucket) {
          bucket = [];
          rightByKey.set(k, bucket);
        }
        bucket.push(r);
      }
      const out: Record<string, unknown>[] = [];
      for (const l of leftRows) {
        const k = keyOf(l, leftCols);
        const matches = k === null ? undefined : rightByKey.get(k);
        if (!matches || matches.length === 0) {
          if (source.type !== "inner") out.push(map(l, undefined));
        } else {
          for (const r of matches) out.push(map(l, r));
        }
      }
      return out;
    }
  }
}

/** Leaf relation names a source reads, transitively (a `rollup` source recurses into its own leaves). */
function rollupSourceRelations(source: RollupSource): string[] {
  switch (source.kind) {
    case "table":
      return [source.table];
    case "projection":
      return [source.projection];
    case "join":
      return [source.left.relation, source.right.relation];
    case "rollup":
      return [...source.rollup.sourceRelations];
  }
}

/** The physical twin of {@link rollupSourceRelations}: each leaf relation name mapped to the physical
 *  SQL table the compiled VIEW reads, applying the SAME projection→table resolution
 *  {@link compileRollupSourceSql} uses — identity for a raw `table` source, `resolveProjectionTable` for
 *  `projection`/`join` relations, recursing for a composed `rollup`. The parity guard builds its TEMP
 *  fixtures under these names so they match the VIEW's `FROM`; otherwise a projection whose name maps to a
 *  different physical relation (e.g. `urban_instance_state` → `_urban_instance_state`) would leave the
 *  VIEW pointing at a table the logical-named fixture never created. */
function rollupSourcePhysicalTables(
  source: RollupSource,
  resolveProjectionTable: (name: string) => string,
): Map<string, string> {
  switch (source.kind) {
    case "table":
      return new Map([[source.table, source.table]]);
    case "projection":
      return new Map([[source.projection, resolveProjectionTable(source.projection)]]);
    case "join":
      return new Map([
        [source.left.relation, resolveProjectionTable(source.left.relation)],
        [source.right.relation, resolveProjectionTable(source.right.relation)],
      ]);
    case "rollup":
      return rollupSourcePhysicalTables(source.rollup.decl.source, resolveProjectionTable);
  }
}

/** Evaluate one aggregate over a group's source rows (the TS backend). */
function evalAgg(agg: AggExpr, rows: Record<string, unknown>[]): unknown {
  switch (agg.kind) {
    case "count": {
      const { column } = agg;
      return column === undefined
        ? rows.length
        : rows.filter((r) => lookupColumn(r, column) !== null).length;
    }
    case "countWhere": {
      const fn = compileToFn(agg.pred);
      return rows.filter((r) => truthy(fn(r))).length;
    }
    case "max": {
      const vals = rows.map((r) => lookupColumn(r, agg.column)).filter((v) => v !== null && v !== undefined);
      if (vals.length === 0) return null;
      return vals.reduce((m, v) => (compareOrderable(orderable(v), orderable(m)) > 0 ? v : m));
    }
    case "minWhere": {
      const fn = compileToFn(agg.pred);
      const vals = rows
        .filter((r) => truthy(fn(r)))
        .map((r) => lookupColumn(r, agg.column))
        .filter((v) => v !== null && v !== undefined);
      if (vals.length === 0) return null;
      return vals.reduce((m, v) => (compareOrderable(orderable(v), orderable(m)) < 0 ? v : m));
    }
    case "coalesce": {
      const a = evalAgg(agg.a, rows);
      return a === null || a === undefined ? evalAgg(agg.b, rows) : a;
    }
    case "add": {
      const base = evalAgg(agg.expr, rows);
      if (base === null || base === undefined) return null; // SQLite: NULL + literal = NULL
      if (typeof base === "bigint") return base + BigInt(agg.literal);
      const n = typeof base === "number" ? base : Number(base);
      return n + agg.literal;
    }
  }
}

/** Compile one aggregate to a SQLite select-list expression (the SQL backend). */
function compileAggToSql(agg: AggExpr, options: SqlCompileOptions): string {
  const resolveColumn = options.resolveColumn ?? ((n: string) => quoteIdent(n));
  switch (agg.kind) {
    case "count":
      return agg.column === undefined ? "COUNT(*)" : `COUNT(${resolveColumn(agg.column)})`;
    case "countWhere":
      return `SUM(CASE WHEN ${compileToSqlSelect(agg.pred, options)} THEN 1 ELSE 0 END)`;
    case "max":
      return `MAX(${resolveColumn(agg.column)})`;
    case "minWhere":
      return `MIN(CASE WHEN ${compileToSqlSelect(agg.pred, options)} THEN ${resolveColumn(agg.column)} END)`;
    case "coalesce":
      return `COALESCE(${compileAggToSql(agg.a, options)}, ${compileAggToSql(agg.b, options)})`;
    case "add":
      return `(${compileAggToSql(agg.expr, options)} + ${sqlLiteral(agg.literal)})`;
  }
}

/** A composite group key for the TS reduce, tagged by storage class so `1`/`'1'`/NULL group distinctly
 *  (matching SQLite's affinity-free grouping the parity fixtures pin), while integer `number`/`bigint`
 *  of equal value group together (a driver may surface either). */
function groupKeyPart(value: unknown): string {
  if (value === null || value === undefined) return "\u0000null";
  if (typeof value === "bigint") return `\u0000int:${value}`;
  if (typeof value === "number" && Number.isInteger(value)) return `\u0000int:${value}`;
  if (typeof value === "number") return `\u0000num:${value}`;
  if (typeof value === "boolean") return `\u0000int:${value ? 1 : 0}`;
  return `\u0000str:${String(value)}`;
}

/**
 * Declare a GROUP-BY rollup ONCE (ADR 0065, #468). Returns a {@link Rollup} exposing both backends (the
 * managed `*_counts` VIEW DDL and the TS group-reduce) driven from one closed spec, plus the metadata
 * the parity guard and registry need. Register it in {@link rollupRegistry} to have the runtime apply
 * its VIEW at boot and expose its name as a canonical projection.
 */
export function defineRollup(decl: RollupDecl): Rollup {
  assertSqlIdentifier("rollup name", decl.name);
  if (decl.groupBy.length === 0) throw new Error(`rollup "${decl.name}" declares no group-by columns`);
  for (const g of decl.groupBy) assertSqlIdentifier("group-by column", g);
  const aggNames = Object.keys(decl.aggregates).sort();
  if (aggNames.length === 0) throw new Error(`rollup "${decl.name}" declares no aggregates`);
  for (const a of aggNames) assertSqlIdentifier("aggregate column", a);
  // An aggregate column name colliding with a group-key name would emit two SELECT aliases of one name.
  const groupSet = new Set(decl.groupBy.map((g) => foldSqlIdentifier(g)));
  for (const a of aggNames) {
    if (groupSet.has(foldSqlIdentifier(a))) {
      throw new Error(`rollup "${decl.name}" aggregate "${a}" collides with a group-by column of the same name`);
    }
  }
  if (decl.where) assertRollupPredicate(`rollup "${decl.name}" where`, decl.where);
  for (const a of aggNames) {
    const agg = decl.aggregates[a];
    forEachAggPredicate(agg, (pred) => assertRollupPredicate(`rollup "${decl.name}" aggregate "${a}"`, pred));
  }

  // Fail-fast: when the source's output namespace is statically known — a key-`join` exposes its flat
  // `columns` map, a composed `rollup` exposes its `outputColumns` — reject a rollup that references a
  // `groupBy`/`col(...)` name absent from it. Otherwise the two backends drift silently: the SQL side
  // throws (`no mapped column` for a join; `no such column` for a rollup source) at view compilation /
  // query time, while the TS reduce reads NULL via `lookupColumn` and groups/counts against a phantom
  // column. Fold names case-insensitively to mirror the resolvers (SQLite identifier folding +
  // `lookupColumn`). A `table`/`projection` source has no statically-known namespace here, so it is
  // left to the existing per-relation resolution.
  const knownNamespaceCols =
    decl.source.kind === "join"
      ? Object.keys(decl.source.columns)
      : decl.source.kind === "rollup"
        ? decl.source.rollup.outputColumns
        : undefined;
  if (knownNamespaceCols) {
    const knownFolded = new Set(knownNamespaceCols.map(foldSqlIdentifier));
    const referencedCols = new Set<string>();
    for (const g of decl.groupBy) referencedCols.add(g);
    if (decl.where) collectColumns(decl.where, referencedCols, new Map(), new Map());
    for (const a of aggNames) collectAggColumns(decl.aggregates[a], referencedCols);
    for (const name of referencedCols) {
      if (!knownFolded.has(foldSqlIdentifier(name))) {
        const kind = decl.source.kind === "join" ? "join source" : "rollup source";
        throw new Error(
          `rollup "${decl.name}" references column "${name}" absent from its ${kind} output namespace ` +
            `[${knownNamespaceCols.join(", ")}]`,
        );
      }
    }
  }

  const outputColumns = [...decl.groupBy, ...aggNames];
  const sourceRelations = [...new Set(rollupSourceRelations(decl.source))];
  const dependencies = decl.source.kind === "rollup" ? decl.source.rollup.viewChain : [];
  // Dependency rollups first (dedup by name, preserving order); this rollup itself is appended last
  // once `self` exists (see below).
  const viewChain: Rollup[] = [];
  const seenChain = new Set<string>();
  for (const dep of dependencies) {
    const key = foldSqlIdentifier(dep.projectionName);
    if (!seenChain.has(key)) {
      seenChain.add(key);
      viewChain.push(dep);
    }
  }

  const sqlAggFor = (column: string, options?: SqlCompileOptions): string => {
    const agg = decl.aggregates[column];
    if (!agg) throw new Error(`rollup "${decl.name}" has no aggregate "${column}"`);
    const { resolveColumn } = compileRollupSourceSql(decl.source, resolveProjectionTableFor(options));
    return compileAggToSql(agg, { ...options, resolveColumn });
  };

  const viewDdl = (options?: SqlCompileOptions, viewOptions?: ViewDdlOptions): string => {
    const { from, resolveColumn } = compileRollupSourceSql(decl.source, resolveProjectionTableFor(options));
    const colOptions: SqlCompileOptions = { ...options, resolveColumn };
    const groupSelect = decl.groupBy.map((g) => `${resolveColumn(g)} AS ${quoteIdent(g)}`);
    const aggSelect = aggNames.map((a) => `${compileAggToSql(decl.aggregates[a], colOptions)} AS ${quoteIdent(a)}`);
    const selectList = [...groupSelect, ...aggSelect].join(",\n  ");
    const whereClause = decl.where ? `\nWHERE ${compileToSqlSelect(decl.where, colOptions)}` : "";
    const groupByClause = decl.groupBy.map((g) => resolveColumn(g)).join(", ");
    const createView = viewOptions?.temp ? "CREATE TEMP VIEW IF NOT EXISTS" : "CREATE VIEW IF NOT EXISTS";
    return (
      `${createView} ${quoteIdent(decl.name)} AS\n` +
      `SELECT\n  ${selectList}\n` +
      `FROM ${from}${whereClause}\n` +
      `GROUP BY ${groupByClause};`
    );
  };

  const reduce = (inputs: RollupInputs): Record<string, unknown>[] => {
    const src = materializeRollupSource(decl.source, inputs);
    const whereFn = decl.where ? compileToFn(decl.where) : undefined;
    const filtered = whereFn ? src.filter((r) => truthy(whereFn(r))) : src;
    const groups = new Map<string, Record<string, unknown>[]>();
    const order: { first: Record<string, unknown>; rows: Record<string, unknown>[] }[] = [];
    for (const r of filtered) {
      const key = decl.groupBy.map((g) => groupKeyPart(lookupColumn(r, g))).join("\u0001");
      let bucket = groups.get(key);
      if (!bucket) {
        bucket = [];
        groups.set(key, bucket);
        order.push({ first: r, rows: bucket });
      }
      bucket.push(r);
    }
    return order.map(({ first, rows }) => {
      const out: Record<string, unknown> = Object.create(null);
      for (const g of decl.groupBy) out[g] = lookupColumn(first, g);
      for (const a of aggNames) out[a] = evalAgg(decl.aggregates[a], rows);
      return out;
    });
  };

  const fixtureColumns = (): Map<string, Set<string>> => {
    const cols = new Map<string, Set<string>>();
    const ensure = (rel: string): Set<string> => {
      let s = cols.get(rel);
      if (!s) {
        s = new Set<string>();
        cols.set(rel, s);
      }
      return s;
    };
    // Columns referenced by this rollup's group keys, where predicate, and aggregates (as source
    // output-namespace names), then mapped onto the physical relation(s) of its source.
    const referenced = new Set<string>();
    for (const g of decl.groupBy) referenced.add(g);
    if (decl.where) collectColumns(decl.where, referenced, new Map(), new Map());
    for (const a of aggNames) collectAggColumns(decl.aggregates[a], referenced);
    switch (decl.source.kind) {
      case "table":
      case "projection": {
        const rel = decl.source.kind === "table" ? decl.source.table : decl.source.projection;
        const s = ensure(rel);
        for (const c of referenced) s.add(c);
        break;
      }
      case "join": {
        const leftSet = ensure(decl.source.left.relation);
        const rightSet = ensure(decl.source.right.relation);
        for (const [, [side, physical]] of Object.entries(decl.source.columns)) {
          (side === "left" ? leftSet : rightSet).add(physical);
        }
        for (const p of decl.source.on) {
          leftSet.add(p.left);
          rightSet.add(p.right);
        }
        break;
      }
      case "rollup": {
        // The inner rollup provides its own output columns via its VIEW; recurse for its leaf fixtures.
        for (const [rel, s] of decl.source.rollup.fixtureColumns()) {
          const dst = ensure(rel);
          for (const c of s) dst.add(c);
        }
        break;
      }
    }
    return cols;
  };

  const self: Rollup = {
    decl,
    projectionName: decl.name,
    groupBy: [...decl.groupBy],
    outputColumns,
    sourceRelations,
    viewChain,
    sqlAggFor,
    reduce,
    viewDdl,
    fixtureColumns,
  };
  viewChain.push(self);
  return self;
}

/** Walk every predicate `Expr` embedded in an aggregate (countWhere/minWhere), recursing coalesce/add. */
function forEachAggPredicate(agg: AggExpr, visit: (pred: Expr) => void): void {
  switch (agg.kind) {
    case "countWhere":
      visit(agg.pred);
      return;
    case "minWhere":
      visit(agg.pred);
      return;
    case "coalesce":
      forEachAggPredicate(agg.a, visit);
      forEachAggPredicate(agg.b, visit);
      return;
    case "add":
      forEachAggPredicate(agg.expr, visit);
      return;
    default:
      return;
  }
}

function resolveProjectionTableFor(options?: SqlCompileOptions): (name: string) => string {
  return options?.resolveProjectionTable ?? ((n: string) => projectionRegistry.sqlTableFor(n));
}

// ────────────────────────────────────────── Rollup registry ──────────────────────────────────────

/**
 * The rollup registry (ADR 0065, #468) — the GROUP-BY sibling of {@link ReadModelRegistry}. Registering
 * a {@link Rollup} both (a) queues its managed VIEW for boot provisioning (in dependency order) and (b)
 * registers its name as a canonical projection so read-model rollup lookups resolve. Idempotent: a
 * re-register whose VIEW DDL matches is a no-op; a conflicting redefinition throws.
 */
export class RollupRegistry {
  readonly #byName = new Map<string, Rollup>();

  register(rollup: Rollup, projections: ProjectionRegistry = projectionRegistry): void {
    const key = foldSqlIdentifier(rollup.projectionName);
    const existing = this.#byName.get(key);
    if (existing) {
      if (existing.projectionName !== rollup.projectionName) {
        throw new Error(
          `rollup "${rollup.projectionName}" already registered as "${existing.projectionName}"; SQLite ` +
            `folds identifiers case-insensitively, so names differing only in case denote one VIEW`,
        );
      }
      if (existing.viewDdl() !== rollup.viewDdl()) {
        throw new Error(`rollup "${rollup.projectionName}" already registered with a different definition`);
      }
      return;
    }
    this.#byName.set(key, rollup);
    // Expose the rollup's VIEW as a canonical projection so `exists(...)`/rollup lookups resolve to it.
    projections.register({ name: rollup.projectionName });
  }

  all(): Rollup[] {
    return [...this.#byName.values()];
  }

  get(name: string): Rollup | undefined {
    return this.#byName.get(foldSqlIdentifier(name));
  }

  /** Apply every registered rollup's managed VIEW to a database, dependency-ordered (a composed rollup
   *  after the rollup it reads) and MANAGED (drop+recreate `main.`-qualified, mirroring
   *  {@link ReadModelRegistry.ensureViews}). Safe to call repeatedly. */
  ensureViews(db: { exec(sql: string): void }, options?: SqlCompileOptions): void {
    const applied = new Set<string>();
    const applyChain = (rollup: Rollup): void => {
      for (const r of rollup.viewChain) {
        const key = foldSqlIdentifier(r.projectionName);
        if (applied.has(key)) continue;
        applied.add(key);
        db.exec(`DROP VIEW IF EXISTS main.${quoteIdent(r.projectionName)};`);
        db.exec(r.viewDdl(options));
      }
    };
    for (const rollup of this.#byName.values()) applyChain(rollup);
  }

  clear(): void {
    this.#byName.clear();
  }
}

/** Process-wide rollup registry — the concrete registration point apps/sidecars import and call. */
export const rollupRegistry = new RollupRegistry();

// ─────────────────────────────────────── Rollup parity guard ─────────────────────────────────────

/** Options for {@link assertRollupParity}. */
export interface RollupParityOptions {
  readonly onMismatch?: (message: string) => never;
  readonly sql?: SqlCompileOptions;
}

/**
 * The framework PARITY GUARD for grouped rollups (#468) — the GROUP-BY sibling of
 * {@link assertReadModelParity}. For each input-set it materialises the rollup's managed VIEW (and any
 * composed dependency VIEWs) over throwaway TEMP fixtures built from the leaf rows, reads the SQL-derived
 * group rows, computes the TS `reduce` for the same inputs, and asserts they agree as a SET keyed by the
 * group columns (GROUP BY output order is unspecified, so rows are matched by key, not position).
 */
export function assertRollupParity(
  rollup: Rollup,
  db: ParityDb,
  sampleSets: RollupInputs[],
  options: RollupParityOptions = {},
): void {
  const onMismatch = options.onMismatch ?? defaultOnMismatch;
  const fixtureCols = rollup.fixtureColumns();
  const relations = [...fixtureCols.keys()];
  // Fixtures are keyed by LOGICAL relation name (what `RollupInputs`/`reduce` read), but the managed VIEW
  // reads the PHYSICAL table `compileRollupSourceSql` resolves each projection/join relation to. Build the
  // TEMP tables under those physical names (via the same resolver the VIEW is compiled with, line below)
  // so the VIEW's `FROM` finds them; the column/row maps stay logical-keyed.
  const resolveTable = options.sql?.resolveProjectionTable ?? ((n: string) => projectionRegistry.sqlTableFor(n));
  const physicalTables = rollupSourcePhysicalTables(rollup.decl.source, resolveTable);
  const physical = (rel: string): string => physicalTables.get(rel) ?? rel;

  const createFixture = (table: string, cols: Set<string>): void => {
    const colList = [...cols];
    const ddl = colList.length
      ? `CREATE TEMP TABLE ${quoteIdent(table)} (${colList.map((c) => quoteIdent(c)).join(", ")});`
      : `CREATE TEMP TABLE ${quoteIdent(table)} (_placeholder);`;
    db.exec(ddl);
  };
  const insertRow = (table: string, row: Record<string, unknown>): void => {
    const keys = Object.keys(row);
    if (keys.length === 0) {
      db.run(`INSERT INTO ${quoteIdent(table)} DEFAULT VALUES;`);
      return;
    }
    const placeholders = keys.map(() => "?").join(", ");
    db.run(
      `INSERT INTO ${quoteIdent(table)} (${keys.map((k) => quoteIdent(k)).join(", ")}) VALUES (${placeholders});`,
      keys.map((k) => normaliseSqlValue(row[k])),
    );
  };
  const dropFixtures = (): void => {
    // Drop dependent VIEWs before their base relations; drop the whole chain plus leaf fixtures.
    for (let i = rollup.viewChain.length - 1; i >= 0; i--) {
      db.exec(`DROP VIEW IF EXISTS temp.${quoteIdent(rollup.viewChain[i].projectionName)};`);
    }
    for (const rel of relations) db.exec(`DROP TABLE IF EXISTS temp.${quoteIdent(physical(rel))};`);
  };

  // Widen each leaf fixture with any extra column keys present in the sample rows.
  const cols = new Map<string, Set<string>>();
  for (const [rel, set] of fixtureCols) cols.set(rel, new Set(set));
  for (const inputs of sampleSets) {
    for (const [rel, rows] of Object.entries(inputs)) {
      const set = cols.get(rel);
      if (!set) continue;
      for (const r of rows) for (const k of Object.keys(r)) set.add(k);
    }
  }

  dropFixtures();
  try {
    for (const rel of relations) createFixture(physical(rel), cols.get(rel) ?? new Set());
    // Materialise the VIEW chain (dependencies first) as TEMP views over the leaf fixtures.
    for (const r of rollup.viewChain) db.exec(r.viewDdl(options.sql, { temp: true }));

    const outputList = rollup.outputColumns.map((c) => quoteIdent(c)).join(", ");
    sampleSets.forEach((inputs, idx) => {
      for (const rel of relations) db.run(`DELETE FROM ${quoteIdent(physical(rel))};`);
      for (const [rel, rows] of Object.entries(inputs)) {
        if (!cols.has(rel)) continue;
        for (const r of rows) insertRow(physical(rel), r);
      }

      const sqlRows = db.all<Record<string, unknown>>(
        `SELECT ${outputList} FROM ${quoteIdent(rollup.projectionName)};`,
      );
      const tsRows = rollup.reduce(inputs);

      const keyOf = (row: Record<string, unknown>): string =>
        rollup.groupBy.map((g) => groupKeyPart(normaliseSqlValue(lookupColumn(row, g)))).join("\u0001");
      const sqlByKey = new Map<string, Record<string, unknown>>();
      for (const r of sqlRows) sqlByKey.set(keyOf(r), r);
      const tsByKey = new Map<string, Record<string, unknown>>();
      for (const r of tsRows) tsByKey.set(keyOf(r), r);

      if (sqlByKey.size !== tsByKey.size) {
        onMismatch(
          `rollup parity mismatch in "${rollup.projectionName}" (sample #${idx}): ` +
            `SQL produced ${sqlByKey.size} group(s) vs TS ${tsByKey.size}`,
        );
      }
      for (const [key, tsRow] of tsByKey) {
        const sqlRow = sqlByKey.get(key);
        if (!sqlRow) {
          onMismatch(`rollup parity mismatch in "${rollup.projectionName}" (sample #${idx}): TS group ${key} missing from SQL`);
          continue;
        }
        for (const c of rollup.outputColumns) {
          const sqlValue = normaliseSqlValue(sqlRow[c]);
          const tsValue = normaliseSqlValue(tsRow[c]);
          if (!Object.is(sqlValue, tsValue)) {
            onMismatch(
              `rollup parity mismatch in "${rollup.projectionName}".${c} (sample #${idx}, group ${key}): ` +
                `SQL=${formatParityValue(sqlValue)} vs TS=${formatParityValue(tsValue)}`,
            );
          }
        }
      }
    });
  } finally {
    dropFixtures();
  }
}
