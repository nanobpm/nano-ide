# ADR 0057 — Distributing a complete Urban app: app-packs (copy-on-install) and import-by-reference (pointer) are one source axis

Status: **Proposed.**
Date: 2026-08-04
Extends: ADR 0052 (nano-bpm; decoupled Urban runtime / manifest interpreter), ADR 0053
(derivation is a shared library), ADR 0055 (the runtime absorbs the app surfaces),
ADR 0041 (nano-bpm; import an Urban app by reference).
Relates to: ADR 0007 (nano-bpm; RAD extension system — the pack/marketplace surface),
ADR 0027 (nano-bpm; `nano.app.json` manifest spec), ADR 0056 (worker stubs are
scaffolded, not derived); nano-ide **#520** (the first-class *New Urban App* pack,
delivered) and its follow-up **#539** (this issue); nano-bpm epic **#514** (dry out the
Nano host over `@nanobpm/urban`).
Repo: nanobpm/nano-ide (packs, `packages/urban`) + the nano-bpm host repo **nanobpmn**
(all bare `projects.rs` / `extensions.rs` / `node_loader.mjs` file:line citations below
refer to `server/src/console/{extensions,projects}.rs` in that host repo, not to nano-ide).

## Context

#520 delivered the *creation* affordance — "New Urban App" scaffolds a **new** app by
delegating to `create-urban-app`. It deliberately deferred one question: how do you
distribute a **complete, existing** Urban app (a whole `nano.app.json` + its authored
content) as an installable, shareable unit?

Two framings were on the table:

- **Fat app-pack** — bundle the entire app payload in the pack tarball. Self-contained
  and offline-installable, but seemingly large and duplicative.
- **Lean seed (by-reference)** — ship a pointer that imports app content by reference
  (ADR 0041). Small and DRY, but needs a resolvable source at install time.

**The tension dissolves once you enumerate what a complete Urban app actually _is._**
Per ADR 0055, an Urban app reduces to *a declarative `nano.app.json` + authored
artifacts + handler files*, run by `runFromEnv`. Concretely the app's own source is:

| Category | Examples | Ships in the app? |
|---|---|---|
| **Manifest** | `nano.app.json` | ✅ authored |
| **Authored artifacts** | `processes/*.bpmn` (+DI), `pages/*.page.json`, `forms/*.form`, `db/migrations/*.sql`, `actions/*.ts` | ✅ authored |
| **Human-owned handlers** | `workers/<slug>/worker.ts` (ADR 0056: scaffolded write-once, then human-owned) | ✅ authored |
| **Runtime engines** | `@nanobpm/urban` (data / pages / llm / triggers / workers) | ❌ **npm dependency** — materialised by `npm install`, never copied |
| **Derived typed wrappers** | `nano-generated/*` (worker-io, domain-rows, message-io) | ❌ **derived** — gitignored, reconstituted by `urban gen` (ADR 0053/0055) |
| **Third-party worker deps** | npm packages that a `workers/<slug>/worker.ts` handler imports (`octokit`, `zod`, native SDKs…) | ⚠️ **declared, not vendored** — named in the app's `package.json` / `deno.json` import map; materialised by `npm install` at the project root (§6) |

So the "bundle" is **only the authored artifacts** — including the **dependency
manifest** (`package.json`/`deno.json`), but never `node_modules`. It is already small:
the heavy parts are an npm **dependency graph** (installed, §6) or **derived** (`urban
gen`) — neither belongs in the app's source tree. *"Fat"* and *"lean"* collapse into the
same small payload.

**The host already has both sourcing mechanisms, over one contract and one run path.**
An Urban app is a console **project** (ADR 0009/0041), and a project is materialised two
ways today:

- **Copy-on-install** — a `kind: example` pack bundles a complete app under `appDir`;
  the host **copies** it into a new project (`extensions.rs:992` `find_example_template`
  → "returns (manifest, dir) so the scaffolder can copy it"; `projects.rs:406` "a
  `kind: example` pack — the entire pack **is** the template").
- **Pointer/live** — ADR 0041 import-by-reference registers an **external directory** as
  a live project source (no copy), source-tagged (`workspace` | `path`).

Both validate through the **single** `is_nano_app_dir` gate (`projects.rs:740`) and run
through the **single** `supervisor().run()` path. ADR 0041 already foresaw this:
*"Shipping an app to another machine already goes through the npm extensions surface … an
installed pack dir is just a future `source` kind resolving the same way. This ADR adds
**no** bundle format."*

## Decision (proposed)

### 1. Distribute a complete Urban app as an npm **app-pack** (copy-on-install) — no new bundle format

Generalise today's `kind: example` into a first-class **complete-app** pack: `appDir`
holds a complete `nano.app.json` Urban app. It rides the existing marketplace surface —
discoverable by the `nano-ide-ext` npm keyword, `@nanobpm/`-scoped for the *official*
flag (ADR 0007 / nano-ide #536), versioned by npm, signed with provenance by the release
workflow. Installing it:

1. **copies** `appDir` into a new project (existing scaffolder), then
2. runs the **install-before-create** hook `ensure_urban_toolkit` (#532) + `npm install`
   to materialise the `@nanobpm/urban` runtime, then
3. runs `urban gen` to reconstitute `nano-generated/*`.

The result is **byte-identical** to a locally-scaffolded app, because the same authored
artifacts feed the same pure derivers (ADR 0053).

### 2. The bundle carries **authored artifacts only** — never derived or dependency outputs

`nano-generated/*` and `node_modules/` **MUST NOT** ship in an app-pack: the first is
derived (`urban gen`), the second is npm-managed. Enforce with the pack `files` allowlist
**and** a **new** `scripts/validate-manifests.mjs` rule (today the validator only checks
`nano-ide.ext.json` structure + referenced-file existence — see Status) that fails a
complete-app pack which bundles `nano-generated/` or `node_modules/`. This is the no-drift rule made physical: the
**authored artifacts are the single source of truth**, and everything else is
reconstituted at install. The **dependency manifest** (`package.json` + a pinned
`package-lock.json`) *does* travel — it is version-controlled and checked in (the
`deno.json` import map it derives from is authored), not a build output like
`node_modules` — and drives the third-party install described in §6.

### 3. Import-by-reference (ADR 0041) is the complementary **live/private** path — explicitly *not* a distribution format

A **path source** (and a future **git source**) points a project at a live checkout, read
with no copy and a tight edit→reload loop. It has **no discovery, no versioning, no
registry** — it is a local operator action. It is the right tool for a **private** app, a
**monorepo checkout**, or the **dev loop**; it is the wrong tool for public distribution.
The two are not competitors; they are two points on one axis (below).

### 4. Unify both behind one **project-source axis**

A project resolves from a `source`:

| `source` | Materialisation | Distributable | Prior art |
|---|---|---|---|
| `workspace` | a subdir of `projects_root()` (default) | — | today |
| `pack` | **copied** from an installed app-pack `appDir` | ✅ npm marketplace | this ADR (generalises `kind: example`) |
| `path` | **pointer** to an external dir, read live | ✗ (local) | ADR 0041 |
| `git` | clone of a repo (future increment) | ✓ (repo) | ADR 0041 open q |

Every source is validated by the single `is_nano_app_dir` gate and executed by the single
`supervisor().run()` path (ADR 0041 §2–§4). This ADR adds only the **`pack`** copy-on-install
tag; it introduces **no** second validator, **no** second deploy pipeline, **no** second run path,
and **no** bundle format beyond the npm tarball.

### 5. Manifest / host-resolver implications

- **Reuse `appDir`** (already validated, already copied). Optionally introduce
  `kind: "app"` (+`appDir`) as the explicit "complete Urban app" form and keep
  `kind: "example"` as a back-compat alias — see open question 1.
- The bundled app's `nano.app.json`/`package.json` **declares its own `@nanobpm/urban`
  dependency** (as the #520 toolkit pack does), so install materialises the runtime.
- `requires[]` continues to name the language pack so the host sets the project runtime
  (the validator already guards the "toolchain but no `requires[]` → silent Deno" bug).
- `list_projects` source-tagging (ADR 0041) gains the `pack` tag so the console shows
  where a project came from.

### 6. Third-party worker dependencies travel as a **manifest**, not as `node_modules`

A complex worker (`workers/<slug>/worker.ts`) may import arbitrary third-party npm
packages (`octokit`, `zod`, a vendor SDK, …). This is fully supported, and it does **not**
change the "authored artifacts only" rule — because the host already treats dependencies
as a *declared manifest*, reconstituted on install:

- **Deps are declared, and derived from one source of truth.** A project carries a
  Node-first `package.json` "to declare third-party npm dependencies"
  (`projects.rs:1257`); those entries are **derived** from the app's `deno.json` import
  map (`npm:` specifiers) by `npm_deps_from_deno_json` — the single source of truth that
  epic #437 established, so `package.json` never hand-mirrors the import map.
- **Worker deps resolve up-tree to the project root.** Workers have no own manifest —
  "every `npm:` import, *including in a worker*, is declared in the ROOT `package.json`;
  a worker run's `npm install` and `node_modules` resolution walk up-tree to the project
  root" (`projects.rs:9779`). One project-root install serves every worker.
- **One install, both runtimes.** The same `npm install` the run/dev loop already performs
  (the #437 Node-fallback safety net) reconstitutes `node_modules` for Node, while Deno
  resolves the identical `npm:` specifiers directly (`node_loader.mjs`). The `package.json`
  travels in the bundle; `node_modules` never does — exactly §2.

Three properties an app-pack **with third-party worker deps** must therefore honour:

1. **Ship a `package-lock.json`** for a deterministic, reproducible install (`npm ci`).
   This is the deliberate difference from the #520 *toolkit* pack, which shipped no
   lockfile and used a caret-range `npm install`; a **complete app** with a real
   dependency graph pins it.
2. **Trust gates native / lifecycle-script deps.** The host installs `--ignore-scripts`
   **unless the pack is trusted** (`npm_install_argv`, `extensions.rs:1219`). Pure-JS
   worker deps install fine untrusted; deps with native addons or `postinstall` builds
   require the app to be **trusted** first (the supply-chain guardrail is intentional).
3. **First install needs the registry (or a warm cache).** "Offline after install" holds
   only once the app's dependency graph — not just `@nanobpm/urban` — has been fetched.

Net: a "complex app with npm-heavy workers" is still distributed as authored artifacts +
a pinned dependency manifest; the dependency graph is **installed**, never **vendored**,
preserving the no-drift rule while fully supporting arbitrary worker dependencies.

## Consequences

- **Almost no new surface.** Distribution reuses: the example/`appDir` copy path, the
  install-before-create hook + `urban gen` reconstitution, the ADR 0041 source-tagging,
  and the marketplace keyword discovery. The delta is generalising a pack kind, adding a
  `pack` source tag, and one validator guard.
- **"Fat vs lean" is a false dichotomy.** Derivation (`urban gen`) plus npm dependencies
  make every app-pack lean *by construction*. The only real choice is
  **sourced-by-copy (`pack`, distributable)** vs **sourced-by-pointer (`path`/`git`,
  live/private)** — one axis, one contract, one run path.
- **No drift.** One manifest validator (spec-app TS / `validate-manifests`), one run path
  (supervisor), one derivation library (`urban gen`). No registry sidecar.
- **Good distribution properties.** Offline after install, versioned, marketplace-discoverable,
  official-flagged on the `@nanobpm/` scope, provenance-signed by `release.yml`.
- **Arbitrary worker dependencies are supported** (§6) without weakening §2: third-party
  npm packages a worker imports travel as a *pinned dependency manifest* and are installed
  (up-tree at the project root, serving every worker on both runtimes), never vendored.
- **Risk.** First install fetches `@nanobpm/urban` **and the app's own dependency graph**
  from npm (network) and runs `urban gen`; this is the same guarded install already shipped
  in #532, and reconstitution determinism is guaranteed by ADR 0053 (pure derivers,
  `--check`) plus a shipped lockfile (§6). Fully-offline installs require the toolkit **and**
  the app deps pre-cached; native/`postinstall` worker deps require the app to be **trusted**
  (the `--ignore-scripts`-unless-trusted guardrail).

## Open questions

1. **Pack-kind naming** — keep overloading `kind: example` for complete apps, or add
   `kind: "app"` (+`appDir`) as the first-class form with `example` as an alias?
   *(Lean: add `kind: "app"`; alias `example` for back-compat and demos.)*
2. **When to reconstitute** — run `urban gen` (and `npm install`) during pack **install**,
   or lazily on **first Run** (reusing the existing boot/derive gate)?
   *(Lean: on first Run — keeps install fast and offline-friendly.)*
3. **Git source increment** — clone-by-reference for private apps not on npm, reusing the
   c8ctl `provisionRepo` primitive (ADR 0041 open q). *(Out of scope; future.)*
4. **Upgrade of an installed app-pack** — re-installing a newer version onto an existing
   project: overwrite authored artifacts (clobbers user edits) vs three-way merge vs
   refuse? *(Lean: an app-pack seeds a **new** project; upgrading a **live** project is a
   separate concern, better served by a `git` source than an npm re-copy.)*
5. **Native / lifecycle-script worker deps & trust** (§6) — an app whose workers need
   `postinstall`-building or native-addon packages installs those scripts only once the app
   is **trusted**. Do we (a) require such packs to declare a `nativeDeps`/`trusted`
   intent so the console prompts for trust up-front, or (b) let the first Run fail-closed
   with a clear "this app needs to be trusted to install native dependencies" message?
   *(Lean: (b) first — reuse the existing trust prompt; add (a) as an authoring hint later.)*

## Status

**Proposed — pending ratification.** Implementation is follow-up work: the host `pack`
source kind (generalising the `kind: example` copy path + `list_projects` tag), the
`validate-manifests` guard against bundled `nano-generated/`/`node_modules/`, the app
dependency install (§6: pinned lockfile + trust-gated native deps), and the optional
`kind: "app"` alias.
