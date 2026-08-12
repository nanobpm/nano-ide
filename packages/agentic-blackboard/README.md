# @nanobpm/agentic-blackboard

Blackboard family for the **Nano agentic protocol** (ADR 0056, slice **S7**).

This package promotes nano-workforce's per-plan **blackboard** — previously an app
HTTP hook (`/app/api/hooks/blackboard?token=…`) — to a first-class,
capability-scoped `blackboard` message family on the app-tier agentic channel, so
**any Urban app gets it for free**. It provides:

- **`BlackboardStore`** — a durable, per-`scope` advisory coordination store over
  the app DataLayer/SQLite. Agents READ it on dispatch and WRITE to it during
  their work ("I now also touch `state.rs`", "constraint X changed direction Y")
  so parallel siblings coordinate without a human relay. It is a faithful port of
  `plan_blackboard`: the same kinds, idempotent `dedupeKey` append, `file-claim`
  conflict reporting, and `since`/cursor incremental reads — generalised from a
  hard-wired `plan_key` to a capability-derived `scope`.
- **`attachBlackboardFamily(hub, store)`** — a self-contained family module that
  attaches to the S1 hub (`@nanobpm/agentic-channel`) through its canonical
  `registerFamilyHandler(family, handler)` seam. It never edits a shared
  frame→family dispatch switch, so it composes with the other family modules
  (S2 presence, S5 relay) with no shared edit.

## The `blackboard` family: two ops on one family

Both operations ride the one `blackboard` family, distinguished by `payload.op`,
and reply on the **control/facts** lane so a blackboard write is never
head-of-line-blocked behind a bulk-output storm (invariant 5).

### `append`

```jsonc
// request
{ "op": "append", "authorTask": "issue-133", "kind": "file-claim",
  "files": ["db/migrations/003_agentic_blackboard.sql"], "body": "why",
  "wave": 4, "dedupeKey": "optional-idempotency-key" }
// reply (control lane, echoes the request seq)
{ "op": "append", "scope": "<board>", "inserted": true, "id": 7, "conflicts": [] }
```

- `kind` is one of `file-claim`, `constraint-change`, `scope-change`, `learning`,
  `note` (anything else normalises to `note`).
- **Idempotent**: an `append` carrying a stable `dedupeKey` that already exists
  under this `scope` is a no-op — `inserted: false`, the existing `id` returned.
  A partial `UNIQUE (scope, dedupe_key)` index makes it safe under a concurrent
  retry too.
- **Conflict-of-intent**: for a `file-claim` carrying `files`, `conflicts` lists
  prior claims by OTHER authors on the same files (first-writer-wins, advisory —
  the blackboard never locks; the merge step is the real safety net).

### `read`

```jsonc
// request
{ "op": "read", "since": 12 }   // `since` optional
// reply
{ "op": "read", "scope": "<board>", "cursor": 20, "entries": [ /* id > since, write order */ ] }
```

`cursor` is the board's head id (the true head even when `since` filters every
entry out, so a caller learns it is caught up). Pass it back as the next `since`
for incremental polling.

## Capability scope

The board `scope` is **capability-derived**: by default it is the connection's
capability credential — the same credential the S1 handshake gated on, exactly as
nano-workforce's per-plan token is the credential. A connection can therefore only
read/write the board its capability authorises; no board id is trusted from the
payload. Override `attachBlackboardFamily(hub, store, { scopeOf })` to derive the
scope differently (e.g. from an ADR 0028 grant scope).

## Schema & migration (single source of truth)

`BLACKBOARD_SCHEMA_SQL` in `schema.ts` is the canonical DDL, applied by
`BlackboardStore.ensureSchema()`. The boot migration
`db/migrations/003_agentic_blackboard.sql` mirrors it verbatim (a drift-guard test
fails if they diverge). The migration is forward-only and additive, and takes
prefix **003** — after S2's `001_agentic_presence` and S6's `002_agentic_transcript`
(the three migration-adding slices are sequenced into distinct waves so their
prefixes never collide at merge time).
