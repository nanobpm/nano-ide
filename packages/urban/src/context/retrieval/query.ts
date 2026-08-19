// Slice S4 (retrieval) — the query model: frontmatter filtering + text search.
//
// A retrieval query is a conjunction of independent predicates: path-scoped
// namespace narrowing (scope/scopeRef), frontmatter filtering on the typed
// record fields (mode/provenance/authority/…), and a free-text search across
// the record body. Every clause is optional; an empty query matches everything.
// The matching here is pure and cache-agnostic — it runs identically over
// records read straight from git (cold cache) or served from the hot index.

import type {
  MemoryAuthority,
  MemoryMode,
  MemoryProvenance,
  MemoryRecord,
  MemoryScope,
} from "../schema/index.ts";

/** A field value that may be given as a single value or an OR-set of values. */
export type OneOrMany<T> = T | readonly T[];

/**
 * A retrieval query. All clauses are ANDed together; a clause given as an array
 * is an OR over its members. Absent clauses impose no constraint.
 */
export interface RetrievalQuery {
  /** Structured / path-scoped: restrict to one or more scope ladder levels. */
  readonly scope?: OneOrMany<MemoryScope>;
  /** Structured / path-scoped: restrict to one or more `scopeRef` namespaces. */
  readonly scopeRef?: OneOrMany<string>;
  /** Frontmatter filter: normative vs empirical. */
  readonly mode?: OneOrMany<MemoryMode>;
  /** Frontmatter filter: where the record came from. */
  readonly provenance?: OneOrMany<MemoryProvenance>;
  /** Frontmatter filter: hypothesis vs authoritative. */
  readonly authority?: OneOrMany<MemoryAuthority>;
  /** Frontmatter filter: exact record id(s). */
  readonly id?: OneOrMany<string>;
  /** Frontmatter filter: exact subject(s). */
  readonly subject?: OneOrMany<string>;
  /**
   * Free-text search across the record body — case-insensitive substring match
   * over `statement` (and `subject`, when present). This is the "text search
   * across record bodies" clause; it composes with the structured filters.
   */
  readonly text?: string;
  /** Cap the number of results returned (applied after ordering). */
  readonly limit?: number;
}

function toSet<T>(value: OneOrMany<T> | undefined): ReadonlySet<T> | undefined {
  if (value === undefined) {
    return undefined;
  }
  return new Set(Array.isArray(value) ? value : [value]);
}

function matchesOneOf<T>(
  allowed: ReadonlySet<T> | undefined,
  actual: T | undefined,
): boolean {
  if (allowed === undefined) {
    return true;
  }
  return actual !== undefined && allowed.has(actual);
}

/**
 * A query compiled to sets for O(1) membership tests. Building it once and
 * reusing it across a candidate list avoids re-normalising the query per record.
 */
export interface CompiledQuery {
  readonly scope?: ReadonlySet<MemoryScope>;
  readonly scopeRef?: ReadonlySet<string>;
  readonly mode?: ReadonlySet<MemoryMode>;
  readonly provenance?: ReadonlySet<MemoryProvenance>;
  readonly authority?: ReadonlySet<MemoryAuthority>;
  readonly id?: ReadonlySet<string>;
  readonly subject?: ReadonlySet<string>;
  readonly text?: string;
  readonly limit?: number;
}

/** Compile a raw query into membership sets + a normalised (lowercased) needle. */
export function compileQuery(query: RetrievalQuery): CompiledQuery {
  return {
    scope: toSet(query.scope),
    scopeRef: toSet(query.scopeRef),
    mode: toSet(query.mode),
    provenance: toSet(query.provenance),
    authority: toSet(query.authority),
    id: toSet(query.id),
    subject: toSet(query.subject),
    text: query.text === undefined ? undefined : query.text.toLowerCase(),
    limit: query.limit,
  };
}

/** `true` iff `record` satisfies every clause of the compiled query. */
export function matchesQuery(record: MemoryRecord, query: CompiledQuery): boolean {
  if (!matchesOneOf(query.scope, record.scope)) return false;
  if (!matchesOneOf(query.scopeRef, record.scopeRef)) return false;
  if (!matchesOneOf(query.mode, record.mode)) return false;
  if (!matchesOneOf(query.provenance, record.provenance)) return false;
  if (!matchesOneOf(query.authority, record.authority)) return false;
  if (!matchesOneOf(query.id, record.id)) return false;
  if (!matchesOneOf(query.subject, record.subject)) return false;
  if (query.text !== undefined && !matchesText(record, query.text)) return false;
  return true;
}

/** Case-insensitive substring search across the record's textual body. */
function matchesText(record: MemoryRecord, needle: string): boolean {
  if (needle === "") {
    return true;
  }
  const haystacks = [record.statement, record.subject ?? "", record.id];
  return haystacks.some((field) => field.toLowerCase().includes(needle));
}
