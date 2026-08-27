# ADR 0067 — Runtime-served MCP surface: agent tools derived from the app contract and engine truth

Status: Proposed
Date: 2026-08-27
Relates to: ADR 0053 (derivation is a shared library — the tool surface is *derived*,
never declared), ADR 0055 (the Urban runtime absorbs app surfaces — this is another
absorbed surface), ADR 0059 (one HTTP surface, YAML OpenAPI as source — the spec this
projects), ADR 0065 (reconciling read models — the canonical projections the debug
tools read).
Repo: nanobpm/nano-ide (`packages/urban`, `packages/urban-testkit`).
Implementation epic: nanobpm/nano-ide#488.
First consumer: nanobpm/nano-workforce (adoption tracked separately there).

## Context

Urban apps are increasingly **operated and debugged by AI coding agents**. The worked
example is nano-workforce: it serves a live, instance-keyed markdown operator guide
over REST (`GET /app/api/agent`) that a human copy-pastes into an agent — or that a
bootstrap skill (`skills/nano-workforce/SKILL.md`) fetches on demand — after which the
agent drives the app's OpenAPI operations with **prose-described `curl`** recipes.

That shape has three concrete costs:

1. **Per-session bootstrap friction.** Every agent session starts with a manual step:
   paste the guide, or load a skill that fetches it. Nothing is discoverable; the
   agent cannot know the surface exists until a human hands it over.
2. **Untyped calls against a typed contract.** The app already *has* a machine-checked
   contract — its `openapi.yaml` — but the agent reaches it through free-form shell
   construction, with the attendant hallucination surface (wrong verb, wrong field,
   mis-interpolated secret) and no schema validation at the call site.
3. **The debugging vocabulary lives at the wrong layer.** The motivating use case —
   *help me debug wedged process instances* — is barely app-specific. Searching
   instances, reading element-instance wait states, listing incidents, inspecting
   variables, cancelling/retrying: this is **engine-generic** vocabulary, identical
   for every Urban app. The canonical projections (`urban_instance_state`,
   `urban_open_user_tasks` — ADR 0065) are **framework-generic**. Only the domain
   playbook (what "wedged" means for *this* app's processes) belongs to the app.
   Today each app would have to reinvent the whole surface.

Meanwhile the harness ecosystem has standardised: MCP (Model Context Protocol) is
natively supported by the agent CLIs we target — including **remote servers over the
streamable-HTTP transport with custom headers** (verified for the GitHub Copilot CLI:
`~/.copilot/mcp-config.json`, `copilot mcp add --transport http`; also Claude,
Cursor, …). A server embedded in the Urban runtime is reachable from agents on other
hosts with no per-app code.

The seams are already in place:

- `mountApi` (`packages/urban/src/runtime/core/modules/api.ts`) **parses each app's
  OpenAPI spec at runtime** and builds its route table via the shared
  `parseSpec`/`collectOperations` (`packages/urban/src/openapi/spec.ts`). Codegen
  (`urban gen`) is additive typing; routing and validation work from the spec alone.
- The `EngineClient` seam (`packages/urban/src/runtime/core/host.ts`) already exposes
  `searchProcessInstances`, `searchElementInstanceWaitStates`, `getElementInstance`,
  `cancelInstance`, `publishMessage`, `searchUserTasks`; `AppApi.sdk`
  (declared in `packages/urban/src/runtime/core/context.ts`, typed as `EngineSdkClient`
  from `packages/urban/src/runtime/engine/sdk.ts`) exposes the full nano-sdk, **including
  incidents**, when on the nano-sdk transport.
- The runtime already serves per-app generic endpoints the app did not author —
  `/app/agent`, `/app/agent.json` (`modules/agent.ts`) and `/app/api-docs`
  (`modules/api.ts`) — and exposes
  the native server as `UrbanApp.httpServer` precisely so surfaces can attach to it
  (the `/agentic` WebSocket precedent).

## Decision

Serve MCP **from the Urban runtime**, as a per-app generic surface mounted for every
hosted app — one new core module (`packages/urban/src/runtime/core/modules/mcp.ts`),
no new package (per the subpath-export rule). Four parts.

### 1. The endpoint

A streamable-HTTP MCP endpoint at `/app/mcp` on the app's own HTTP server, mounted
unconditionally like `/app/api-docs`. Served by the runtime in-process with the app,
so the exposed tools are **version-matched by construction** — the invariant the
live-guide design protected by convention now holds structurally. Adds
`@modelcontextprotocol/sdk` as a `packages/urban` dependency. Bind/guard posture
follows the existing network story: loopback by default, LAN exposure via the
app-manifest `network.bind` setting.

### 2. App-operation tools: projected, not declared

The module projects the app's `openapi.yaml` into MCP tools using the *same*
`parseSpec`/`collectOperations` enumeration `mountApi` already performs:
`operationId` → tool name, request-body schema → input schema, response → tool
result. Dispatch resolves through the same delegate registry as HTTP. **No
hand-authored tool definitions** — a second representation of the contract is exactly
the drift class ADR 0053 forbids, and a CI guard (spec ↔ tool-list parity, the
`layout:check` analogue) alarms if the projection ever diverges.

The app declares only an **exclusion list** (convention: an `x-mcp` extension on the
operation, defaulting to exposed). Operator-only doors stay operator-only — e.g.
nano-workforce's `dispatchDeliveryGraph`, whose approval *is* a human clicking
Dispatch in the cockpit (nwf ADR 0005), is never a tool.

### 3. Framework-owned debug tools over both planes

A fixed, app-agnostic tool family for process debugging, exposed for every app:

- **Engine truth** — search process instances, get element-instance wait states,
  read instance variables, list/get incidents. This requires **extending the
  `EngineClient` seam** with incidents and the unstick mutations
  (`resolveIncident`/retry, `setVariables`) — implemented in **both** adapters
  (`engine/nanosdk.ts` and `urban-testkit`'s `WasmEngineClient`) with the
  engine-client conformance harness extended to pin parity, per the repo's
  seam-discipline conventions.
- **Urban projections** — read the canonical ADR 0065 projections
  (`urban_instance_state`, `urban_open_user_tasks`) so an agent can diff *what the
  app thinks is happening* against engine truth. A wedge is frequently exactly that
  disagreement, so both planes are first-class tools, not one plane derived from the
  other.

### 4. Read/mutate split, resources, prompts

- **Read tools on by default; mutations guarded.** Diagnostic tools (search, wait
  states, variables, incidents, projections, and read-only app operations) need no
  credential beyond loopback. Mutating tools (cancel instance, resolve/retry
  incident, set variables, side-effecting app operations) require the app's shared
  secret, reusing Urban's existing operation-guard convention: an OpenAPI `apiKey`
  security scheme whose expected value is an env pointer via `x-nano-secret-env`
  (ADR 0059/0025/0027, e.g. `NANO_WEBHOOK_KEY`), presented as a header on the MCP
  connection from the client config, or an explicit runtime opt-in.
- **Resources carry the prose.** The runtime serves its system brief
  (`/app/agent.json`) as an MCP resource; an app may register a **domain playbook**
  (nano-workforce's operator guide) as an additional resource through the module.
  Tool schemas carry parameters, not procedure — the workflow knowledge (orient
  first, preview before dispatch, escalations are for humans) stays prose, now
  discoverable over the same channel.
- **A prompts entry** for the orientation ritual (check version/status, then act).

## Consequences

- **Every Urban app becomes agent-operable and agent-debuggable for free.** The
  OpenAPI projection covers the app's own operations; the debug family covers the
  engine; the app ships zero MCP code. nano-workforce's operator surface gets MCP
  exposure automatically, and its skill shrinks to "add this MCP server" for
  MCP-capable clients.
- **REST + the live guide remain canonical and stay.** MCP is a third door and a
  *projection* of the OpenAPI contract, not a replacement; agents without MCP keep
  the curl path. No existing endpoint changes behaviour.
- **The seam extension is the durable win.** Incidents/retry/set-variables on
  `EngineClient` — conformance-tested across the live adapter and the WASM testkit —
  is a permanent capability improvement independent of MCP; any future surface
  (Operate-like UI, CLI) builds on the same methods.
- **Instance selection gets structurally safer.** Multi-instance users register one
  MCP server entry per instance (`local`, `merlin`, `remote`); the host namespaces
  tools per server, so the wrong-instance mistake the nwf skill currently guards
  against in prose becomes impossible by construction.
- **New trusted surface, honestly scoped.** The mutation tools are the blast-radius
  step-up; the read/mutate split plus loopback-by-default keeps the default posture
  equivalent to today's read-mostly guide. The `x-mcp` exclusion list is a
  security-relevant authoring rule and must be documented as such.
- **Drift-surface audit:** the projection derives from the spec (no second contract);
  the parity guard alarms on skew; the debug family is fixed framework code. No new
  per-app authoring surface is introduced.

## Rollout (each step independently shippable, PR-sized)

1. **Read-only MCP module.** `/app/mcp` serving: app-operation tools (read-only
   operations only), the engine-truth *read* tools (existing seam methods suffice),
   projection read tools, the system-brief resource, and the orientation prompt.
   Loopback-only. Ships behind a manifest/env flag, default on for loopback.
2. **Seam extension.** Incidents + `resolveIncident`/retry + `setVariables` on
   `EngineClient`: nano-sdk adapter, `WasmEngineClient`, conformance harness.
3. **Mutation tools** (cancel/resolve/retry/set-variables + side-effecting app
   operations) behind the shared-secret guard; document the `x-mcp` exclusion
   convention; spec↔tool parity guard in CI.
4. **First consumer adoption** (nano-workforce, tracked there): register the operator
   guide as a playbook resource, mark `dispatchDeliveryGraph` excluded, publish the
   agent-configuration runbook, slim the skill to bootstrap MCP where available.
