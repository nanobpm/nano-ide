// Slice S4 (retrieval) — the READ seam over the git system-of-record.
//
// Retrieval treats git as the authoritative store: records live on disk under
// the exact layout S3 defines (`records/<scope>/<scopeRef-bucket>/<id>.json`),
// and this module reads them back. It is deliberately abstracted behind a
// {@link RecordSource} interface so the derived hot cache, the query layer, and
// a future PII/mutable backend all read through one seam rather than assuming a
// public-git working copy. {@link GitRecordSource} is the default MVP: it walks
// a resolved substrate working copy (the local checkout S1 produces, pinned to
// its ref) using the S3 layout helpers to select record files.
//
// The source NEVER caches — it always reflects what is on disk (== the git ref
// that is checked out). Caching is the derived index's job (see cache.ts), and
// the index is disposable: a cold/empty index falls back to reading here, so
// retrieval is correct even before any index is built.

import type { Dirent } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";
import {
  isRecordPath,
  LAYOUT_ROOT,
  recordDir,
  scopeDir,
} from "../git/index.ts";
import {
  type MemoryRecord,
  type MemoryScope,
  validateMemoryRecord,
} from "../schema/index.ts";

/** A record as it is stored in the substrate: its layout path + the record. */
export interface StoredRecord {
  /** Substrate-root-relative POSIX path the record lives at (S3 layout). */
  readonly path: string;
  /** The validated memory record parsed from that file. */
  readonly record: MemoryRecord;
}

/**
 * A path-scoped selector for a namespace partition in the S3 layout. Reading a
 * single `(scope, scopeRef)` — or a whole `scope` — is a cheap structured query
 * because the layout partitions records into one directory per namespace, so the
 * source can walk just that subtree instead of the whole store.
 */
export interface NamespaceSelector {
  readonly scope: MemoryScope;
  /** When present, narrows to one namespace bucket; absent lists the scope. */
  readonly scopeRef?: string;
}

/**
 * The read seam retrieval is built on. A future mutable/PII backend can
 * implement this differently (e.g. against a database) without the cache, the
 * query layer, or callers changing.
 */
export interface RecordSource {
  /**
   * List every stored record, optionally narrowed to one namespace partition
   * (a cheap, path-scoped read that walks only that subtree of the S3 layout).
   * Invalid / unparseable files under the layout root are skipped, not fatal —
   * a single corrupt file must never make the whole store unreadable.
   */
  list(selector?: NamespaceSelector): Promise<readonly StoredRecord[]>;
  /**
   * Read a single record by its substrate-relative layout path, or `undefined`
   * when it is absent or not a valid record file.
   */
  read(relPath: string): Promise<StoredRecord | undefined>;
}

/** The minimal resolved-handle shape the read source consumes (from S1). */
export interface ResolvedReadHandle {
  /** Absolute path to the local substrate working copy (checked out at `ref`). */
  readonly localPath: string;
  /** The git ref the working copy is pinned to (informational for reads). */
  readonly ref?: string;
}

/** Thrown when the underlying substrate cannot be read at all. */
export class RecordSourceError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "RecordSourceError";
  }
}

function isEnoent(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}

/** Convert a native absolute path to a substrate-root-relative POSIX path. */
function toPosixRelative(root: string, absPath: string): string {
  return relative(root, absPath).split(sep).join("/");
}

/**
 * The default git-backed read source: reads records straight off a local
 * substrate working copy. Git is the system of record; this holds no state of
 * its own, so every call reflects the current on-disk (== checked-out ref)
 * content. That is what makes the derived index safe to throw away and rebuild.
 */
export class GitRecordSource implements RecordSource {
  readonly #root: string;

  constructor(handle: ResolvedReadHandle | string) {
    const root = typeof handle === "string" ? handle : handle.localPath;
    if (!isAbsolute(root)) {
      throw new RecordSourceError(
        `substrate root must be an absolute path, got: ${root}`,
      );
    }
    this.#root = root;
  }

  /** Absolute path of the substrate working copy this source reads from. */
  get root(): string {
    return this.#root;
  }

  async list(selector?: NamespaceSelector): Promise<readonly StoredRecord[]> {
    const subtree = selectorSubtree(selector);
    const walkRoot = join(this.#root, subtree);

    let entries: Dirent[];
    try {
      entries = await readdir(walkRoot, { recursive: true, withFileTypes: true });
    } catch (error) {
      // A missing subtree (e.g. an empty store, or a namespace with no records)
      // is an empty result, not an error — a cold read must degrade gracefully.
      if (isEnoent(error)) {
        return [];
      }
      throw new RecordSourceError(`failed to list substrate at ${walkRoot}`, {
        cause: error,
      });
    }

    const results: StoredRecord[] = [];
    for (const entry of entries) {
      if (!entry.isFile()) {
        continue;
      }
      const absPath = join(entry.parentPath, entry.name);
      const relPath = toPosixRelative(this.#root, absPath);
      if (!isRecordPath(relPath)) {
        continue;
      }
      const stored = await this.#readAbsolute(absPath, relPath);
      if (stored !== undefined) {
        results.push(stored);
      }
    }
    // Deterministic order regardless of filesystem enumeration order.
    results.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    return results;
  }

  async read(relPath: string): Promise<StoredRecord | undefined> {
    const normalised = relPath.replace(/\\/g, "/").replace(/^\.\//, "");
    if (!isRecordPath(normalised)) {
      return undefined;
    }
    return this.#readAbsolute(join(this.#root, normalised), normalised);
  }

  async #readAbsolute(
    absPath: string,
    relPath: string,
  ): Promise<StoredRecord | undefined> {
    let raw: string;
    try {
      raw = await readFile(absPath, "utf8");
    } catch (error) {
      if (isEnoent(error)) {
        return undefined;
      }
      throw new RecordSourceError(`failed to read record at ${relPath}`, {
        cause: error,
      });
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      // A corrupt / non-JSON file under the layout is skipped, not fatal.
      return undefined;
    }

    const result = validateMemoryRecord(parsed);
    if (!result.ok) {
      // A file that does not validate against the S2 schema is not a record we
      // can safely surface — skip it rather than return an unchecked shape.
      return undefined;
    }
    return { path: relPath, record: result.record };
  }
}

/**
 * The layout subtree to walk for a selector: one namespace bucket, one whole
 * scope, or the entire layout root. Keeps path-scoping in one place so the
 * cache and query layers never re-derive layout paths themselves.
 */
export function selectorSubtree(selector?: NamespaceSelector): string {
  if (selector === undefined) {
    return LAYOUT_ROOT;
  }
  return selector.scopeRef === undefined
    ? scopeDir(selector.scope)
    : recordDir(selector.scope, selector.scopeRef);
}
