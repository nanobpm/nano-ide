# ADR 0066 — One form renderer across surfaces (pages dataGrid renders engine-declared forms)

Status: Accepted
Date: 2026-08-22
Relates to: ADR 0026 (engine-declared forms — the `taskInbox` surface first resolved a
deployed `.form`'s form-js schema and completed its user task; this generalizes that path),
ADR 0055 (the Urban runtime absorbs app surfaces — where both the `taskInbox` and the
`pages` `dataGrid` live), and ADR 0053 (derivation is a shared library — the "single
canonical implementation, no drift surface" principle this applies to a *client* renderer).
Repo: nanobpm/nano-ide (`packages/urban`).

Implementation issue: nanobpm/nano-ide#457.

## Context

A user task can carry an **engine-declared form**: the process model references a deployed
`.form` (by `formKey`/`formId`), and the engine returns its form-js schema. ADR 0026 gave the
`taskInbox` surface the whole path — `EngineClient.getForm(...)` to resolve the schema, a
client-side form-js renderer to turn it into inputs, and `EngineClient.completeUserTask(...)`
to submit the collected variables.

The `pages` surface's `dataGrid` could already render a **page-authored** `detail.form`
(`buildDetailForm` in `runtime.browser.js`) — a form the *page author* writes into the
page JSON. But a grid whose rows are heterogeneous user tasks (each task type carrying its
own deployed form) had no way to render the **authoritative** engine form in its detail
drawer. The only escape was to hand-transcribe each engine form into a page-local
`detail.form` — a classic **drift surface**: two copies of one form, guaranteed to diverge
the moment the deployed `.form` changes.

Worse, the *renderer itself* lived inline inside the `taskInbox` page's HTML `<script>`
string (`buildField`/`renderForm` in `surfaces.ts`). Reusing it from the pages runtime
naïvely would have meant a **second** copy of the form-js→inputs→variables mapping — the
exact duplication class this repo forbids (derivation over duplication).

## Decision

**One form renderer, one form gate, shared by both surfaces.**

1. **Extract the client renderer to a single authored module** —
   `packages/urban/src/runtime/browser/formjs.browser.js` — type-checked, linted and
   unit-tested as real source, emitted to a committed string artifact (`formjs.gen.ts`) by
   `scripts/gen-runtime.mjs`, exactly like `runtime.browser.js`/`runtime.gen.ts`. It exposes
   `buildField`/`renderForm` and registers `globalThis.NanoFormJs`.

   The two client bundles are structurally different — the `taskInbox` page is a
   self-contained inline `<script>`, the pages runtime is an ES module — so they cannot
   `import` a shared module the same way. Instead **both embed the generated `FORMJS_JS`
   string as a classic `<script>`** (the taskInbox page inline, the pages shell before its
   module loads); each then reaches the **one** implementation via `globalThis.NanoFormJs`.
   The pages runtime's `buildEngineForm` reads that global lazily, so nothing is inlined at
   generation time.

2. **Extract the server gate to a single module** —
   `packages/urban/src/runtime/core/modules/forms.ts` — `resolveFormResponse(engine,
   formKey, formId)` (presence-gated by `presentFormIdentifier`, the host.ts SSOT; 204 when
   `getForm` returns null) and `completeUserTaskResponse(engine, bodyText)`. Both the
   `taskInbox` routes and the new pages routes delegate to these, so the resolve/complete
   semantics can never fork.

3. **Add the pages engine-form seams** — `GET /app/actions/form?formKey=…` and
   `POST /app/actions/complete` (pages-owned `/app/actions/` namespace, deliberately **not**
   the OpenAPI-owned `/app/api` prefix) — and a `dataGrid` `detail.engineForm` config that
   names the row's `formKey`/`userTaskKey` fields. `buildEngineForm` resolves the row's
   `formKey`, renders the deployed schema with `NanoFormJs`, and completes the row's task. A
   row with no `formKey` (or a `formKey` that resolves to no form, 204) degrades to a bare
   "Complete" button — parity with the `taskInbox` no-form fallback.

## Consequences

- **No form-duplication drift.** A pages `dataGrid` renders the *same* deployed form the
  `taskInbox` does, from the *same* renderer and the *same* resolve/complete gate. Editing a
  deployed `.form` updates every surface at once; there is no page-local transcription to
  keep in sync.
- **A second generated artifact to guard.** `formjs.gen.ts` joins `runtime.gen.ts` under the
  CI "Runtime artifact is up to date" drift gate (`gen-runtime.mjs --check` + `git diff
  --exit-code`), so a stale renderer can never ship.
- **Security is preserved at the single seam.** The shared renderer places every
  engine-returned value via `textContent`/`setAttribute` (never `innerHTML`) and assembles
  submitted variables into a **null-prototype** bag, so an engine-supplied component key of
  `__proto__`/`constructor` can neither inject markup nor pollute a prototype — enforced once,
  for both surfaces.
