# @nanobpm/agentic-transcript

Transcript store for the **Nano agentic protocol** (ADR 0056, slice **S6**).

This package provides **retention-by-lifecycle** over the app DataLayer/SQLite:
a durable transcript for the live-terminal relay (S5), retained differently
depending on the stream's lifecycle.

- **`TranscriptStore`** — a durable store over the app DataLayer (the tiny
  synchronous `SqliteDb` surface the Urban runtime exposes). It flushes an S5
  `ReplayRing` to a durable transcript, serves resume-from-offset reattach, and
  applies retention differentiated by lifecycle.

Nothing here rides the Camunda-8 engine or its transport — the transcript store
sits on the app tier alongside the S2 presence registry (`registry rows /
transcript store ── app DataLayer (S2/S6)`).

## Retention by lifecycle

| Lifecycle     | How it fills                                   | How it retains                                             | Reattach |
| ------------- | ---------------------------------------------- | --------------------------------------------------------- | -------- |
| `ephemeral`   | `flush(stream, ring, "ephemeral")` on job completion — the whole S5 ring is written and the transcript is marked `completed`. | Kept whole until `sweep()` retires it past `ephemeralRetentionMs` after `completed_at`. | `read()` / `since()` |
| `long-lived`  | `record(stream, entries, "long-lived")` incrementally as the stream advances. | Bounded by a rolling window via `truncateBefore(offset)`; nothing time-sweeps it. | `since(from)` |

Both lifecycles reattach through `since(from)`, which returns the same
`{ entries, gap, nextOffset }` shape as the S5 `ReplayRing.since` — a reattach
behaves identically whether it resumes from the live ring or the durable
transcript. `gap` is `true` when `from` predates the oldest retained offset (a
consumer asked for chunks retention already dropped).

## Ephemeral run → durable transcript

```ts
import { ReplayRing } from "@nanobpm/agentic-relay";
import { TranscriptStore } from "@nanobpm/agentic-transcript";

const store = new TranscriptStore(db); // db: the app DataLayer SqliteDb
store.ensureSchema();                  // or let the boot migration apply it

// … a job's terminal output accumulates in an S5 ring …
const ring = new ReplayRing({ capacity: 1024 });

// On job completion, flush the ring to a durable, readable transcript.
store.flush("run-42", ring, "ephemeral");
store.read("run-42"); // the full transcript, in offset order
```

## Long-lived stream → resumable reattach

```ts
store.record("session-1", [{ offset, chunk }], "long-lived"); // as the stream advances

// A consumer that saw through offset 41 reconnects:
const { entries, gap, nextOffset } = store.since("session-1", 42);
// entries = the tail from 42; gap = false; nextOffset = where the live stream continues

store.truncateBefore("session-1", 1000); // rolling retention; older reattach now reports gap
```

## Schema & migration (single source of truth)

The DDL lives once in `src/schema.ts` as `TRANSCRIPT_SCHEMA_SQL`
(`TranscriptStore.ensureSchema()` applies it) and is **mirrored** by the
forward-only, additive boot migration `db/migrations/002_agentic_transcript.sql`
(applied by the DataLayer migration runner). `schema.test.ts` normalises both and
asserts they never drift — edit the canonical schema and the migration mirror
**together**.

Migration numbering is a shared epic surface: S6 is sequenced **after** S2's
`001_agentic_presence.sql` and **before** S7 (`#133`), so it simply takes the
next free prefix (`002`).

## Design invariants (ADR 0056)

- **App-tier, not engine-tier** — the store sits on the app DataLayer; the C8
  engine and its transport are untouched.
- **Immutable chunks** — a chunk keyed `(stream, offset)` is written once;
  retention drops whole windows/streams, it never rewrites a chunk. `record` and
  `flush` are therefore idempotent (a retry or overlapping reattach writes
  nothing new).
- **Monotonic `nextOffset`** — the resume high-water mark only ever rises, so a
  head truncation or a re-flush cannot rewind a consumer's resume point.
