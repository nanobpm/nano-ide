# S6 — PII enforcement seam (`@nanobpm/urban/context/pii`)

This subdirectory is the **enforcement seam** of the Urban context layer
(epic #303). It publishes:

- **`classifyPii(candidate)`** — a *pure*, deterministic classifier that inspects
  candidate memory-record content (a `MemoryRecord`, a bare string, or any plain
  object) and returns a located decision: `{ clean: true }` or
  `{ clean: false, findings }` where each finding names the `kind`, field `path`,
  offset and reason.
- **`preCommitPiiGuard` / `createPiiGuard()`** — a **default-DENY** pre-commit
  guard built on the classifier. `guard.assert(candidate)` returns `void` for
  clean content and **throws `PiiGuardError`** (carrying the findings) when PII is
  detected. `guard.inspect(candidate)` is the non-throwing variant.

## Wiring contract (for S3)

S3 (git substrate / governance) **MUST** register `preCommitPiiGuard` as the
**NON-OPTIONAL, default** pre-commit step on **every** write path, so a write
carrying PII is rejected *before* it is committed — PII is blocked **by
construction**, not merely when a caller opts in. If S3 exposes a
guard-registry/injection seam, this guard MUST be pre-registered as the default
so no caller can silently bypass it.

## Scope boundaries

- This slice owns the classifier + guard **only**. It has **no git/network
  access** and does **not** import `../git` (S3 imports *us* — the dependency
  points one way to keep the graph acyclic).
- The MVP substrate is **no-PII by construction**. This slice builds neither a
  mutable/erasure backend nor the CI workflow.
- The later **S6 CI** slice layers a build-time classification workflow +
  erasure/immutability docs **on top** of this in-process guard, reusing this
  classifier. It must not weaken or duplicate the guard.
