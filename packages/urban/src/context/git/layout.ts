// Slice S3 (git/governance) — the on-disk path / namespace partitioning.
//
// Records are persisted into the substrate repo under a stable, deterministic
// layout keyed by the record's scope (and, where present, its `scopeRef`). This
// helper is the SINGLE SOURCE OF TRUTH for that layout: the write path (this
// slice) writes to it, and BOTH S4 (retrieval) and the S6 CI slice READ it, so
// it is exported as a small, stable surface rather than duplicated per-consumer.
//
// The scheme is:
//
//   records/<scope>/<scopeRef-bucket>/<id>.json
//
// where `<scope>` is a controlled-vocabulary ladder level (element … corpus),
// `<scopeRef-bucket>` is the sanitised `scopeRef` (or the shared `_` bucket when
// a record carries no `scopeRef`), and `<id>` is the sanitised record id. Every
// path component is sanitised to a filesystem-safe segment that can never
// contain a path separator or `..`, so an untrusted `id`/`scopeRef` can never
// escape the layout root (path-traversal safe by construction).

import { createHash } from "node:crypto";
import type { MemoryRecord, MemoryScope } from "../schema/index.ts";

/** The directory (relative to the substrate root) all records live under. */
export const LAYOUT_ROOT = "records" as const;

/** The on-disk extension every serialised record file carries. */
export const RECORD_FILE_EXTENSION = ".json" as const;

/**
 * The bucket directory used for records that carry no `scopeRef` (e.g. a
 * `corpus`-scoped record). A leading `_` cannot collide with a sanitised
 * `scopeRef` segment (those never begin with `_` unless the raw value did, in
 * which case the hash fallback below applies).
 */
export const UNSCOPED_BUCKET = "_" as const;

/**
 * Reduce an untrusted string to a single filesystem-safe path segment.
 *
 * The result contains only `[A-Za-z0-9._-]`, never a path separator, and is
 * never `""`, `.`, or `..` — so it can never traverse out of its parent
 * directory. When sanitisation is LOSSY (the cleaned form differs from the
 * input, or collapses to a reserved value) a short hash of the ORIGINAL value is
 * appended, so two distinct raw values can never silently collide onto one
 * segment while a clean value is preserved verbatim.
 */
export function sanitizeSegment(value: string): string {
  const cleaned = value
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "")
    .slice(0, 100);
  const reserved = cleaned === "" || cleaned === "." || cleaned === "..";
  if (reserved) {
    return `_${shortHash(value)}`;
  }
  // Preserve a clean, reversible value verbatim; disambiguate a lossy one so
  // distinct inputs never map to the same segment.
  return cleaned === value ? cleaned : `${cleaned}-${shortHash(value)}`;
}

function shortHash(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex").slice(0, 12);
}

/** The directory (relative to the substrate root) that holds a whole scope. */
export function scopeDir(scope: MemoryScope): string {
  return `${LAYOUT_ROOT}/${scope}`;
}

/**
 * The directory a record with the given `scope`/`scopeRef` is partitioned into.
 * Records sharing a `(scope, scopeRef)` namespace land in the same directory, so
 * a retrieval slice can list one namespace cheaply.
 */
export function recordDir(scope: MemoryScope, scopeRef?: string): string {
  const bucket = scopeRef === undefined ? UNSCOPED_BUCKET : sanitizeSegment(scopeRef);
  return `${scopeDir(scope)}/${bucket}`;
}

/**
 * The full path (relative to the substrate root, POSIX separators) a record is
 * persisted at. Deterministic: the same record id/scope always maps to the same
 * path, so re-appending an updated record with the same id overwrites its file
 * in place while git retains the full append-only history.
 */
export function recordRelativePath(record: MemoryRecord): string {
  return `${recordDir(record.scope, record.scopeRef)}/${sanitizeSegment(record.id)}${RECORD_FILE_EXTENSION}`;
}

/**
 * `true` iff `relPath` looks like a record file under the layout root (used by
 * S4 retrieval and the S6 CI scan to select record files while walking the
 * substrate). Accepts POSIX or native separators and rejects anything that is
 * not a `.json` file beneath `records/`.
 */
export function isRecordPath(relPath: string): boolean {
  const normalised = relPath.replace(/\\/g, "/").replace(/^\.\//, "");
  return (
    normalised.startsWith(`${LAYOUT_ROOT}/`) &&
    normalised.endsWith(RECORD_FILE_EXTENSION) &&
    !normalised.includes("..")
  );
}
