# ADR 0061 — Structured logging for Urban apps: a level-tagged `AppApi.log` with auto-correlation, emitted as NDJSON

Status: Proposed
Date: 2026-08-10
Extends: ADR 0052 (the runtime is a decoupled manifest interpreter — core stays
pure, host adapters own I/O), ADR 0055 (the runtime absorbs the app surfaces —
workers and the HTTP/OpenAPI surface are where an author's code runs).
Repo: nanobpm/nano-ide (`packages/urban`).

## Context

An Urban app's author code runs in two places: **worker handlers** (`handler(job,
app)`) and **API route delegates** (`handler(input, app)`). Both receive an
`AppApi`. Until now `AppApi.log` was a bare function — `log(level, msg, fields?)` —
that the host printed as a freeform `[urban] msg {json}` line. That left three gaps
for a developer trying to operate an app:

1. **No ergonomics.** `log("info", "…", {…})` is clumsier than `log.info("…", {…})`,
   and there was no `debug` level for verbose diagnostics you can switch off in
   production.
2. **No correlation.** A line emitted deep in a handler carried no job key, process
   instance, request path, or operation id — so you couldn't tie a log line back to
   the request or job that produced it without hand-threading context.
3. **Not machine-parseable.** Freeform text can't be shipped to a log processor and
   filtered/aggregated by field.

## Decision

`AppApi.log` becomes a **`Logger`**: a callable object that is backward-compatible
(`log(level, msg, fields)` still works) but adds the ergonomic surface and
auto-correlation, and the host emits every record as **NDJSON**.

### 1. The `Logger` surface

```ts
app.log.info("charge captured", { amount, currency });
app.log.warn("retrying", { attempt });
app.log.error("charge failed", { code });
app.log.debug("gateway response", { raw });         // off unless URBAN_LOG_LEVEL=debug
const orderLog = app.log.child({ orderId });         // bind context for a scope
orderLog.info("shipped");                             // carries orderId automatically
```

Levels are `debug | info | warn | error`. `child(bindings)` returns a logger that
merges `bindings` into every record (per-call fields win on a key clash; bound
context accumulates down a `child()` chain). The legacy callable form is retained so
no existing code breaks.

### 2. Auto-correlation, injected by the runtime

The runtime hands each author entry point a `log` already bound to its correlation
context — the rest of `AppApi` is shared by reference, only `log` is per-invocation:

- **Worker handler** → `app.log.child({ jobKey, jobType, processInstanceKey?,
  elementId? })` (absent instance/element fields are omitted).
- **API delegate** → `app.log.child({ method, path, operationId })`.

So every line a handler emits carries the request/job it belongs to for free, with no
author effort.

### 3. NDJSON output, owned by the host adapter

`runtime/core/logger.ts` is **pure** (no `node:*`, no `Deno`) per ADR 0052: it only
turns level+msg+fields into a call on an injected `LogSink`. The host adapter
(`adapters/node.ts` / `adapters/deno.ts`) owns:

- **Encoding** — one JSON object per line: `{"ts":…,"level":…,"msg":…, …fields}`.
  Reserved keys `ts`/`level`/`msg` lead and cannot be shadowed by a same-named field,
  so correlation on those keys stays reliable. A `bigint` field is stringified; an
  unserializable/circular `fields` bag degrades to
  `{…,"fieldsError":"unserializable log fields"}` rather than throwing in the hot path.
- **Stream routing** — `warn`/`error` → stderr, `debug`/`info` → stdout.
- **Level filtering** — `URBAN_LOG_LEVEL` (default `info`), read **per-record** so the
  threshold can change without a restart.

## Consequences

- Authors get structured, correlated logs from workers and route handlers with a
  familiar `log.info(msg, fields)` API and zero correlation boilerplate.
- Output is NDJSON on stdout/stderr — greppable locally, shippable to any log
  processor, filterable by `URBAN_LOG_LEVEL` without redeploying.
- The core stays pure and trivially unit-testable with a fake sink; each runtime's
  encoding lives in its adapter. Nothing host-specific leaked into `core/`.
- **Out of scope (for now):** the Nano host does not yet parse or surface these lines
  in the console — this is the urban-side story only. Connector packs use a separate
  `@nanobpm/worker` facade (not `AppApi`) and are unaffected.

## Alternatives considered

- **Adopt a logging library (pino/winston).** Rejected: pulls a `node:*` dependency
  into what must stay a pure, Deno-and-Node core, and is far more surface than the
  need. The pure sink seam gives us NDJSON + levels + child loggers in ~140 lines.
- **Keep the bare function, add correlation via a magic global.** Rejected: implicit
  context is hard to reason about under concurrency; binding `log` per-invocation is
  explicit and testable.
