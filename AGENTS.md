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

## Adding a Workspace Package

New packages under `packages/*` follow one setup, mirrored from the existing
agentic packages (e.g. `packages/agentic-presence`). Copy it rather than
inventing a variant:

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
