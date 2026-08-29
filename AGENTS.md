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

## Generated Derived Artifacts Are Shared-State Merge Hazards

Several surfaces are **committed derived artifacts, gated on drift**: a file is
regenerated wholesale from a source (a spec, a fixture, code) and a fail-on-drift
CI check keeps the committed copy honest. Current gates:

| Derived artifact | Regenerate | Drift gate |
| --- | --- | --- |
| `packages/urban/src/openapi/mcp-tools.snapshot.json` — the MCP tool projection (ADR 0067) | `npm run gen:mcp-tools -w packages/urban` | `npm run check:mcp -w packages/urban` (+ `check:mcp-conformance` over real consumer specs) |
| `packages/urban/src/runtime/core/modules/runtime.gen.ts` | `npm run gen:runtime -w packages/urban` | `npm run check:runtime -w packages/urban` |
| `db/migrations/NNN_*.sql` prefixes (see below) | — | `npm run check:migrations` |

Two rules follow, and they bite agents and humans alike:

- **Regenerate and review in the same PR.** When you touch the *source* of a
  derived artifact — e.g. the MCP projection walker in `openapi/spec.ts`, or the
  `mcp-parity.fixture.yaml` it captures — regenerate the artifact and run its
  drift gate *before pushing*. A fixture/code edit without a matching regenerated
  snapshot is a guaranteed red CI. The MCP guard additionally asserts each tool
  `body` is self-contained (no `$ref`, explicit `type`).
- **Don't parallelize two tasks that both rewrite one wholesale artifact.** The
  snapshot — like a migration prefix — is captured *wholesale*, so two branches
  that each append to the fixture and regenerate are **green in isolation but red
  on `main`**: the second merge's `check:mcp` regenerates against the *combined*
  fixture and diffs, and if the first task's projection change altered shared
  entries, the second's pinned snapshot is already stale before it lands. Merge
  such slices into one task, or serialize them (`dependsOn`) so one regenerates on
  top of the other's merged output. A "rebase if a sibling lands first"
  landing-order hack is **not** an acceptable remedy — decompose so the collision
  cannot occur.

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
