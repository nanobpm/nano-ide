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
  ratification. Because the proposal branch may have been created or amended
  outside `proposePrior`, the branch is untrusted, so before merging `ratify`:
  (1) refuses any branch outside the `context/proposal/` namespace; (2) rejects any
  proposal whose `baseBranch` differs from the writer's **own resolved base**, and
  merges onto that resolved base (never the caller-supplied one), so a mutated
  handle can't steer the merge off the line the writer is bound to; (3) bounds the
  branch↔base diff to **exactly** the one proposed record file, so no extra file
  (another record, or content outside the record layout) can ride onto the
  authoritative line **unguarded**; (4) **re-reads, re-validates (S2 schema) and
  re-runs the mandatory PII guard** against that record; and (5) asserts its
  on-disk path is the record's canonical layout path. Only then is it merged — so
  a PII-carrying, invalid, mislocated, smuggled, or misdirected record can never be
  ratified. The ratifying merge's commit message is derived from the **guarded**
  `record.id` (re-read and re-guarded above), never the caller-controlled
  `proposalId`, so a mutated handle can't inject unguarded content (PII, newlines)
  into the commit trail. Every commit/merge subject additionally passes `record.id`
  through `commitLine` (collapses CR/LF and whitespace to a single line), so even a
  guarded id can't split the subject to inject extra message lines or a forged
  trailer — `id` is schema-validated only as a non-empty string.
  It accepts the hypothesis onto the authoritative line; it never upgrades an
  `agent-retro` record to `authoritative` (the S2 schema forbids that), so an
  unratified — or even a ratified — prior can never present as a
  measured/authoritative fact.
- `isRatified(proposal)` — `true` iff the proposal's commit is an ancestor of the
  writer's **own resolved base**. Like `ratify`, it rejects a proposal whose
  `baseBranch` was mutated off that resolved base rather than trusting the
  plain-object handle, so a retargeted handle can't report an unmerged hypothesis
  as ratified.

Concurrency: **within a single `ContextWriter`** operations are serialised on the
shared working tree (one working tree) and each write still lands on its own
uniquely-named branch, so interleaved calls never clobber each other and disjoint
records merge cleanly. This is a **per-instance** guarantee: two `ContextWriter`
instances (or separate processes) over the **same** working copy are uncoordinated
and can corrupt each other — use a separate clone (or external locking) per
concurrent writer. Each mutating op also restores the working tree to the resolved
base in a `finally` (a force-checkout plus a layout-scoped clean), so a
mid-operation failure never strands the shared tree on a transient write/proposal
branch — with a half-written record — for the next serialised call to inherit.

## PII enforcement BY CONSTRUCTION

`PreCommitGuardRegistry` is **always** seeded with the mandatory S6
`preCommitPiiGuard` as its first, non-removable member and has no removal API.
The writer runs `assertAll` before **every** commit, so a PII-carrying write is
rejected before it is committed — on the default code path, with no caller
opt-in. `ratify` (a merge onto the authoritative line) is a write path too, so it
re-runs `assertAll` against the proposal's content before merging. Additional
guards can only be added (stricter), never subtracted.

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
