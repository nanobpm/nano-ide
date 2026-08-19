# `@nanobpm/urban/context/retrieval` — S4 retrieval over git

The **read** side of the Urban context layer. It queries the git
system-of-record that S3 (`@nanobpm/urban/context/git`) writes, using the exact
path/namespace layout S3 publishes — it does **not** invent its own layout.
MVP is **git-only**: no external service.

## Query surface (`ContextRetriever`)

Bind a retriever to a resolved substrate handle (the local checkout S1 produces,
`{ localPath, ref }`):

```ts
import { ContextRetriever } from "@nanobpm/urban/context/retrieval";
const retriever = new ContextRetriever({ localPath, ref: "main" });
```

- `query(q)` — the general query. Clauses are **ANDed**; a clause given as an
  array is an **OR-set**. Supports:
  - **structured / path-scoped**: `scope`, `scopeRef` (uses S3's partitioning);
  - **frontmatter filtering**: `mode`, `provenance`, `authority`, `id`,
    `subject` (typed record fields);
  - **text search**: `text` — case-insensitive substring across the record body
    (`statement`, `subject`, `id`);
  - `limit`.
- `byNamespace(scope, scopeRef?)` — path-scoped structured query for one layout
  partition; reads just that subtree when the cache is cold.
- `search(text, filters?)` — text search combined with structured filters.
- `all()` — every record (warms the cache).
- `get(relPath)` — one record by its S3 layout path (bypasses the cache).

## Git is the system of record; the cache is DERIVED and disposable

Retrieval is correct **with a cold/empty cache** — every query falls back to
reading git through the `RecordSource` seam. A query pinned to exactly one
namespace (`scope` + a single `scopeRef`) reads **only that layout partition**,
so a targeted query never pays to build the whole index.

The hot cache (`DerivedRecordIndex`) is a **snapshot projection**, rebuildable
purely from git and never authoritative:

- `retriever.invalidate()` — drop the projection; the next read re-reads git.
- `retriever.rebuild()` — eagerly re-project the whole store from git.
- `retriever.cache.isWarm` — whether a snapshot is currently held.

Callers keep the cache honest by calling `invalidate()` after a write (git
remains the source of truth). A warm cache serves its snapshot until
invalidated/rebuilt — it does not observe writes made after it was warmed.

## Read seam (`RecordSource` / `GitRecordSource`)

Reads go through a `RecordSource` interface, not a hard-wired public-git
assumption. `GitRecordSource` is the default git-only MVP: it walks the resolved
working copy, selects record files with S3's `isRecordPath`, and validates each
against the S2 schema (`validateMemoryRecord`). Corrupt / non-record / invalid
files under the layout are **skipped, not fatal**. A future PII/mutable backend
can implement `RecordSource` without the cache, query layer, or callers changing.

## Seam for a future opt-in embedding index (NOT built)

Semantic/vector retrieval (an OpenMemory / mem0-style **derived** embedding
index) is deliberately **not built** here — MVP retrieval is git-only lexical.
`embedding.ts` declares the `EmbeddingIndex` seam it would plug into
(`reindex(records)` + `semanticSearch(query, k)`), and `ContextRetriever`
accepts an optional `embeddingIndex` for forward-compat. Any such index MUST be
derived and disposable (rebuildable from git, never authoritative), exactly like
the hot cache — a cold embedding index must degrade to the git-backed lexical
path, never to stale/wrong results.
