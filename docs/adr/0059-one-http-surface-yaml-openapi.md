# ADR 0059 — One HTTP surface: YAML OpenAPI as source, generated controllers/validators, delegated semantics

Status: Proposed
Date: 2026-08-10
Extends: ADR 0058 (OpenAPI endpoint surface — contract-first controllers, ejectable
to imperative; Proposed, `Magikcraft/nano-bpm`), ADR 0053 (derivation is a shared
library), ADR 0054 (one code-first stack), ADR 0055 (the runtime absorbs app
surfaces).
Relates to: nano-ide #150 (route-driven page actions — the *page-action* half of
the route-driven story; this ADR is the *authoring* half).
Repo: Magikcraft/nano-bpm (`spec-app/`), nanobpm/nano-ide (`packages/urban`,
`packages/create-urban-app`)

## Context

An Urban app today has **two ways to declare an HTTP endpoint**, authored in **two
places, two formats**:

| | **hooks** | **operations** (ADR 0058) |
|---|---|---|
| Declared in | `nano.app.json` → `actions[]` (JSON manifest) | `openapi.json` (hand-written JSON) |
| Implemented in | `actions/<name>.ts` (imperative handler) | `operations/<operationId>.ts` (delegate) |
| Mount | root (`/hooks/*`), outside the `/app` namespace | `api.base` (`/app/api/*`) |
| Validation | hand-rolled in the handler | derived from the spec, guaranteed |
| Docs/client | none | Swagger + typed client, for free |

This split has three concrete costs, all observed in `nano-workforce`:

1. **Duplication.** `submitPr` and `startPlan` each have **two** front doors — a
   hook (`/hooks/submit`, `/hooks/plan`) *and* an operation
   (`startConvergenceLoop`, `startPlanFanout`) — calling the same
   `app/service.ts`/`app/plan.ts` function, with two independent auth checks to
   keep in sync.
2. **The operation-authoring surface is the worst combo.** You **hand-write
   verbose JSON** *and* it can still drift from the delegate's real signature. The
   parser is JSON-only by design — it literally reads *"JSON only in this slice
   (ADR 0058 open question: YAML)."*
3. **No single mental model.** "Where do I add an endpoint, and in what format?"
   has no one answer.

A tempting fix is to go **code-first** (author typed handlers with a schema lib;
*derive* the OpenAPI doc from them). We reject that here for one decisive reason:
**a validator you hand-write is a validator you can get wrong.** Code-first makes
the developer the validator author, so request-shape correctness is not guaranteed
by construction, and the emitted spec can misrepresent runtime behaviour. The
whole value of the contract-first surface (ADR 0058) is that the validator is
*derived deterministically from the schema* — correct by construction, and the
contract is the portable single source of truth (Swagger, client-gen, an LLM-
readable API description all fall out of it).

## Decision

Make the **YAML OpenAPI document the single source of truth for the entire HTTP
surface**, generate the controller/validator layer from it, and delegate to user
code only for **semantic** validation and business logic. Concretely, four moves:

### 1. YAML is the authored spec format

Resolve ADR 0058's open question: the authored artifact is `openapi.yaml`
(comments, `$ref` reuse, far less punctuation). The runtime/toolkit gains a YAML
parse path; a JSON document remains accepted (it is a subset), and the *generated*
`openapi.json` is still emitted as the machine-readable interchange artifact that
Swagger and clients consume. Authoring in JSON is deprecated but not removed.

### 2. One HTTP surface — hooks are operations

Fold `actions[]` into the spec. A "hook" is just an operation whose path is at a
webhook mount and whose `security` is a shared-secret/capability-token scheme —
both already expressible in OpenAPI (the current spec already uses
`security: [{ hookSecret: [] }]`). The delegate is resolved by
`operationId → file` exactly as operations are today. The `actions[]` array is
retired; `nano.app.json` shrinks to app-level config — the proposed
`api: { enabled: true }` (replacing today's `api: { spec, dir, base }`), plus data
sources and feature toggles — and no longer enumerates individual endpoints.

Endpoints that are genuinely webhook-shaped (capability-token relays such as
`blackboard`, `abandon`, `feature-answer`) remain — they just become operations
with the appropriate mount + security scheme. The duplicate `submit`/`plan` doors
collapse to **one** operation each, which the page (via `callRoute`, #150),
external callers, and Swagger all hit.

### 3. Two-layer validation, made explicit

The load-bearing distinction:

| | **Syntactic validation** | **Semantic validation** |
|---|---|---|
| Question | "is the request *well-formed*?" | "is the request *meaningful / allowed*?" |
| Examples | required fields, types, enums, formats | "is this a PR I may act on? does this plan already exist? is `maxRounds` within policy?" |
| Source | **generated** from the schema | **delegated** to user code |
| Guarantee | correct by construction; runs *before* the delegate; malformed → automatic 400 | the author's responsibility |
| Author writes | nothing | the checks, then `throw` a typed error |

A delegate receives an already-parsed, already-shape-validated, **typed** request
context. Its only jobs are semantic checks + business logic + a response. A thrown
typed error maps to a documented error response (the error shapes live in the
spec, so the mapping is generated too).

Two refinements make "typed request/response" honest end-to-end (urban 0.38.0):

- **Params/query are coerced, not raw wire strings.** After syntactic validation,
  the runtime forwards the value **coerced to its declared schema type** — a
  `type: integer` param reaches the delegate as a `number`, a `boolean` as a
  `boolean`, an `array` as an array — and the generated `params`/`query` types match.
  (A parameter with no schema keeps its raw wire type.) Coercion and validation read
  the one `OpenApiSchema`, so the type and the runtime value never disagree.
  **Exception — ejection:** an ejected operation (`x-urban-eject`, or whole-surface
  `api.eject`, which `urban gen` reads from the manifest) deliberately bypasses the
  generated coercion/validation and hands the delegate the raw request, so its generated
  `params`/`query` stay raw wire types (`string` / `string | string[]`) and its body is
  `unknown` — the types stay honest by *not* claiming a coercion the ejected path never
  performs. Ejected **query** params are also typed optional (the runtime enforces no
  presence check for ejected ops); ejected **path** params stay required (the route only
  matches when every path segment is present).
- **The response type unions *every* documented JSON response, not just the first
  2xx.** A delegate that returns a documented error body (e.g. a `400 { error }`)
  therefore typechecks against its operation's response type, and response-shape
  validation is **status-keyed** — a result is validated against the schema for its own
  status, else a matching status range (`2XX`), else `default`, never spuriously against
  the success schema. A documented-but-bodyless status (e.g. `204 {}`) is left
  unvalidated and **does not** fall through to `default` — it is documented, it simply
  carries no JSON body.

### 4. Generate everything mechanical; author only semantics

From the one YAML document, `urban gen` derives (machine-owned, `nano-generated/`,
overwrite-always, drift-gated by `--check`):

- **typed controllers** — the dispatcher, param/query/body parsing, the route table;
- **syntactic validators** — per operation, from the schema;
- **request/response types** — for the delegate signatures;
- **Swagger UI + a typed client** — from the same document.

And scaffolds (human-owned, write-once, per ADR 0056 semantics — never clobbered):

- **delegate stubs** — one typed handler per `operationId` under the delegate dir,
  throwing "not implemented" so an un-wired operation fails loudly.

The author writes **only** the delegate bodies (semantics + business logic). There
are **no hand-written validators and no hand-written controller boilerplate.** A
delegate remains **ejectable to a fully imperative handler** per ADR 0058 for the
rare operation that needs to bypass the generated layer.

### OpenAPI validation is an editor-agnostic toolkit gate

**YAML validation ≠ OpenAPI validation.** There are three layers, and an editor
plugin covers at most one of them:

1. **YAML syntax** — well-formedness. Any parser (`parseSpec`).
2. **OpenAPI document validity**, itself two sub-levels:
   - **(2a) meta-schema conformance** — a structurally valid OpenAPI 3.1 document
     (required fields, types). This is what an editor's `yaml.schemas` → OpenAPI
     schema gives you.
   - **(2b) coherence lint** — unique `operationId`s, resolvable local `$ref`s,
     path params declared in the path, every operation has a response, referenced
     security schemes exist. The meta-schema does **not** catch these: a dangling
     `$ref` or duplicate `operationId` is meta-schema-valid but a broken API.
3. **App-coherence / drift** — every `operationId` has a delegate; delegate
   signatures match the spec (the `--check` gate).

The **authoritative validator is a toolkit gate covering layers 1 + 2a + 2b + 3**,
not an editor extension. It is **editor-agnostic** and runs identically in three
places, so they can never disagree:

- **CI** — `urban check` / `urban gen --check`.
- **Nano Studio** (the in-browser RAD IDE) — on-save diagnostics. The OpenAPI
  toolkit (`packages/urban/src/openapi/spec.ts`) is **pure, browser-safe TS** (zero
  runtime `node:` imports), so Studio runs the *same* validator in-browser and
  surfaces the same errors — optionally also wiring the OpenAPI 3.1 schema into
  Monaco's YAML mode for inline 2a.
- **Your own IDE** — an `urban check` task/problem-matcher.

The toolkit already performs part of 2b (`operationsWithoutId`,
`operationsWithUnsafeId`, `undeclaredPathParams`, cycle-guarded `$ref` resolution,
request/response `validateValue`); this ADR completes it (full 3.1 meta-schema
conformance + the remaining coherence rules).

### Editor convenience (VS Code)

`create-urban-app` additionally ships a `.vscode/settings.json` mapping
`yaml.schemas` → the published OpenAPI 3.1 JSON Schema for `openapi.yaml`, so the
Red Hat YAML LSP gives inline 2a validation + autocomplete for VS Code users. This
is a **convenience, not the source of truth** — it covers only 2a and only in VS
Code; the toolkit gate above is what CI, Nano Studio, and `--check` enforce.

## Consequences

- **The validator guarantee is preserved.** Request-shape validation stays derived
  from the schema — the property that made us reject code-first. Semantic rules are
  the only thing a human writes, and they live behind a typed seam.
- **One place, one format, one mental model** for every HTTP endpoint. The
  `actions[]`/`operations` duality and the duplicate `submit`/`plan` doors are
  gone. `nano.app.json` stops enumerating endpoints.
- **Drift becomes structurally hard.** Types + the `--check` gate ensure every
  `operationId` has a delegate and every delegate matches the spec; the spec and
  the runtime cannot disagree about request shape.
- **OpenAPI stays a first-class output**, not a chore: Swagger, a typed client, and
  an LLM-readable contract all derive from the authored YAML.
- **Migration is additive.** (a) add the YAML parse path; (b) generate delegate
  stubs + the controller/validator layer; (c) re-express existing `actions[]`
  hooks as operations and delete the array; (d) complete the editor-agnostic
  validation gate (meta-schema + coherence lint) and wire it into CI + Nano Studio,
  plus the VS Code `.vscode` convenience. Existing JSON specs keep working through
  the deprecation window.
- **Downstream:** `nano-workforce` collapses its two `submit`/`plan` front doors to
  one operation each and repoints its page forms at them via `callRoute` (#150) —
  which also fixes the empty-UI / bypassed-`submitPr` regression that motivated
  both ADRs.

### Non-goals / open questions

- **Non-JSON bodies / streaming.** This ADR keeps ADR 0058's "supported profile"
  (JSON bodies, path/query params, JSON responses). Multipart/streaming stay out of
  scope. The `type` keyword is read in both dialects: OpenAPI 3.0 (`type: T` +
  `nullable: true`) and 3.1 (`type: [T, "null"]` or a multi-type `type` array), so a
  3.1-authored spec's nullable fields emit `T | null` and validate as such rather than
  degrading to `unknown`.
- **Per-operation raw OpenAPI escape hatch.** For the rare construct the generator
  cannot express, allow a raw spec fragment on an operation. Deferred until a real
  case appears — we do not want an escape hatch that quietly reintroduces
  hand-authored ambiguity.
- **Webhook auth schemes.** The exact set of security schemes for the webhook mount
  (shared secret vs capability token in path/header) should be standardised as
  named schemes in the template spec rather than re-invented per app.
