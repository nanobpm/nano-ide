# Vendored consumer OpenAPI specs (MCP projection conformance corpus)

These are **real** hosted-app `openapi.yaml` documents, vendored and **pinned to a
specific commit**, that the MCP projection is held to by
`npm run check:mcp-conformance -w packages/urban` (wired into CI). Unlike the minimal
synthetic `mcp-parity.fixture.yaml`, these are the actual specs consumer apps ship —
so a projection change (or a spec change) that would advertise a broken tool to an
MCP client fails the build here, on the surface where the `$ref`-body defect
(nanobpm/nano-ide#501) originally surfaced.

For every projected (non-`x-mcp`-excluded) tool the guard asserts the properties
P0 (nanobpm/nano-ide#502) and P1 (nanobpm/nano-ide#503) established:

- **Self-contained input schema** — no unresolved `$ref` and an explicit `type` on
  `body` (a client cannot resolve `#/components/...` outside the source document).
- **Faithful object-body transport** — an object/array body round-trips: an object
  argument reaches the door as an object, and a pre-encoded JSON-string body is
  parsed once (never double-encoded).

The guard needs **no running instance** — it projects the vendored file directly.

## Corpus

| Spec | Source repo | Pinned ref |
| --- | --- | --- |
| `nano-workforce.openapi.yaml` | [`nanobpm/nano-workforce`](https://github.com/nanobpm/nano-workforce) | `2018020a290c2f416e703e3584b27f92ccf27753` |

The pin is the single source of truth in code: `CONSUMER_SPECS` in
`../../runtime/mcp-conformance.ts` (`ref` field) records the same commit. Keep the
table above in sync with that `ref` when refreshing a pin. `mcp-conformance.test.ts`
asserts each `ref` is a full 40-hex commit SHA (so a mutable branch/tag pin cannot
make the guard non-deterministic); it does not verify the table ↔ code ↔ vendored
bytes provenance, so update both together by hand.

## Refreshing a pinned spec

Vendoring is deliberate — the check must be deterministic and offline. To bump a pin,
re-fetch the file at a new commit and update the `ref` in `CONSUMER_SPECS` (and the
table above) in the **same** commit, then re-run the guard:

```sh
REF=<new-commit-sha>
gh api "repos/nanobpm/nano-workforce/contents/openapi.yaml?ref=$REF" \
  --jq '.content' | base64 -d \
  > packages/urban/src/openapi/consumer-specs/nano-workforce.openapi.yaml
# update CONSUMER_SPECS[].ref to $REF, then:
npm run check:mcp-conformance -w packages/urban
```

If a refreshed spec would project a broken tool the guard fails — then either the
projection (`openapi/spec.ts`) or the offending consumer spec is fixed deliberately.
