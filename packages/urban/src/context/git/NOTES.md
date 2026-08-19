# `@nanobpm/urban/context/git` — S3 git substrate + PR-governance

The git-as-system-of-record **write + governance** layer. Built on the merged
S1 (binding), S2 (schema) and S6 (PII guard) slices — it composes them and does
not re-implement clone/pull, the record schema, or the PII classifier/guard.

## Write paths (`ContextWriter`)

Construct a writer from a resolved substrate handle (`{ localPath, ref }` from
`@nanobpm/urban/context/binding`):

```ts
import { ContextWriter } from "@nanobpm/urban/context/git";
const writer = new ContextWriter(resolvedHandle); // no wiring needed
```

- `appendRecord(record)` — **append-via-commit**: validates the record against
  the S2 schema (incl. the forgery-resistance invariants), runs the mandatory
  PII guard, then commits it on a fresh write branch and merges it onto the base
  branch. For `human` / `measured` / `instance` records. **`agent-retro` is
  rejected here** — a hypothesis must go through governance.
- `proposePrior(record)` — **PR-governance**: writes the record as a *proposed
  prior* on a `context/proposal/<id>-<rand>` bot branch, left **unmerged**. This
  is the git-only stand-in for a bot PR. Mandatory for `agent-retro`.
- `ratify(proposal)` — **merges** the bot branch onto the base branch. Merge ==
  ratification. It accepts the hypothesis onto the authoritative line; it never
  upgrades an `agent-retro` record to `authoritative` (the S2 schema forbids
  that), so an unratified — or even a ratified — prior can never present as a
  measured/authoritative fact.
- `isRatified(proposal)` — `true` iff the proposal's commit is an ancestor of
  the base branch.

Concurrency: every write lands on its own uniquely-named branch, so concurrent
writers never clobber each other; disjoint records merge cleanly. Operations are
serialised within a single `ContextWriter` (one working tree).

## PII enforcement BY CONSTRUCTION

`PreCommitGuardRegistry` is **always** seeded with the mandatory S6
`preCommitPiiGuard` as its first, non-removable member and has no removal API.
The writer runs `assertAll` before **every** commit, so a PII-carrying write is
rejected before it is committed — on the default code path, with no caller
opt-in. Additional guards can only be added (stricter), never subtracted.

## Path / namespace partitioning (read by S4 & S6-CI)

Records are persisted under a stable layout, exported as a small helper so S4
retrieval and the S6 CI scan read the **same** scheme:

```
records/<scope>/<scopeRef-bucket>/<id>.json
```

- `LAYOUT_ROOT` (`"records"`), `RECORD_FILE_EXTENSION` (`".json"`),
  `UNSCOPED_BUCKET` (`"_"`, for records with no `scopeRef`).
- `scopeDir(scope)`, `recordDir(scope, scopeRef?)`, `recordRelativePath(record)`.
- `sanitizeSegment(value)` — every path component is reduced to a
  filesystem-safe segment that can never contain a separator or `..`
  (path-traversal safe by construction).
- `isRecordPath(relPath)` — selects record files while walking the substrate.

## Seam for a future PII/mutable backend

The write path is abstracted over the `WriteSubstrate` interface, not hard-wired
to public git. `GitWriteSubstrate` is the default git-only MVP implementation; a
future mutable/PII backend (with real erasure) can implement the same interface
without the writer or its callers changing.
