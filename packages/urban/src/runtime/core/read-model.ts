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
  | CompareExpr
  | AndExpr
  | OrExpr
  | NotExpr
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
    const existing = this.#byName.get(source.name);
    const sqlTable = source.sqlTable ?? source.name;
    if (existing) {
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
    this.#byName.set(source.name, { name: source.name, sqlTable });
  }

  /** The physical SQL table/view for a projection name; falls back to the name itself if unregistered
   *  (so a read model compiles against a not-yet-landed sidecar, which supplies the same-named table). */
  sqlTableFor(name: string): string {
    return this.#byName.get(name)?.sqlTable ?? name;
  }

  has(name: string): boolean {
    return this.#byName.has(name);
  }

  names(): string[] {
    return [...this.#byName.keys()];
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

/** A conservative SQL identifier guard — we interpolate names directly into DDL/SQL. */
const SQL_IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;
export function assertSqlIdentifier(kind: string, name: string): string {
  if (!SQL_IDENT.test(name)) {
    throw new Error(`invalid ${kind} "${name}": must match ${SQL_IDENT.source}`);
  }
  return name;
}
function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
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
    while (alias.toLowerCase() === baseAlias.toLowerCase()) alias = `_${alias}`;
    return alias;
  };

  const walk = (node: Expr, projTable: string | undefined, existsDepth: number): string => {
    switch (node.kind) {
      case "lit":
        return sqlLiteral(node.value);
      case "col":
        return `${quoteIdent(baseAlias)}.${quoteIdent(node.name)}`;
      case "pcol":
        if (!projTable) {
          throw new Error(`pcol("${node.name}") used outside an EXISTS projection context`);
        }
        return `${quoteIdent(projTable)}.${quoteIdent(node.name)}`;
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

/** The compiled runtime derivation: same value as the SQL VIEW, computed in-process. */
export type DerivationFn = (baseRow: BaseRow, projections?: ProjectionRows) => unknown;

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

  // Mixed numeric-vs-text: SQLite orders by storage class (NULL < INTEGER/REAL < TEXT), and the managed
  // VIEW compares these values WITHOUT numeric-affinity coercion (its base/fixture columns carry no
  // declared affinity), so a numeric value always sorts BEFORE a text value and is never equal to one —
  // even a numeric-looking one like "42". Return that definite ordering directly: coercing the numeric
  // side through `Number()` (as a naive fallback would) truncates a 64-bit `bigint` and could collapse
  // distinct keys, reintroducing SQL/TS drift for both equality and ordering.
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
  const evalNode = (node: Expr, baseRow: BaseRow, projections: ProjectionRows, projRow?: Record<string, unknown>): unknown => {
    switch (node.kind) {
      case "lit":
        return node.value;
      case "col":
        return baseRow[node.name] ?? null;
      case "pcol":
        if (!projRow) throw new Error(`pcol("${node.name}") evaluated outside an EXISTS projection context`);
        return projRow[node.name] ?? null;
      case "compare":
        return compareValues(
          node.op,
          evalNode(node.left, baseRow, projections, projRow),
          evalNode(node.right, baseRow, projections, projRow),
        );
      case "and":
        return node.clauses.every((c) => truthy(evalNode(c, baseRow, projections, projRow)));
      case "or":
        return node.clauses.some((c) => truthy(evalNode(c, baseRow, projections, projRow)));
      case "not":
        return !truthy(evalNode(node.expr, baseRow, projections, projRow));
      case "case": {
        for (const w of node.whens) {
          if (truthy(evalNode(w.when, baseRow, projections, projRow))) {
            return evalNode(w.then, baseRow, projections, projRow);
          }
        }
        return evalNode(node.else, baseRow, projections, projRow);
      }
      case "exists": {
        const rows = projections[node.projection] ?? [];
        return rows.some((r) => truthy(evalNode(node.where, baseRow, projections, r)));
      }
    }
  };
  return (baseRow, projections = {}) => evalNode(expr, baseRow, projections);
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
  /** Evaluate ALL derived columns for a base row in-process (the TS backend of the whole model). */
  evaluate(baseRow: BaseRow, projections?: ProjectionRows): Record<string, unknown>;
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

/** Collect the base-row columns (`col`) and per-projection columns (`pcol`, inside `exists`) an
 *  expression references. Used by the parity guard to build fixture tables carrying every referenced
 *  column even when a sample supplies no rows for a projection. */
function collectColumns(
  expr: Expr,
  baseCols: Set<string>,
  projCols: Map<string, Set<string>>,
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
    case "compare":
      collectColumns(expr.left, baseCols, projCols, currentProjection);
      collectColumns(expr.right, baseCols, projCols, currentProjection);
      return;
    case "and":
    case "or":
      for (const c of expr.clauses) collectColumns(c, baseCols, projCols, currentProjection);
      return;
    case "not":
      collectColumns(expr.expr, baseCols, projCols, currentProjection);
      return;
    case "case":
      for (const w of expr.whens) {
        collectColumns(w.when, baseCols, projCols, currentProjection);
        collectColumns(w.then, baseCols, projCols, currentProjection);
      }
      collectColumns(expr.else, baseCols, projCols, currentProjection);
      return;
    case "exists": {
      if (!projCols.has(expr.projection)) projCols.set(expr.projection, new Set<string>());
      collectColumns(expr.where, baseCols, projCols, expr.projection);
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

  const sqlSelectFor = (column: string, options?: SqlCompileOptions): string => {
    const expr = decl.derive[column];
    if (!expr) throw new Error(`read model "${decl.name}" has no derived column "${column}"`);
    return compileToSqlSelect(expr, options);
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
    return (
      `${createView} ${quoteIdent(decl.name)} AS\n` +
      `SELECT\n  ${selectList}\n` +
      `FROM ${quoteIdent(decl.baseTable)} ${quoteIdent(baseAlias)};`
    );
  };

  return {
    decl,
    projectionNames: [...projSet],
    sqlSelectFor,
    fnFor,
    evaluate: (baseRow, projections) => {
      const out: Record<string, unknown> = {};
      for (const c of columns) out[c] = fnFor(c)(baseRow, projections);
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
    const existing = this.#byName.get(model.decl.name);
    if (existing) {
      if (existing.viewDdl() !== model.viewDdl()) {
        throw new Error(`read model "${model.decl.name}" already registered with a different definition`);
      }
      return;
    }
    this.#byName.set(model.decl.name, model);
  }

  all(): ReadModel[] {
    return [...this.#byName.values()];
  }

  get(name: string): ReadModel | undefined {
    return this.#byName.get(name);
  }

  /** Apply every registered model's managed VIEW to a database (the boot-path entry point). Safe to
   *  call repeatedly and it is truly MANAGED: each VIEW is dropped and recreated so a changed
   *  read-model definition in code always replaces a stale VIEW body (a plain `CREATE VIEW IF NOT
   *  EXISTS` would leave the SQL backend running an old definition, reintroducing backend drift).
   *  Referenced base/projection tables need not exist yet — SQLite only resolves a VIEW's body when
   *  it is queried. */
  ensureViews(db: { exec(sql: string): void }, options?: SqlCompileOptions): void {
    for (const model of this.#byName.values()) {
      db.exec(`DROP VIEW IF EXISTS ${quoteIdent(model.decl.name)};`);
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

/** A single parity check case: a base row plus the projection rows in scope for it. */
export interface ParitySample {
  readonly baseRow: BaseRow;
  readonly projections?: ProjectionRows;
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
    if (!Object.hasOwn(model.decl.derive, c)) {
      throw new Error(`read model "${model.decl.name}" has no derived column "${c}" to check parity for`);
    }
  }

  // Collect the union of base columns and per-projection columns across all samples, so the fixture
  // tables carry every referenced column. Seed from the AST first so a projection referenced by an
  // `exists` predicate always has its correlated columns even when a sample supplies no rows for it.
  const baseCols = new Set<string>();
  const projCols = new Map<string, Set<string>>();
  for (const name of model.projectionNames) projCols.set(name, new Set());
  for (const c of columns) collectColumns(model.decl.derive[c], baseCols, projCols);
  for (const s of samples) {
    for (const k of Object.keys(s.baseRow)) baseCols.add(k);
    for (const [pname, rows] of Object.entries(s.projections ?? {})) {
      // Only widen fixtures for projections the model actually references; a sample may carry extra
      // projections the read model never reads, and those get no fixture table (see insert loop below).
      const set = projCols.get(pname);
      if (!set) continue;
      for (const r of rows) for (const k of Object.keys(r)) set.add(k);
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
    // Two distinct projection names resolving to ONE physical table is a mapping bug: the guard would
    // otherwise `CREATE TABLE` (and later drop/insert) that table twice and fail for a non-parity
    // reason. Reject it up front with an actionable error instead (mirrors the column check above).
    const owner = tableOwner.get(table);
    if (owner !== undefined && owner !== name) {
      throw new Error(
        `read model "${model.decl.name}" maps projections "${owner}" and "${name}" to the same ` +
          `physical table "${table}"; each projection needs a distinct sqlTable so the parity guard ` +
          `can build an isolated fixture for it`,
      );
    }
    tableOwner.set(table, name);
    projectionTables.set(name, table);
  }

  // Fresh fixtures in the TEMP schema. Drop first (schema-qualified with `temp.` so an unqualified
  // name can never resolve to — and delete — a real `main` table/view) so the guard can be called
  // repeatedly on one DB without clobbering the caller's application data.
  db.exec(`DROP VIEW IF EXISTS temp.${quoteIdent(model.decl.name)};`);
  db.exec(`DROP TABLE IF EXISTS temp.${quoteIdent(baseTable)};`);
  for (const table of projectionTables.values()) db.exec(`DROP TABLE IF EXISTS temp.${quoteIdent(table)};`);

  createFixture(baseTable, baseCols);
  for (const [name, table] of projectionTables) createFixture(table, projCols.get(name) ?? new Set());
  db.exec(model.viewDdl(options.sql, { temp: true }));

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

  samples.forEach((sample, idx) => {
    // Reset fixture data for this isolated sample.
    db.run(`DELETE FROM ${quoteIdent(baseTable)};`);
    for (const table of projectionTables.values()) db.run(`DELETE FROM ${quoteIdent(table)};`);
    insertRow(baseTable, sample.baseRow);
    for (const [pname, rows] of Object.entries(sample.projections ?? {})) {
      // Ignore projections the model never references — no fixture table exists for them, and they
      // cannot affect any derived column, so inserting would fail the guard for a non-parity reason.
      const table = projectionTables.get(pname);
      if (!table) continue;
      for (const r of rows) insertRow(table, r);
    }

    // Read the SQL-derived values straight from the managed VIEW — the VIEW body already computes
    // each derived column, so this exercises the exact DDL the framework emits (not a recompiled copy).
    const derivedList = columns.map((c) => quoteIdent(c)).join(", ");
    const sqlRows = db.all<Record<string, unknown>>(
      `SELECT ${derivedList} FROM ${quoteIdent(model.decl.name)};`,
    );
    const sqlRow = sqlRows[0] ?? {};
    for (const c of columns) {
      const sqlValue = normaliseSqlValue(sqlRow[c]);
      const fnValue = normaliseSqlValue(model.fnFor(c)(sample.baseRow, sample.projections));
      if (!Object.is(sqlValue, fnValue)) {
        onMismatch(
          `read-model parity mismatch in "${model.decl.name}".${c} (sample #${idx}): ` +
            `SQL=${formatParityValue(sqlValue)} vs TS=${formatParityValue(fnValue)}`,
        );
      }
    }
  });
}
