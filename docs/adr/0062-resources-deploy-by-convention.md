# ADR 0062 — Resources deploy by convention; deploy-time templating is removed

Status: Proposed
Date: 2026-08-16
Relates to: ADR 0027 (nano-bpm; `nano.app.json` manifest spec — the `models` key),
ADR 0052/0053/0054 (dry out the Nano host over `@nanobpm/urban`; derivation is a shared
library), ADR 0059 (one HTTP surface).
Repo: nanobpm/nano-ide (`packages/urban`), the schema source **Magikcraft/nano-bpm**
(`spec-app/nano-app.schema.json`, published as `@nanobpm/nano-app-schema`), and consumer
apps such as nanobpm/nano-workforce.

Implementation issues (ordered rollout): Magikcraft/nano-bpm#782 (schema) →
nanobpm/nano-ide#243 (urban) → nanobpm/nano-workforce#239 (consumer migration, blocked
on the urban release).

## Context

An Urban app declares what it deploys through `nano.app.json` → `models`, a map of glob
lists (`processes`, `decisions`, `forms`, `templates`). `deployModels()`
(`packages/urban/src/runtime/core/modules/deploy.ts`) flattens `processes` + `decisions`
+ `forms` into one list and deploys them in a single `deployResources()` call,
**classifying each resource purely by file extension** (`.bpmn`/`.dmn` → `text/xml`,
`.form` → `application/json`, everything else → `application/octet-stream`, i.e. a
GenericScript). At deploy time the *subkey is irrelevant* — only the extension matters.

Two problems have emerged:

1. **Overloaded `processes`.** Agent base prompts are now delivered as deployed
   GenericScript resources referenced from BPMN via
   `zeebe:linkedResource resourceId="rebase.md" bindingType="latest" linkName="prompt"`
   (the harness fetches them at job activation). To get the prompts *deployed* as generic
   resources, apps list `prompts/*.md` under `models.processes` — the only glob that both
   deploys and content-types `.md` as GenericScript. This is misleading (they are not
   processes) and load-bearing in a surprising way: `models.processes` is *also* the input
   to codegen (`toolkit/gen.ts` `readModels()` reads each matched file as `xml` and runs
   `scanModelShapes()` on it), so every prompt `.md` is swept into the BPMN model scan. It
   is benign today only because `scanModelShapes` is regex-based and finds no `nano:shape`
   in markdown — a prompt containing a literal `<nano:shape …>`, or any future strict parse,
   would break.

2. **Deploy-time templating is a dead-and-dangerous path.** `models.templates` +
   `applyTemplates()` substitute `{{name}}` placeholders into resource bodies at deploy,
   running an XML/JSON escaper over the content (with an octet-stream carve-out precisely
   because that escaper can corrupt non-XML/JSON). Its motivating use — *modular prompts* —
   is fully superseded by `linkedResource` (hot-swap a prompt by redeploying one `.md`, no
   process redeploy, `latest` binding). The only current Urban app (nano-workforce) uses no
   templates and no `{{token}}` in its BPMN.

## Decision

### 1. `resources/` deploys by convention

The `resources/` directory is the app's deploy root. Urban walks it and deploys every
resource, content-typed by extension (the existing map). No glob list is required for the
common case. Conventions, chosen to keep "deploy everything in `resources/`" safe:

- **If it is in `resources/`, it is a deployable resource.** Documentation and other
  non-deployables live *outside* `resources/` (e.g. `docs/`). (Consequence: nano-workforce's
  `resources/agent-guide.md`, currently undeployed, moves to `docs/`.)
- **One level deep by convention** (`resources/<type>/<file>`), so the deploy resource name
  stays the file basename with no cross-directory basename collisions (`deployModels` keys
  resources by basename today).
- **Model scanning defaults to `resources/**/*.bpmn` (+ `.dmn`)** — codegen no longer needs
  a configured `models.processes`.

### 2. `models` becomes an optional override, not the default

`models.*` remains a supported escape hatch for advanced/non-standard layouts (monorepos,
generated-model dirs). When absent, the convention above applies. The schema
(`spec-app/nano-app.schema.json`, `@nanobpm/nano-app-schema`) makes `models` optional and
documents the convention.

### 3. Deploy-time templating (`models.templates` + `applyTemplates`) is removed

`models.templates` and the `applyTemplates`/`resolveTemplates` code path are deleted. The
**blessed — and only — mechanism for agent-prompt modularity** is:

- **One `.md` per agent task**, deployed as a GenericScript resource from
  `resources/prompts/*.md` (the convention), referenced by
  `zeebe:linkedResource … bindingType="latest" resourceType="GenericScript" linkName="prompt"`.
- **Per-instance variation** via the runtime `appendPrompt` FEEL input (how nano-workforce
  injects e.g. `abandonBrief` / failing-check lists today) — *not* deploy-time composition.
- Shared static blocks across prompts, if ever needed, are handled by attaching multiple
  linked resources to a task, not by re-introducing `{{include}}`.

**Caveat preserved for the future.** Deploy-time templating uniquely did one other thing:
*value injection* into models (baking a URL / flag / tenant into BPMN or a form at deploy).
That is **not** re-created here; the correct primitive for it is runtime — process variables
/ FEEL / env — never deploy-time string substitution over XML/JSON. Recorded so the same
footgun is not rebuilt under a new name.

## Consequences

- **Cross-repo, ordered rollout.** Schema (`@nanobpm/nano-app-schema`, Magikcraft/nano-bpm)
  → urban (nano-ide, deploy/gen + removal + scaffolds) → consumer apps (nano-workforce
  migration). The nwf consumer change lands only after the urban release that carries the
  convention.
- **Scaffolds teach the blessed path.** The app-template scaffolds (`app-deno-gui`,
  `app-workflow`, …) and the urban README document the `resources/` convention and the
  `linkedResource` + `appendPrompt` prompt path; templating examples are removed. This is
  the "agent instructions for Nano itself" surface.
- **Clean break, no back-compat alias.** nano-workforce is the only Urban app; we take the
  clean break rather than carry a deprecated `models.templates`.
- **Host is unaffected on the hot path.** The Nano host delegates gen/deploy for
  Urban-shaped apps to the `urban` toolkit (ADR 0052-54, `projects.rs` `gen_via_urban`), so
  the convention lives in one place; any residual host references to `models.templates` are
  a follow-up cleanup, not a blocker.
