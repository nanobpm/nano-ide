# `@nanobpm/urban/context` — the Urban context layer (epic #303)

This directory is the **producer** side of the Urban context layer: a git-backed,
governed memory substrate for Nano apps. It is published from `@nanobpm/urban`
under the `./context/*` subpaths and is the contract that the consumer repo
(`nanobpm/nano-workforce#291`) builds against.

The layer is delivered as a set of parallel **slices**, each landed by its own
agent. This README documents the **seam** that lets those slices land in
parallel without colliding.

## What `@nanobpm/urban/context` publishes

| Subpath                          | Slice           | Surface |
| -------------------------------- | --------------- | ------- |
| `@nanobpm/urban/context`         | scaffold barrel | Aggregate of every slice below |
| `@nanobpm/urban/context/binding` | S1              | Bindable `context` resource + binding descriptor |
| `@nanobpm/urban/context/schema`  | S2              | Memory-record schema + provenance/mode model |
| `@nanobpm/urban/context/pii`     | S6              | PII classifier + mandatory pre-commit guard |
| `@nanobpm/urban/context/git`     | S3              | Git substrate + PR-governance + path partitioning |
| `@nanobpm/urban/context/retrieval` | S4            | Retrieval (structured / frontmatter / text) |
| `@nanobpm/urban/context/conformance` | S2          | Conformance corpus + reusable runner (imported by S7 and the consumer) |
| `@nanobpm/urban/context/source`  | —               | Raw TypeScript entry (mirrors the package's `./source`) |

The adversarial slice (S7) lives in `./adversarial/` and is **test-only** — it is
not part of the published surface and is intentionally excluded from the top
barrel.

## The seam — rules every slice MUST follow

1. **Each slice owns exactly one subdirectory.** A slice replaces only files
   inside its own directory (its placeholder `index.ts` becomes its real
   barrel). It never edits a sibling's directory.

2. **Only the scaffold task edits the shared surface.** `packages/urban/package.json`
   (the `exports` map **and** the `scripts` block) and this directory's top
   barrel `index.ts` are **scaffold-owned**. No sibling slice may edit either —
   everything a slice needs (its subpath export, and the two shared scripts) is
   **pre-declared** here already.

3. **Fill the pre-declared subpaths and scripts.** The `exports` map already
   lists every `./context/*` subpath (including `./context/conformance`), and the
   `scripts` block already declares:
   - `test:conformance` → runs `src/context/conformance/**/*.conformance.ts`.
     **Slice S2 replaces** the placeholder `conformance/scaffold.conformance.ts`
     with the real corpus/tests. S2 must not touch `package.json`.
   - `check:pii` → runs `scripts/check-pii.ts`. **Slice s6-pii-ci replaces** the
     no-op `scripts/check-pii.ts` placeholder with real layout-aware
     classification. It must not touch `package.json`.

## Build / test wiring

- Context code lives under `src/`, which `tsconfig.build.json` already globs, so
  the new files build with no compiler-config change.
- Context code is **server-side only** and is deliberately **not** added to
  `tsconfig.browser.json`.
- `npm run test --workspace @nanobpm/urban` runs `src/**/*.test.ts`.
- `npm run test:conformance --workspace @nanobpm/urban` runs the conformance
  corpus.
- `npm run check:pii --workspace @nanobpm/urban` runs the PII gate.

## PII: no-PII by construction, and the immutability-vs-erasure boundary

The MVP substrate is **no-PII by construction**. Nothing here stores personal
data, and two independent nets keep it that way:

1. **In-process, at write time (S6-core + S3).** `@nanobpm/urban/context/pii`
   ships a pure classifier (`classifyPii`) and a mandatory, default-DENY
   pre-commit guard (`preCommitPiiGuard`). S3's `ContextWriter` registers that
   guard as a **non-optional** pre-commit step on **every** write path
   (`PreCommitGuardRegistry`, seeded non-removably), so a record carrying PII is
   rejected **before any commit** — a caller cannot opt out.

2. **Build-time, in CI (this slice, s6-pii-ci).** `npm run check:pii` walks the
   S3 record layout (`records/<scope>/<scopeRef-bucket>/<id>.json`, where
   `<scopeRef-bucket>` is the sanitised `scopeRef` or the shared `_` bucket when a
   record carries no `scopeRef` — see `recordRelativePath`) and re-classifies
   every record with the **same** `classifyPii`, failing the build on any violation.
   The `.github/workflows/urban-context-pii.yml` workflow runs it (plus
   build/typecheck/test) as a second line of defence in case content reaches a
   git-backed context by some path other than the writer.

### Why the guard, not erasure

The substrate is an **append-only git history**. "Deleting" a record is just
another commit that removes the file from the *tip*; every prior value remains
in the reachable history (and in every clone, fork, and reflog). On this
substrate there is **no true erasure** — you cannot unpublish a fact that was
ever committed short of a history rewrite that every consumer must also adopt.
Because real erasure is not achievable append-only, the only sound MVP policy is
to **never admit PII in the first place** — hence the by-construction guard + CI
net above rather than an after-the-fact delete.

### The seam left for a future PII/mutable backend

Real erasure (GDPR-style "right to be forgotten", tombstoning, crypto-shredding)
requires a **mutable** substrate that can genuinely destroy a value, not merely
append over it. The write path is already abstracted over the substrate
(`WriteSubstrate` / `GitWriteSubstrate` in `@nanobpm/urban/context/git`) and the
binding layer does not assume "public git only", so a future opt-in
PII/mutable backend can slot in behind that seam and offer erasure semantics
**without** touching the record schema, the layout, or this guard. That backend
is intentionally **not built** in the MVP — only its seam is documented here.
