# ADR 0068 — CLI command projection: the `x-cli` operation extension

Status: Proposed
Date: 2026-11-16
Relates to: ADR 0053 (derivation is a shared library — one walker), ADR 0059 (one HTTP
surface, YAML OpenAPI as source), ADR 0067 (runtime-served MCP surface — the sibling
projection whose `x-mcp` switch this mirrors).
Repo: nanobpm/nano-ide (`packages/urban`). Issue: nanobpm/nano-ide#617.
First consumers: camunda/d8ctl (runtime-installed namespaces, camunda/d8ctl#9) and
nanobpm/nano-workforce (authoring `x-cli` on its spec).

## Context

A native CLI (d8ctl) can install a command namespace generated **at runtime** from an
app's served OpenAPI spec (`/app/api-docs/openapi.json`). Names derived from paths or
`operationId`s read badly (`acknowledge-delivery-graph`), and a CLI that exposes every
operation would hand operator-only doors — today kept away from agents only by
`x-mcp: {exclude: true}` — straight back to any agent with a shell.

## Decision

Urban recognises an `x-cli` operation extension, parsed and validated by the **single
spec walker** (`collectOperations` in `packages/urban/src/openapi/spec.ts`, via the
exported `parseCliExtension`) and exposed on `OperationInfo` as `cli`:

```yaml
x-cli:
  command: [start, feature]     # namespace-relative kebab-case words; required unless exclude
  exclude: true                  # optional; hide from CLI projection
  audience: operator             # optional; shown only behind an explicit operator switch
  positional: [issue]            # optional; body/param fields accepted positionally, in order
  aliases: [[feature, start]]    # optional; extra command paths
```

- **Validation (fails the walker, so `urban gen` and the runtime mount fail loudly)**:
  unknown keys; a `command` that is not a non-empty array of kebab-case words (unless
  `exclude: true`); non-boolean `exclude`; unknown `audience`; malformed `positional` /
  `aliases`; and duplicate command paths (primary or alias) across non-excluded
  operations. Every error is path-qualified, e.g.
  `paths./features.post.x-cli.command[1]: "deliveryGraph" is not a kebab-case word`.
- **Served spec:** the extension stays in the served `openapi.json`; CLIs read it at runtime.
- **Default when absent:** a CLI derives names itself. **An operation that `x-mcp`
  excludes and that has no `x-cli` is treated as `audience: operator`.** This rule is
  implemented once as `effectiveCliAudience` so tools do not each invent one. An explicit
  `x-cli` always wins (an author who writes `x-cli` without `audience` on an
  `x-mcp`-excluded op deliberately exposes it).
- **Snapshot:** `cli-projection.snapshot.json` pins the parsed metadata of
  `cli-projection.fixture.yaml` (`collectCliProjection`), like `mcp-tools.snapshot.json`.

## Relation to MCP projection (ADR 0067)

Both are projections of the same walked operations; neither is declared separately.
`x-mcp` answers "is this an agent tool?", `x-cli` answers "what is this called on a
command line, and who sees it by default?". They are independent switches, linked only by
the documented default above. `audience: operator` is a **discoverability** control, not
access control — real enforcement belongs in the server's auth.

## Consequences

- An invalid `x-cli` breaks the build of the app that declares it — intended.
- Adding a key requires extending `parseCliExtension` (unknown keys are rejected), keeping
  the vocabulary reviewed and single-sourced.
