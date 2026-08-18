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
