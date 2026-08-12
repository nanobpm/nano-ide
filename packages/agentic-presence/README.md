# @nanobpm/agentic-presence

Presence & registry for the **Nano agentic protocol** (ADR 0056, slice **S2**).

This package owns the `register` / `heartbeat` / `deregister` message families of
the app-tier agentic channel. It provides:

- **`PresenceStore`** — a durable presence registry over the app DataLayer/SQLite
  (ADR 0051's *datasource row registry*). One row per registered worker
  instance, carrying its declared **capability** (`cognition` / `weight` /
  `family` / `host` — an *enrolment attribute*, **never** a routing token), the
  connection it registered on, and a `last_seen` liveness stamp refreshed by
  heartbeats. Rows age out on the presence TTL via `sweep()`.
- **`attachPresenceFamily(hub, store)`** — a self-contained family module that
  attaches to the S1 hub (`@nanobpm/agentic-channel`) through its canonical
  `registerFamilyHandler(family, handler)` seam. It never edits a shared
  frame→family dispatch switch, so it composes with the other wave-2 family
  modules (S5 relay, S7 blackboard) with no shared edit.

## Liveness: S1 owns the connection, S2 owns presence

S1 tracks *connection* liveness in-memory (touch-on-frame + a TTL sweep that
closes silent sockets). S2 layers a **durable presence registry** on top: a
`heartbeat` frame refreshes the row's `last_seen`, and a worker the fleet stops
heartbeating ages out of the registry on the presence TTL. `register` also
mirrors the instance + capability onto S1's in-memory connection registry
(`ctx.registry.setPresence`).

## Schema & migration (single source of truth)

The presence DDL is authored once. The app applies it on boot from
[`db/migrations/001_agentic_presence.sql`](../../db/migrations/001_agentic_presence.sql)
(forward-only, additive), and `PresenceStore.ensureSchema()` applies the
identical statements for programmatic/embedded use. A **drift-guard test**
(`schema.test.ts`) fails if the two ever diverge.

## Usage

```ts
import { AgenticHub } from "@nanobpm/agentic-channel";
import { PresenceStore, attachPresenceFamily } from "@nanobpm/agentic-presence";

// `db` is any app DataLayer SQLite source (host.openSqlite(...)).
const store = new PresenceStore(db, { ttlMs: 30_000 });
const hub = new AgenticHub({ transport, authenticator });

const presence = attachPresenceFamily(hub, store);
// … later, on shutdown:
presence.stop();
```

Built on `@nanobpm/agentic-protocol` (the wire contract) and
`@nanobpm/agentic-channel` (the hub). The Camunda-8 engine transport is a
separate connection and is never touched.
