// Composed motion shapes: the fuse composition algebra (ADR 0040 §9/§10).
//
// A composed shape is a named, model-scoped declaration authored in the Modeller and carried in
// the `.bpmn` as a `nano:shape` (see the Rust scan `envelope_scan.rs`). It composes existing fused
// entities — DB tables, manifest `types`, and other shapes — via four ordered operations:
//
//   carry(ref)                 spread every field of `ref`
//   project(ref, fields, via)  spread only the named fields of `ref`
//   extend(name, type, ...)    add a process-authored field
//   reference(name, ref, ...)  nest (or spread) another shape
//
// Resolution folds the ops, in author (XML) order, into a flat `DomainTypeDef`, so a composed
// shape enters the same `DomainTypes` registry a manifest `type` does — every downstream consumer
// (envelope pickers, `defineWorker`, `publishMessage`, FEEL scopes) types against
// `DomainTypes["ApprovedOrder"]` with no new codegen path. Broken shapes are omitted (degrade to
// untyped) and reported as diagnostics.
//
// Byte-faithful port of the console's `resolveShapes`/`emitDomainModelJson` (server
// `domain_types.ts`), so the toolkit is the single source of truth for the IDE's shape fuse
// (host dry-out nano-bpm#576).

import type { ColumnMeta } from "../../runtime/core/modules/gateway.ts";
import {
  type DomainFieldDef,
  type DomainTypeDef,
  type DomainTypeRegistry,
  isPrimitiveKeyword,
  type SourceSchema,
  sqliteAffinityToTs,
} from "./domain.ts";

/** One composition operation of a `nano:shape`, in author (XML) order. */
export type ShapeOp =
  | { op: "carry"; ref: string }
  | { op: "project"; ref: string; fields: string[]; via?: string }
  | { op: "extend"; name: string; type: string; optional?: boolean; list?: boolean }
  | { op: "reference"; name: string; ref: string; spread?: boolean; list?: boolean };

/** A composed motion-shape declaration lifted from the model (ADR 0040 §9). */
export interface ShapeDecl {
  /** The fuse identity; also the `DomainTypes` key the resolved shape lands under. */
  id: string;
  /** Optional human label (`nano:shape name`). */
  name?: string;
  /** The defining process id, for the `model:<processId>` provenance tag. */
  process?: string;
  /** The ordered composition operations. */
  ops: ShapeOp[];
  /** Model-level metadata (`nano:meta`), free-form key/value (ADR 0040 §5). */
  meta?: Record<string, string>;
}

// --- model scan (`nano:shape` XML → `ShapeDecl[]`) -------------------------------------------
// The regex-based BPMN scan mirrors the Rust `envelope_scan.rs` shape parser (and the sibling
// `meta.ts`/`worker-io.ts` scanners): the toolkit is the standalone `urban gen` path, so it must
// lift model-authored shapes itself rather than receive them from the host reifier.

/** Read a `name="…"` attribute off an element's opening tag (any namespace prefix on the name). */
function shapeAttr(tag: string, name: string): string | undefined {
  const m = tag.match(new RegExp(`\\b${name}\\s*=\\s*"([^"]*)"`));
  const v = m?.[1]?.trim();
  return v != null && v.length > 0 ? v : undefined;
}

/** A boolean attribute is true only for the exact literal `"true"` (mirrors `bool_attr`). */
function shapeBool(tag: string, name: string): boolean {
  const m = tag.match(new RegExp(`\\b${name}\\s*=\\s*"([^"]*)"`));
  return m?.[1]?.trim() === "true";
}

/** Split a comma-delimited `fields="a, b"` list, trimming and dropping empties (`split_fields`). */
function splitFields(raw: string | undefined): string[] {
  return (raw ?? "").split(",").map((s) => s.trim()).filter((s) => s.length > 0);
}

/** The enclosing `bpmn:process` id (provenance for the `model:<processId>` tag), best-effort. */
function processId(xml: string): string | undefined {
  const m = xml.match(/<[\w.-]*:?process\b[^>]*>/);
  return m ? shapeAttr(m[0], "id") : undefined;
}

// One `nano:shape` element: capture its open-tag attrs (2) and inner body (3, empty when self-closing).
const SHAPE_RE = /<([\w.-]*:)?shape\b([^>]*?)(?:\/>|>([\s\S]*?)<\/\1?shape\s*>)/g;
// One composition op child (`nano:carry|project|extend|reference`): the local name (2) + its attrs (3).
const SHAPE_OP_RE = /<([\w.-]*:)?(carry|project|extend|reference)\b([^>]*?)\/?>/g;

/** Parse one composition-op element into a `ShapeOp`. An op missing a required attribute is dropped
 * (returns `undefined`) so a malformed model degrades rather than emitting a spurious binding —
 * mirrors `parse_shape_op` in `envelope_scan.rs`. */
function parseShapeOp(local: string, attrs: string): ShapeOp | undefined {
  const tag = `<x ${attrs}>`;
  switch (local) {
    case "carry": {
      const ref = shapeAttr(tag, "ref");
      return ref ? { op: "carry", ref } : undefined;
    }
    case "project": {
      const ref = shapeAttr(tag, "ref");
      if (!ref) return undefined;
      return { op: "project", ref, fields: splitFields(shapeAttr(tag, "fields")), via: shapeAttr(tag, "via") };
    }
    case "extend": {
      const name = shapeAttr(tag, "name");
      const type = shapeAttr(tag, "type");
      if (!name || !type) return undefined;
      return { op: "extend", name, type, optional: shapeBool(tag, "optional"), list: shapeBool(tag, "list") };
    }
    case "reference": {
      const name = shapeAttr(tag, "name");
      const ref = shapeAttr(tag, "ref");
      if (!name || !ref) return undefined;
      return { op: "reference", name, ref, spread: shapeBool(tag, "spread"), list: shapeBool(tag, "list") };
    }
    default:
      return undefined;
  }
}

/** Scan one BPMN document for its `nano:shape` declarations (ADR 0040 §9), in document order, each
 * tagged with the enclosing process for provenance. A shape with no `id` is skipped; op children
 * are folded in author (XML) order. This is the standalone-`urban-gen` port of the shape-parsing
 * half of the console's `envelope_scan.rs`. */
export function scanModelShapes(xml: string): ShapeDecl[] {
  const proc = processId(xml);
  const out: ShapeDecl[] = [];
  let sm: RegExpExecArray | null;
  SHAPE_RE.lastIndex = 0;
  while ((sm = SHAPE_RE.exec(xml)) !== null) {
    const open = `<x ${sm[2]}>`;
    const id = shapeAttr(open, "id");
    if (!id) continue;
    const name = shapeAttr(open, "name");
    const body = sm[3] ?? "";
    const ops: ShapeOp[] = [];
    let om: RegExpExecArray | null;
    SHAPE_OP_RE.lastIndex = 0;
    while ((om = SHAPE_OP_RE.exec(body)) !== null) {
      const op = parseShapeOp(om[2], om[3] ?? "");
      if (op) ops.push(op);
    }
    out.push({ id, name, process: proc, ops });
  }
  return out;
}

/** A scan/resolve-time problem with a shape, surfaced like the `workers[]` drift warning (never a
 * silent merge). A shape with any `error` diagnostic is omitted from the fuse; a `warning` (e.g. a
 * deliberate field shadow) still resolves. */
export interface ShapeDiagnostic {
  /** The offending shape id. */
  shape: string;
  kind:
    | "unresolved-reference"
    | "reference-cycle"
    | "field-conflict"
    | "unknown-field"
    | "duplicate-id"
    | "ambiguous-reference"
    | "nominal-table-ref"
    | "same-id-collision";
  severity: "error" | "warning";
  message: string;
}

/** The result of resolving the project's shapes against the leaf fuse. */
export interface ShapeResolution {
  /** The resolved shapes as registry entries, keyed by shape id, ready to fold into the manifest
   * `types` registry before `emitDomainModel`. */
  types: DomainTypeRegistry;
  diagnostics: ShapeDiagnostic[];
}

/** An entity the fuse can resolve a `carry`/`project`/`reference` against: its field map, plus (DB
 * tables only) its FK columns for `via`-path validation. */
interface FuseEntity {
  fields: Record<string, DomainFieldDef>;
  /** FK column name → referenced table, for `project via` validation. */
  fks?: Record<string, string>;
}

/** Map one datasource column to a domain field. A nullable column widens to `optional` (the
 * composed shape is a motion snapshot: an absent value reads as undefined, not SQL NULL). The
 * manifest keyword is inferred from the column's SQLite affinity so it flows through `fieldTsType`
 * like any declared field; affinities with no keyword (BLOB/opaque) fall back to `json`. */
export function columnToField(col: ColumnMeta): DomainFieldDef {
  const ts = sqliteAffinityToTs(col.type);
  const keyword = ts === "string" || ts === "number" || ts === "boolean" ? ts : "json";
  const nullable = !(col.notNull || col.primaryKey);
  return nullable ? { type: keyword, optional: true } : { type: keyword };
}

/** Build the leaf entity index the shape fold resolves references against: every datasource table
 * (by raw wire name, and by `source.table` to disambiguate a name shared across sources) and every
 * manifest `type` (by id). A raw table name shared across sources keeps the first
 * (default-source-first) binding; the qualified `source.table` alias is always unambiguous.
 *
 * When a manifest `type` id collides with a bare table name, the **type wins** the unqualified id
 * (it is the more first-class, `DomainTypes`-visible entity) and the collision is surfaced via
 * `ambiguousIds` so resolution can warn; the table stays reachable through its `source.table`
 * alias. `tableIds` records every id (bare + qualified) that resolves to a DB table, so a nominal
 * reference (which the emitter can only express against `DomainTypes` keys) can be rejected. */
function leafEntityIndex(
  sources: SourceSchema[],
  types: DomainTypeRegistry,
): { index: Map<string, FuseEntity>; tableIds: Set<string>; ambiguousIds: Set<string> } {
  const index = new Map<string, FuseEntity>();
  const tableIds = new Set<string>();
  for (const s of sources) {
    for (const t of s.tables) {
      const fields: Record<string, DomainFieldDef> = {};
      const fks: Record<string, string> = {};
      for (const c of t.columns) fields[c.name] = columnToField(c);
      // Store FK targets as the unambiguous `source.table` id (FKs are intra-source) so `via`-path
      // following resolves the intended table, never a same-named table in another source or a
      // type-preferred bare id.
      for (const fk of t.foreignKeys ?? []) fks[fk.column] = `${s.source}.${fk.refTable}`;
      const entity: FuseEntity = { fields, fks };
      index.set(`${s.source}.${t.name}`, entity);
      tableIds.add(`${s.source}.${t.name}`);
      if (!index.has(t.name)) {
        index.set(t.name, entity);
        tableIds.add(t.name);
      }
    }
  }
  const ambiguousIds = new Set<string>();
  for (const [id, def] of Object.entries(types)) {
    // The manifest type wins an unqualified id that also names a table; the table remains
    // reachable by its `source.table` alias.
    if (tableIds.has(id)) ambiguousIds.add(id);
    index.set(id, { fields: { ...def.fields } });
  }
  return { index, tableIds, ambiguousIds };
}

/** The shape ids a shape references (carry/project/reference targets, and an `extend` whose type
 * names a shape) — the edges of the shape dependency graph. */
function referencedShapeIds(shape: ShapeDecl, shapeIds: Set<string>): string[] {
  const refs = new Set<string>();
  for (const op of shape.ops) {
    if (op.op === "carry" || op.op === "project" || op.op === "reference") {
      if (shapeIds.has(op.ref)) refs.add(op.ref);
    } else if (op.op === "extend" && shapeIds.has(op.type)) {
      refs.add(op.type);
    }
  }
  return [...refs];
}

/** Structural equality of two domain field defs (`type` + normalized optional/list flags), so a
 * differing property insertion order does not read as a conflict. */
function sameFieldDef(a: DomainFieldDef, b: DomainFieldDef): boolean {
  return a.type === b.type && !!a.optional === !!b.optional && !!a.list === !!b.list;
}

/**
 * Resolve the project's composed shapes into `DomainTypeDef`s and diagnostics (ADR 0040 §10).
 * Leaves (DB tables, manifest types) fuse first; shapes resolve in dependency order so a shape can
 * carry another shape regardless of declaration order. A shape in a reference cycle, or one that
 * names an unresolvable id, is omitted (degrades to untyped) with an `error` diagnostic; a
 * deliberate field shadow with a differing type resolves with a `field-conflict` warning.
 */
export function resolveShapes(
  shapes: ShapeDecl[],
  types: DomainTypeRegistry,
  sources: SourceSchema[] = [],
): ShapeResolution {
  const diagnostics: ShapeDiagnostic[] = [];
  const resolved: DomainTypeRegistry = {};
  if (shapes.length === 0) return { types: resolved, diagnostics };

  const { index, tableIds, ambiguousIds } = leafEntityIndex(sources, types);
  // A nominal reference (an `extend` type or a non-spread `reference`) must resolve to a
  // `DomainTypes` key at emit time — a manifest type or a resolved shape id. DB tables are
  // spread-only (their fields flatten via carry/project); nominally referencing one would degrade
  // to `unknown` in the emitted `.d.ts`, so we reject.
  const nominalIds = new Set<string>(Object.keys(types));
  // Duplicate shape ids are fuse-identity collisions: since resolution keys by id, a later
  // declaration would silently shadow an earlier one. Report every id that appears more than once
  // and omit all of its declarations from resolution.
  const idCounts = new Map<string, number>();
  for (const s of shapes) if (s.id) idCounts.set(s.id, (idCounts.get(s.id) ?? 0) + 1);
  const duplicated = new Set<string>();
  for (const [id, n] of idCounts) {
    if (n > 1) {
      duplicated.add(id);
      diagnostics.push({
        shape: id,
        kind: "duplicate-id",
        severity: "error",
        message: `shape id "${id}" is declared ${n} times; ids are fuse identities and must be unique`,
      });
    }
  }
  const byId = new Map<string, ShapeDecl>();
  for (const s of shapes) if (s.id && !duplicated.has(s.id)) byId.set(s.id, s);
  const shapeIds = new Set(byId.keys());

  // Cycle detection over the shape-only dependency graph (DFS three-colour). Every shape on a back
  // edge is failed; the reported path aids the maker's fix.
  const failed = new Set<string>();
  const colour = new Map<string, 0 | 1 | 2>(); // 0=unvisited 1=on-stack 2=done
  const visit = (id: string, stack: string[]): void => {
    colour.set(id, 1);
    stack.push(id);
    for (const dep of referencedShapeIds(byId.get(id)!, shapeIds)) {
      const c = colour.get(dep) ?? 0;
      if (c === 1) {
        const cycle = stack.slice(stack.indexOf(dep)).concat(dep);
        for (const n of cycle) {
          if (!failed.has(n)) {
            failed.add(n);
            diagnostics.push({
              shape: n,
              kind: "reference-cycle",
              severity: "error",
              message: `shape "${n}" is part of a reference cycle: ${cycle.join(" → ")}`,
            });
          }
        }
      } else if (c === 0) {
        visit(dep, stack);
      }
    }
    stack.pop();
    colour.set(id, 2);
  };
  for (const id of byId.keys()) if ((colour.get(id) ?? 0) === 0) visit(id, []);

  // Topological resolution: resolve a shape only after its (non-failed) shape dependencies, adding
  // each resolved shape to the index so later shapes see it.
  const done = new Set<string>();
  const resolveOne = (shape: ShapeDecl): void => {
    if (done.has(shape.id) || failed.has(shape.id)) return;
    // Resolve shape dependencies first (they may themselves be pending).
    for (const dep of referencedShapeIds(shape, shapeIds)) {
      const d = byId.get(dep);
      if (d && !done.has(dep) && !failed.has(dep)) resolveOne(d);
    }

    const fields: Record<string, DomainFieldDef> = {};
    let broken = false;
    const addField = (name: string, field: DomainFieldDef): void => {
      const existing = fields[name];
      if (existing && !sameFieldDef(existing, field)) {
        diagnostics.push({
          shape: shape.id,
          kind: "field-conflict",
          severity: "warning",
          message:
            `field "${name}" is contributed twice with differing types; the later value wins (author-order fold)`,
        });
      }
      fields[name] = field; // last (author-order) wins
    };
    const lookup = (ref: string): FuseEntity | undefined => index.get(ref);
    const unresolved = (ref: string): void => {
      broken = true;
      diagnostics.push({
        shape: shape.id,
        kind: "unresolved-reference",
        severity: "error",
        message: `shape "${shape.id}" references unknown entity "${ref}"`,
      });
    };
    // A bare id that names both a manifest type and a table resolves to the type; warn so the
    // (silent) precedence is visible and the maker can qualify.
    const noteAmbiguity = (ref: string): void => {
      if (ambiguousIds.has(ref)) {
        diagnostics.push({
          shape: shape.id,
          kind: "ambiguous-reference",
          severity: "warning",
          message:
            `"${ref}" names both a manifest type and a table; resolved to the type — qualify as "<source>.${ref}" to target the table`,
        });
      }
    };
    // Report a nominal reference (extend type / non-spread reference) that targets a DB table,
    // which cannot be expressed as a `DomainTypes` ref (it would degrade to `unknown`); the maker
    // should spread it instead (carry/project or spread=true).
    const nominalTableRef = (kind: string, ref: string): void => {
      broken = true;
      diagnostics.push({
        shape: shape.id,
        kind: "nominal-table-ref",
        severity: "error",
        message:
          `${kind} nominally references table "${ref}", which is not a DomainTypes entity; spread its fields (carry/project or reference spread="true") instead`,
      });
    };

    for (const op of shape.ops) {
      switch (op.op) {
        case "carry": {
          const e = lookup(op.ref);
          if (!e) {
            unresolved(op.ref);
            break;
          }
          noteAmbiguity(op.ref);
          for (const [k, f] of Object.entries(e.fields)) addField(k, f);
          break;
        }
        case "project": {
          const e = lookup(op.ref);
          if (!e) {
            unresolved(op.ref);
            break;
          }
          noteAmbiguity(op.ref);
          for (const fname of op.fields) {
            const f = e.fields[fname];
            if (!f) {
              broken = true;
              diagnostics.push({
                shape: shape.id,
                kind: "unknown-field",
                severity: "error",
                message: `projected field "${fname}" is not a field of "${op.ref}"`,
              });
              continue;
            }
            addField(fname, f);
          }
          if (op.via) validateVia(shape.id, op.via, index, diagnostics);
          break;
        }
        case "extend": {
          if (!isPrimitiveKeyword(op.type)) {
            if (nominalIds.has(op.type)) {
              // ok — a manifest type or an already-resolved shape id
            } else if (tableIds.has(op.type)) {
              nominalTableRef(`extend field "${op.name}"`, op.type);
              break;
            } else {
              broken = true;
              diagnostics.push({
                shape: shape.id,
                kind: "unresolved-reference",
                severity: "error",
                message:
                  `extend field "${op.name}" has type "${op.type}", which is neither a scalar keyword nor a fused entity`,
              });
              break;
            }
          }
          const field: DomainFieldDef = { type: op.type };
          if (op.optional) field.optional = true;
          if (op.list) field.list = true;
          addField(op.name, field);
          break;
        }
        case "reference": {
          const e = lookup(op.ref);
          if (!e) {
            unresolved(op.ref);
            break;
          }
          if (op.spread) {
            noteAmbiguity(op.ref);
            for (const [k, f] of Object.entries(e.fields)) addField(k, f);
          } else if (!nominalIds.has(op.ref)) {
            // `e` exists but the id is not a DomainTypes key — it is a DB table.
            nominalTableRef(`reference "${op.name}"`, op.ref);
          } else {
            const field: DomainFieldDef = { type: op.ref };
            if (op.list) field.list = true;
            addField(op.name, field);
          }
          break;
        }
      }
    }

    // same-id collision: the shape id shadows a leaf entity it does not source. The shape composes
    // that entity when it references it under any id (bare or `source.table` alias) — since the
    // index maps every alias to the same `FuseEntity` instance, compare by identity rather than by
    // the bare id alone.
    const collidingEntity = index.get(shape.id);
    const composesColliding =
      collidingEntity !== undefined &&
      shape.ops.some((o) => o.op !== "extend" && index.get(o.ref) === collidingEntity);
    if (collidingEntity !== undefined && !composesColliding) {
      diagnostics.push({
        shape: shape.id,
        kind: "same-id-collision",
        severity: "error",
        message:
          `shape id "${shape.id}" collides with an existing fused entity it does not compose`,
      });
      broken = true;
    }

    done.add(shape.id);
    if (broken) {
      failed.add(shape.id);
      return;
    }
    const def: DomainTypeDef = { name: shape.name, fields };
    resolved[shape.id] = def;
    // Later shapes may carry this one; expose its resolved fields to the index and mark it
    // nominal-referenceable (it will be a `DomainTypes` key).
    index.set(shape.id, { fields });
    nominalIds.add(shape.id);
  };
  for (const s of shapes) if (s.id && !duplicated.has(s.id)) resolveOne(s);

  return { types: resolved, diagnostics };
}

/** Validate a `project via` FK path (`Entity.column[.column...]`): the leading entity must resolve
 * and carry the named column (an FK column on a DB table, or any field on a manifest type/shape).
 * Deeper hops are validated leniently — the FK target is followed when the leading entity is a DB
 * table with that FK. */
function validateVia(
  shape: string,
  via: string,
  index: Map<string, FuseEntity>,
  diagnostics: ShapeDiagnostic[],
): void {
  const parts = via.split(".");
  if (parts.length < 2) {
    diagnostics.push({
      shape,
      kind: "unknown-field",
      severity: "warning",
      message: `via path "${via}" is not of the form Entity.column`,
    });
    return;
  }
  // Resolve the starting entity as the *longest* dotted prefix present in the index (so a qualified
  // `source.table` start works, not just a bare id), leaving at least one trailing segment as a hop
  // column. The remaining segments are hop columns.
  let entity: FuseEntity | undefined;
  let start = 0;
  for (let p = 1; p < parts.length; p++) {
    const candidate = parts.slice(0, p).join(".");
    const hit = index.get(candidate);
    if (hit) {
      entity = hit;
      start = p;
    }
  }
  if (!entity) {
    diagnostics.push({
      shape,
      kind: "unknown-field",
      severity: "warning",
      message: `via path "${via}" starts at unknown entity "${parts.slice(0, -1).join(".")}"`,
    });
    return;
  }
  let cursor: FuseEntity = entity;
  for (let i = start; i < parts.length; i++) {
    const col = parts[i];
    const hasField = Object.prototype.hasOwnProperty.call(cursor.fields, col);
    const fkTarget: string | undefined = cursor.fks?.[col];
    if (!hasField && !fkTarget) {
      diagnostics.push({
        shape,
        kind: "unknown-field",
        severity: "warning",
        message: `via path "${via}" hops through unknown column "${col}"`,
      });
      return;
    }
    // Follow the FK to the next entity when we can; otherwise stop (lenient).
    const next: FuseEntity | undefined = fkTarget ? index.get(fkTarget) : undefined;
    if (!next) return;
    cursor = next;
  }
}

// --- the structured fused domain model: domain.json (ADR 0040 §1, OQ1) -----------------------
//
// The computed fuse is persisted as a generated, git-ignored `nano-generated/domain.json` — a
// fast-read structured index for the IDE/codegen so a reader need not re-scan every model +
// datasource. It is a *cache*, never a source: the `domaintypes` op regenerates it write-through on
// any source change, and an `inputsHash` over its own content lets a reader detect staleness
// cheaply.

/** The basename of the generated structured fuse cache (ADR 0040 §1). */
export const DOMAIN_MODEL_JSON = "domain.json";

/** A field of a fused entity in `domain.json`: the resolved domain field plus its name. `type` is
 * a primitive keyword or the id of another fused entity. */
interface FusedFieldJson extends DomainFieldDef {
  name: string;
}

/** One fused entity in `domain.json`, tagged with its provenance and kind. */
interface FusedEntityJson {
  id: string;
  kind: "table" | "type" | "shape";
  /** `db:<source>.<table>` | `manifest:<id>` | `model:<processId>`. */
  provenance: string;
  name?: string;
  fields: FusedFieldJson[];
}

/** FNV-1a (32-bit) hex of a string — a small, dependency-free content tag for the fuse cache's
 * `inputsHash` (staleness detection, not security). */
function fnv1aHex(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

/** Convert a resolved field map to the ordered `domain.json` field list. */
function fieldsJson(fields: Record<string, DomainFieldDef>): FusedFieldJson[] {
  return Object.entries(fields ?? {}).map(([name, f]) => {
    const out: FusedFieldJson = { name, type: f.type };
    if (f.optional) out.optional = true;
    if (f.list) out.list = true;
    return out;
  });
}

/** One model-level metadata entry (`nano:meta`) as `emitDomainModelJson` consumes it. Mirrors
 * `meta.ts`'s `MetaDecl` (kept local so the fuse cache does not depend on the meta deriver). */
export interface FusedMetaDecl {
  process?: string;
  key: string;
  value: string;
}

/**
 * Emit `domain.json`: the structured Fused Domain Model (ADR 0040 §1). Assembles every fused
 * entity — DB tables (`db:` provenance), manifest `types` (`manifest:`), and composed motion shapes
 * (`model:<processId>`, or bare `model` for an unsaved editor shape with no process) — with its
 * resolved fields, plus the model-level metadata and the shape diagnostics. An `inputsHash` —
 * FNV-1a (hex) over the compact `JSON.stringify` of the model object with `inputsHash` omitted
 * (property-insertion order, not the pretty-printed bytes) — tags the cache for staleness.
 */
export function emitDomainModelJson(input: {
  sources: SourceSchema[];
  default?: string;
  manifestTypes: DomainTypeRegistry;
  /** Resolved shapes paired with their declaration (for provenance/label). */
  shapes: { decl: ShapeDecl; def: DomainTypeDef }[];
  meta: FusedMetaDecl[];
  diagnostics: ShapeDiagnostic[];
}): string {
  const entities: FusedEntityJson[] = [];
  for (const s of input.sources) {
    for (const t of s.tables) {
      const fields: Record<string, DomainFieldDef> = {};
      for (const c of t.columns) fields[c.name] = columnToField(c);
      entities.push({
        id: `${s.source}.${t.name}`,
        kind: "table",
        provenance: `db:${s.source}.${t.name}`,
        fields: fieldsJson(fields),
      });
    }
  }
  for (const [id, def] of Object.entries(input.manifestTypes)) {
    entities.push({
      id,
      kind: "type",
      provenance: `manifest:${id}`,
      ...(def.name ? { name: def.name } : {}),
      fields: fieldsJson(def.fields),
    });
  }
  for (const { decl, def } of input.shapes) {
    entities.push({
      id: decl.id,
      kind: "shape",
      provenance: decl.process ? `model:${decl.process}` : "model",
      ...(def.name ?? decl.name ? { name: def.name ?? decl.name } : {}),
      fields: fieldsJson(def.fields),
    });
  }
  const meta = input.meta
    .filter((m) => (m?.key ?? "").trim().length > 0)
    .map((m) => ({ ...(m.process ? { process: m.process } : {}), key: m.key, value: m.value ?? "" }));
  const model = {
    $generated:
      "nanobpmn ADR 0040 §1 Fused Domain Model — do not edit; regenerated by the domaintypes op",
    version: 1,
    ...(input.default ? { default: input.default } : {}),
    sources: input.sources.map((s) => s.source),
    entities,
    meta,
    diagnostics: input.diagnostics,
    inputsHash: "",
  };
  model.inputsHash = fnv1aHex(JSON.stringify({ ...model, inputsHash: undefined }));
  return `${JSON.stringify(model, null, 2)}\n`;
}
