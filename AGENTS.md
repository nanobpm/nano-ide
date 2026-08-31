## No Such Thing as "Flaky Tests"

Intermittently failing tests must always be root-caused and addressed as a product defect (code) or a production-line defect (test). We do not acknowledge the existence of such a thing as "flaky tests".

## Red/Green Discipline

All bug fixes must have a test that reproduces the defect before modifying code. Red/Green—always.

## Fix the Failure Mode, Don't Just Squash the Bug

Whenever we detect an issue, reason broadly about the defect class and write a test guard for the defect class. Prefer securing surfaces — including suggesting an architectural refactor to eliminate the failure mode categorically — over squashing individual bugs.

## Feature Test Coverage

When adding new features, ensure test coverage over the new surface to prevent undetected regressions.

## Derivation Over Duplication: No Drift Surfaces

Identify and eliminate drift surfaces — duplicate sources of truth. Ensure that everything that can be derived is derived from a single source of truth and has a single canonical implementation. Do not introduce duplication.

## Zero Tolerance for Warnings, Errors, and Test Failures

We do not tolerate warnings, errors, or test failures in this project.

There are no pre-existing failures or warnings, and you will not allow any to enter the codebase. Thank you.

## BPMN Models need DI

All BPMN Models need DI for rendering for humans.

## No `as T` Type Assertions

Type assertions (`as T`) bypass the type system and are banned across the authored TypeScript source. This is enforced in CI by a Biome GritQL plugin (`plugins/no-unsafe-type-assertion.grit`, wired via `biome.json`; run `npm run lint`). Use a type guard, declaration-site annotation, narrowing, or `satisfies` instead. Exceptions: `as const` and `import`/`export` renames are allowed. If a cast is genuinely unavoidable (e.g. an untyped host/runtime boundary), add a `// biome-ignore lint/plugin: <reason>` comment with a concrete justification.

## Releasing (never bump versions by hand)

Releases are **derived**, not declared. Do **not** edit a `package.json`
`version`, write a CHANGELOG, or add a `chore(release):` commit — those collide
the moment two agents touch the repo at once.

- **Write Conventional Commit PR titles.** main is squash-merged, so the PR title
  is the commit subject release-please reads: `feat:` → minor, `fix:`/`perf:` →
  patch, `!`/`BREAKING CHANGE` → major; other types (`chore`, `docs`, `refactor`,
  …) land but don't bump. The title is CI-gated (`.github/workflows/pr-title-lint.yml`).
  Scope by package when it helps (`fix(urban): …`).
- **release-please owns versions.** `.github/workflows/release-please.yml` keeps a
  single batched **release PR** open that bumps every affected package (and its
  intra-repo dependents) + CHANGELOG + lockfile from the accumulated commits.
  Config: `release-please-config.json` + `.release-please-manifest.json` (manifest
  mode, one component per publishable `packages/*`, tag format `<name>@<version>`).
- **Merging the release PR publishes.** On merge it tags `<name>@<version>` and
  cuts the per-package GitHub Release (the `capability → version` provenance index,
  nano-workforce#263); `scripts/publish.mjs` (via `release.yml`, gated on green CI,
  npm OIDC Trusted Publisher) then publishes the bumped versions. The release PR
  auto-merges once its required checks pass — no manual step, no bypass token.
- **Depending on an unreleased change in this repo?** Don't guess the version.
  Land your change, let release-please cut the release, then pin against the
  published `<name>@<version>` (see nano-workforce#263).

## Adding a Workspace Package

**First decide whether you need a *package* at all.** A new published unit under
`packages/*` (its own name on npm, its own version and changelog, its own
publish/credentials bootstrap) is warranted only when there is a **consumer-facing**
reason: a distinct external consumer imports *it* on its own, it wants an
**independent release cadence**, or it is a **different runtime tier** (e.g. a
worker client vs. a server library vs. a browser bundle). "This is an independent
unit of work" is **not** such a reason — slicing one cohesive library into a
package per task just leaks your work breakdown into the module boundaries
(Conway's Law) and has to be un-fragmented later.

The default is instead **one library exposing each surface as a subpath export**.
`@nanobpm/agentic` is the worked example: the whole agentic protocol ships as one
package with `./protocol`, `./channel`, `./relay`, `./cockpit`, … subpaths (see
`packages/agentic/package.json` `exports`); `@nanobpm/urban` does the same with
`./runtime`/`./toolkit`/`./worker`. To add a surface, add a `src/<family>/`
subdirectory and a matching `exports` entry — no new package.

**When you genuinely do add a new package**, follow the one setup the existing
packages use — copy it rather than inventing a variant:

- **Dual tsconfig.** `tsconfig.json` is the typecheck config (`"noEmit": true`,
  `"module"`/`"moduleResolution": "NodeNext"`,
  `allowImportingTsExtensions` + `rewriteRelativeImportExtensions`);
  `tsconfig.build.json` extends it with `"noEmit": false` + `outDir: dist` for
  the `build` script (`tsc -p tsconfig.build.json`).
- **Import siblings with the explicit `.ts` extension** (NodeNext +
  `rewriteRelativeImportExtensions` rewrites them to `.js` on build).
- **Tests are `src/**/*.test.ts`**, run with
  `node --test --experimental-strip-types "src/**/*.test.ts"`. Build a
  runtime-invalid fixture via `JSON.parse(...)` (returns `any`), never an
  `as`-cast — the `as T` ban (see above) applies in tests too.
- **Register the workspace** by committing the `package-lock.json` delta that
  `npm install` produces.
- **Build order is derived, not hand-maintained.** `npm run build`
  (`scripts/build-workspaces.mjs`) topologically orders packages from each
  `package.json`'s intra-repo deps, so a package that depends on another
  workspace's `dist/` just works regardless of directory name order. Do **not**
  re-add a hand-ordered prebuild prefix to the root `build` script.
- **Build before you typecheck a fresh clone.** A package that imports another
  workspace (e.g. `packages/urban` → `@nanobpm/workflow`) fails `npm run typecheck`
  with `Cannot find module @nanobpm/workflow` until root `npm run build` has emitted
  the dependency's `dist/`. Working order: **build → typecheck → test → lint**.

## Database Migrations

Migrations live in `db/migrations/NNN_description.sql`, are forward-only and
additive (nullable/`DEFAULT`ed `ADD COLUMN`, new tables/indexes — never a
destructive drop/rename in the change that stops using a column), and are
applied in lexical filename order.

- **Number after the current highest prefix.** The numeric prefix decides apply
  order and is the migration's identity on the ledger. Two branches that fork
  off the same state can each grab the same "next" number and emit `N_*.sql` —
  a merge collision that is green in each PR alone. **CI enforces unique,
  well-formed prefixes** (`npm run check:migrations`,
  `scripts/lib/migration-order.mjs`); run it before opening a PR that adds a
  migration.
- **One source of truth for the DDL.** A store that also creates its schema in
  code (e.g. `PresenceStore.ensureSchema`) must mirror its migration exactly,
  guarded by a drift test — do not let the two shapes diverge.

## Decomposing a Fan-Out Epic Over a Shared Surface

When you split an epic into parallel slices, a slice that edits a **shared
append-point** is not independent even when each PR is green on its own. The
`EngineClient` runtime seam is the canonical example, and it has now collided
twice (epics #488 and #525): adding a read method touches the *same five files
at the same anchors* — the `EngineClient` interface and the
`ENGINE_CLIENT_METHODS` exhaustiveness tuple (`runtime/core/host.ts`), both
adapters (`engine/nanosdk.ts` and the testkit `WasmEngineClient`), the single
`engine-client-conformance.test.ts`, and the `mcp.ts` tool registration.

- **Same-anchor edits 3-way-conflict regardless of an "append-only" convention.**
  Two slices that each append a method/member/registration at the same anchor
  produce a git merge conflict; a blackboard note or a comment marker does **not**
  prevent it. This is the same class as the migration-prefix collision above —
  green in each PR alone, red only in the *union*.
- **The conformance harness pins the whole set, so no single PR exercises the
  merged state.** If slice A adds `{x, y}` and slice B adds `{x, z}`, A's CI runs
  `{x, y}` and B's runs `{x, z}`, but **nothing** runs the merged `{x, y, z}` that
  lands on `main`.
- **Remedy at decomposition time, not via landing order.** Coarsen homogeneous
  same-surface slices into **one** PR that owns the seam end-to-end (body:
  `Closes #a`, `Closes #b`, `Closes #c`) — as epic #525 did in #529. Only split
  them if you first land a genuine append-safe scaffold (self-registering entries
  + a harness that iterates the method set) that removes the shared anchor. Do
  **not** paper the collision over with a `dependsOn` edge added purely to
  serialise otherwise-parallel work.

See also the shared-runtime-seam fan-out checklist (the compiler-driven side of
this: every test double, both adapters, and `runtime/index.ts` re-exports must
move together) proposed in #496.
