// instance-tracking — the process-instance lifecycle reconciler (manifest `instanceTracking`).
//
// The problem it closes: an Urban app derives a row's status from the workers that run
// along a process's *happy path*. When an instance instead reaches an engine-truth state with
// no worker to record it, the read-model row lies. Two such edges are derived from engine truth:
//
//  - The **terminal** edge (`onTerminated`): each binding's poll asks the engine which of its
//    active instances are `TERMINATED`. A terminated instance runs no completion worker, so nothing
//    else would ever close the row.
//
//  - The **wait-on-human** edge (`onWaitingHuman`, issue #355): the symmetric primitive for
//    "this instance is parked waiting on a human." That state is authoritatively knowable — an
//    instance is waiting on a human *iff* it has an open user task (`openUserTasks` =
//    `searchUserTasks({state:"CREATED"})`) — for every process, forever, with no per-element registry.
//
// SOURCE, NOT WRITER (ADR 0065, surface #1; #439-L1 / #318). This reconciler used to *write* those
// derived edges — `reconcileTerminatedKey` / `reconcileWaitingHumanKey` applied `onTerminated.set` /
// `onWaitingHuman.set` as `table.update` patches on the app's base row. A stored derived value tears
// from its inputs (nano-workforce#422: an answered escalation still showed a stale ⚠). The inversion
// makes the reconciler a SOURCE: each poll FEEDS engine truth into the canonical projections
// (`urban_instance_state` gets the `TERMINATED` fact; `urban_open_user_tasks` gets the instance's
// current open-task set), and the two edges are DERIVED — recomputed on every read — by a
// `defineReadModel` VIEW over those projections (see `instance-status-read-model.ts`). Because the
// wait-on-human edge is an `EXISTS` over the live open-task projection, retiring an answered task via
// `OpenUserTasksStore.syncInstance` makes the edge go false on the next read by construction, so the
// #422 staleness cannot recur.
//
// Precedence (terminated wins over waiting-human) is preserved in the derivation, not in a write
// order. It deliberately records the terminal source only on `TERMINATED` — the state that by
// definition runs no completion worker — and never on `COMPLETED`, whose terminal row-write the app's
// own finalize worker owns. The wait-on-human edge reads *open* user tasks via `openUserTasks` (never
// a bare `searchUserTasks`, which lags a completion). Real business-outcome writes owned by app workers
// (e.g. a finalize worker's terminal outcome) are untouched — only the derivable edges are inverted.
// The poll is driven through the shared `SchedulerDeps` seam so tests are deterministic.

import type { AppApi, Mounted, RuntimeContext } from "../context.ts";
import type { UserTaskSummary } from "../host.ts";
import { type InstanceTracking, isConfiguredStatusSelector } from "../manifest.ts";
import { assertSqlIdentifier, lookupColumn, readModelRegistry } from "../read-model.ts";
import { registerCanonicalProjections } from "./canonical-projections.ts";
import { defineInstanceTrackingReadModel, instanceTrackingReadModelTarget, TERMINATED_STATE } from "./instance-status-read-model.ts";
import { INSTANCE_STATE_PROJECTION, InstanceStateStore } from "./instance-state-store.ts";
import { OpenUserTasksStore } from "./open-user-tasks-store.ts";
import { defaultScheduler, MAX_TIMER_DELAY_MS, type SchedulerDeps } from "./scheduler.ts";

/** Default poll interval when a binding does not set `pollMs`. */
export const DEFAULT_INSTANCE_TRACKING_POLL_MS = 15_000;

/** Max in-flight `openUserTasks` probes per reconcile pass. The wait-on-human edge probes the
 *  engine once per active, non-terminated key; probing them sequentially makes a pass O(N) network
 *  round-trips and can make a single pass take longer than `pollMs` under a large active backlog.
 *  Probing in bounded-parallel batches makes wall-clock time scale with max latency rather than
 *  N×latency, while the cap keeps in-flight load on the engine bounded. */
export const WAITING_HUMAN_PROBE_CONCURRENCY = 8;

export interface InstanceTrackingHandle extends Mounted {
  /** `table.keyField` labels of the armed bindings, for `inspect()`. */
  readonly bindings: string[];
}

type Row = Record<string, unknown>;

/**
 * The canonical engine-truth projections the reconciler feeds as a SOURCE (ADR 0065, the writer→source
 * inversion): the instance-state projection (feeds the terminal edge) and the open-user-tasks projection
 * (feeds the wait-on-human edge). Both are sidecars on the app's own default data source; the derived
 * status read model `EXISTS`-derives its edges from them.
 */
export interface InstanceProjections {
  readonly instanceState: InstanceStateStore;
  readonly openUserTasks: OpenUserTasksStore;
}

/**
 * Construct the canonical projection stores over the app's default data source and ensure their schema
 * (idempotent), exactly the per-source boot path `tryLineageStore` / `tryProvisionCanonicalProjections`
 * use. Absent-safe: with no default source there is nothing to feed, so return `undefined` at `debug`
 * (the expected sidecar-absent case). A genuine provisioning fault (missing named source, schema error)
 * degrades to `undefined` at `warn` rather than breaking the mount — a projection feed must never break
 * a job.
 */
export function tryInstanceProjections(api: Pick<AppApi, "data" | "log">): InstanceProjections | undefined {
  if (!api.data.hasDefaultSource()) {
    api.log("debug", "instanceTracking: no default data source; projection feed disabled");
    return undefined;
  }
  try {
    const { db } = api.data.source();
    const instanceState = new InstanceStateStore(db);
    const openUserTasks = new OpenUserTasksStore(db);
    instanceState.ensureSchema();
    openUserTasks.ensureSchema();
    return { instanceState, openUserTasks };
  } catch (err) {
    api.log("warn", "instanceTracking: failed to provision projection stores; feed disabled", {
      error: String(err),
    });
    return undefined;
  }
}

/** Record engine-truth that an instance is TERMINATED into the canonical `urban_instance_state`
 *  projection and retire its open-user-task rows — the writer→source replacement for the old
 *  `onTerminated.set` `table.update` patch (ADR 0065; #439-L1 / #318). The derived terminal status edge
 *  (a VIEW / function over the projection) reflects this on the next read, so there is no stored-derived
 *  column to tear from its inputs (nano-workforce#422). This is the SINGLE place that records the terminal
 *  source: both the poll reconciler (`reconcileOnce`, once per TERMINATED key it discovers) and the cancel
 *  primitive (`cancel.ts`, immediately when it terminates an instance) route through it, so the two can
 *  never drift. Absent-safe (no projections / blank key ⇒ 0) and never throws through — a projection write
 *  must never break a job or a cancel. Returns 1 when it recorded the terminal source, else 0. */
export function reconcileTerminatedKey(
  api: Pick<AppApi, "log">,
  projections: InstanceProjections | undefined,
  processInstanceKey: string,
): number {
  const key = String(processInstanceKey ?? "");
  if (!projections || !key) return 0;
  try {
    // Retire the open tasks BEFORE recording TERMINATED so no reader can observe a terminated instance
    // that still looks parked on a human (terminated wins over waiting-human, at the source as in the
    // derivation). Both writes are idempotent.
    projections.openUserTasks.clearInstance(key);
    // `recordState` returns false when the state is unchanged (an already-recorded TERMINATED re-fed on a
    // later tick or by the cancel path). Only log/count a REAL transition: without this, every repeated
    // terminal poll of a settled instance emits an info log and inflates `reconciled` as if it wrote,
    // producing one spurious "recorded terminated instance" line per settled instance per tick.
    const changed = projections.instanceState.recordState(key, TERMINATED_STATE, false);
    if (!changed) return 0;
    api.log("info", "instanceTracking: recorded terminated instance", {
      projection: INSTANCE_STATE_PROJECTION,
      processInstanceKey: key,
    });
    return 1;
  } catch (err) {
    api.log("warn", "instanceTracking: failed to record terminated instance", {
      processInstanceKey: key,
      error: String(err),
    });
    return 0;
  }
}

/** Feed an instance's CURRENT open-user-task set into the canonical `urban_open_user_tasks` projection
 *  — the wait-on-human twin of {@link reconcileTerminatedKey} (issue #355). `syncInstance` is
 *  authoritative-per-instance: it inserts the still-open tasks and RETIRES any previously-projected task
 *  that is no longer open, so an answered/closed escalation makes the derived wait-on-human edge go false
 *  on the next read by construction (nano-workforce#422 — no stored column to leave stale). Passing an
 *  EMPTY `openTasks` clears the instance, which is exactly the answered-escalation transition; callers
 *  MUST therefore feed every probed non-terminated key, including those with no open task, or a retired
 *  task would linger and the edge would tear. Absent-safe (no projections / blank key ⇒ 0) and never
 *  throws through. Returns 1 when it fed the projection, else 0. */
export function reconcileWaitingHumanKey(
  api: Pick<AppApi, "log">,
  projections: InstanceProjections | undefined,
  processInstanceKey: string,
  openTasks: readonly UserTaskSummary[],
): number {
  const key = String(processInstanceKey ?? "");
  if (!projections || !key) return 0;
  try {
    // Re-check the terminal source IMMEDIATELY before the sync. `openTasks` was probed with an `await`
    // that yields the event loop, so a concurrent cancel (or another binding's poll) can record this
    // instance TERMINATED and retire its tasks WHILE the probe is in flight. Terminated wins, so
    // re-inserting the (now stale) open tasks here would strand a row `reconcileTerminatedKey` already
    // cleared — the key is then classified settled and never re-probed, leaving a permanent stale
    // projection row. If it went terminal, ensure the tasks stay retired and skip the sync.
    if (projections.instanceState.getState(key)?.state === TERMINATED_STATE) {
      projections.openUserTasks.clearInstance(key);
      return 0;
    }
    projections.openUserTasks.syncInstance(key, openTasks);
    return 1;
  } catch (err) {
    api.log("warn", "instanceTracking: failed to record open user tasks", {
      processInstanceKey: key,
      error: String(err),
    });
    return 0;
  }
}


/** Poll one binding's instances once. Selects the active rows, asks the engine which of their instances
 *  are TERMINATED, and FEEDS that terminal fact into the canonical `urban_instance_state` projection;
 *  then, for the binding's wait-on-human edge (`onWaitingHuman`, issue #355), FEEDS each non-terminated
 *  active row's current open-user-task set into `urban_open_user_tasks`. It writes NO derivable status
 *  column on the base row — the two edges are DERIVED from the projections by the managed read-model VIEW
 *  (ADR 0065). Returns how many keys were scanned and how many projection sources were fed this tick. */
async function reconcileOnce(
  api: AppApi,
  binding: InstanceTracking,
  projections: InstanceProjections | undefined,
): Promise<{ scanned: number; reconciled: number }> {
  // A binding mounted without a default data source (e.g. `mount.data: false`) has no table to poll and
  // no VIEW to derive: `provisionInstanceTrackingViews`/`tryInstanceProjections` already degraded to
  // no-ops at mount. Return the honest zero-count no-op here rather than falling through to
  // `api.data.table(...)`, which THROWS with no default source and would log `reconcile failed` on every
  // interval (the timer is still armed) — noise masquerading as a real failure.
  if (!api.data.hasDefaultSource()) return { scanned: 0, reconciled: 0 };
  const table = api.data.table<Row>(binding.table, binding.keyField);

  // Select the rows worth polling. Three modes, in precedence order:
  //  - `terminalStatuses` (fail-open exclusion): poll every row whose `statusField` is NOT
  //    a terminal value. A newly-added non-terminal status is polled by default, so it can't
  //    silently fall out of reconciliation; only already-terminal rows are excluded (bounded).
  //  - `activeStatuses` (fail-closed allow-list): poll only rows in an enumerated active status.
  //  - neither: poll every row; the engine query returns only TERMINATED instances and the projection
  //    feed is idempotent, so re-feeding a settled row is a harmless no-op.
  // `terminalStatuses` and `activeStatuses` are mutually exclusive per binding (validation rejects
  // both); if both are somehow present, `terminalStatuses` wins (the fail-open selector). Each
  // selector is gated through the shared `isConfiguredStatusSelector` predicate (a non-empty array
  // of non-empty strings) — the same one validation uses — so a malformed value (a bare string, an
  // empty array) degrades to the fail-open poll-all path here instead of `new Set("abandoned")`
  // silently filtering by character, or a non-array crashing `activeStatuses.map(...)`.
  let candidates: Row[];
  const statusField = binding.statusField;
  if (statusField && isConfiguredStatusSelector(binding.terminalStatuses)) {
    const terminal = new Set(binding.terminalStatuses);
    const all = await table.all();
    candidates = all.filter((row) => !terminal.has(String(lookupColumn(row, statusField))));
  } else if (statusField && isConfiguredStatusSelector(binding.activeStatuses)) {
    const perStatus = await Promise.all(
      binding.activeStatuses.map((s): Promise<Row[]> => table.find({ [statusField]: s })),
    );
    candidates = perStatus.flat();
  } else {
    candidates = await table.all();
  }

  // Map each active row to its tracked instance key. A row with no/empty key can't be
  // reconciled (it never started an instance, or the column is unset) — skip it. Resolve `keyField`
  // with the SAME case-insensitive column lookup the read-model VIEW compiler uses (SQLite folds
  // identifier case, so a binding `keyField: "Process_Key"` over a `process_key` column correlates in
  // the derived VIEW): a plain case-sensitive `row[binding.keyField]` would read `undefined` here and
  // feed NO keys into either projection, so neither terminal nor waiting-human status could derive.
  const keyToRows = new Map<string, Row[]>();
  for (const row of candidates) {
    const raw = lookupColumn(row, binding.keyField);
    if (raw == null || raw === "") continue;
    const key = String(raw);
    const list = keyToRows.get(key);
    if (list) list.push(row);
    else keyToRows.set(key, [row]);
  }
  const keys = [...keyToRows.keys()];

  // NB: do NOT early-return on an empty active set. A key that LEFT the active selector (its task was
  // answered and its worker flipped it to a non-active status) still has a stale open-task projection to
  // retire below — returning early here would strand it, re-tearing the derived edge (ADR 0065). The
  // engine query and human probe both degrade to no-ops on an empty set, so falling through is cheap.

  // Skip keys already recorded TERMINATED in the canonical projection: a settled instance never leaves
  // TERMINATED, and the base row keeps its (unchanged) `statusField`, so with `activeStatuses`/no-selector
  // it would pass the selector on every tick and be re-queried + re-fed forever (the old `table.update`
  // moved it out of the active set; the inversion deliberately does not). The projection is the
  // authoritative settled-set, so exclude those keys from both the engine query and the wait-on-human
  // probe below — a pure efficiency win (the re-feed was already an idempotent no-op).
  // `settled` drives a projection `getState` — a real SQL round trip (SELECT … WHERE
  // process_instance_key = ?) — and is consulted for the same key up to three times per pass (the
  // live-key filter here, then the wait-on-human `humanKeySet` build and its projected-open scan). The
  // settled set cannot change mid-pass except for keys THIS pass terminates, and those are already
  // excluded downstream via `terminatedKeys`, so caching the first result per key is behaviour-preserving
  // and caps the projection at one query per distinct key (bounding a large-backlog pass's SQL fan-out).
  const settledCache = new Map<string, boolean>();
  const settled = (key: string): boolean => {
    const cached = settledCache.get(key);
    if (cached !== undefined) return cached;
    const value = projections?.instanceState.getState(key)?.state === TERMINATED_STATE;
    settledCache.set(key, value);
    return value;
  };
  const liveKeys = keys.filter((key) => !settled(key));

  const snapshots = liveKeys.length > 0
    ? await api.engine.searchProcessInstances({ processInstanceKeys: liveKeys, state: "TERMINATED" })
    : [];

  // Feed the terminal fact through the shared `reconcileTerminatedKey` — the one place that records the
  // terminal source into `urban_instance_state` — so the poll path and the cancel primitive can never
  // drift (No Drift Surfaces). No base-row write: the terminal status edge is DERIVED from the projection.
  let reconciled = 0;
  const terminatedKeys = new Set<string>();
  for (const snap of snapshots) {
    if (snap.state !== "TERMINATED") continue; // defensive; we asked for TERMINATED only
    if (!keyToRows.has(snap.processInstanceKey)) continue; // not one we were tracking
    terminatedKeys.add(snap.processInstanceKey);
    reconciled += reconcileTerminatedKey(api, projections, snap.processInstanceKey);
  }

  // Wait-on-human edge (issue #355), symmetric to onTerminated. Precedence: terminated wins, so a key
  // recorded as terminated above (or already settled) is excluded here (its open tasks were retired). An
  // instance is "waiting on a human" iff it has an open user task — the authoritative engine truth — so
  // read `openUserTasks` (never a bare `searchUserTasks`, which lags a completion and would latch a closed
  // task; issue #355 "instance B") and FEED that current open set into the projection via
  // `reconcileWaitingHumanKey`. Feed EVERY probed key, including those with NO open task: an empty set
  // RETIRES a just-answered task so the derived edge re-flips to non-parked by construction — this is the
  // nano-workforce#422 fix (a stored write would have left `awaiting_operator` stale). Probe in
  // bounded-parallel batches (`WAITING_HUMAN_PROBE_CONCURRENCY`) so a pass over a large active backlog
  // scales with max latency rather than N×latency.
  if (binding.onWaitingHuman) {
    const humanKeySet = new Set(keys.filter((key) => !terminatedKeys.has(key) && !settled(key)));
    // Retire stale projections INDEPENDENTLY of the active-status selector. With `activeStatuses`, a key
    // can be projected while its task is open and then move to a non-active worker status when the task is
    // answered — it then never passes the selector again, so its `urban_open_user_tasks` row would linger
    // and the VIEW keep deriving `awaiting_operator` (a fresh #422 tear). Re-probe every key STILL
    // projected as open so an answered/closed one is retired (`syncInstance([])`). The projection is
    // app-wide, but re-syncing a key another binding owns is a harmless idempotent no-op against engine
    // truth, so probing the whole projected set is always safe.
    if (projections) {
      for (const key of projections.openUserTasks.instanceKeys()) {
        if (!terminatedKeys.has(key) && !settled(key)) humanKeySet.add(key);
      }
    }
    const humanKeys = [...humanKeySet];
    for (let i = 0; i < humanKeys.length; i += WAITING_HUMAN_PROBE_CONCURRENCY) {
      const batch = humanKeys.slice(i, i + WAITING_HUMAN_PROBE_CONCURRENCY);
      const perKey = await Promise.all(
        batch.map(async (key): Promise<number> => {
          // Isolate each key's probe: one engine `openUserTasks` rejection must NOT reject the whole
          // `Promise.all` batch. Batches are awaited sequentially, so a single permanently-failing key in
          // an early batch would otherwise starve every key in later batches on every tick, letting their
          // stale open-task projections persist indefinitely. On a per-key failure, log and skip (count 0)
          // — the projection is left as-is and re-probed next pass — so one bad engine response cannot
          // stall the rest of the backlog.
          try {
            const openTasks = await api.engine.openUserTasks({ processInstanceKey: key });
            return reconcileWaitingHumanKey(api, projections, key, openTasks);
          } catch (err) {
            api.log("warn", "instanceTracking: openUserTasks probe failed; key skipped this pass", {
              key,
              error: String(err),
            });
            return 0;
          }
        }),
      );
      for (const n of perKey) reconciled += n;
    }
  }
  return { scanned: keys.length, reconciled };
}

/** The subset of the SQLite source handle the VIEW provisioner needs. */
type ProvisionDb = { exec(sql: string): void; all<T = Record<string, unknown>>(sql: string, params?: unknown[]): T[] };

/** Is there a NON-view object (a real table) named `name` in the database? SQLite shares one namespace
 *  for tables and views, so a real table shadows a managed VIEW: `DROP VIEW IF EXISTS` won't remove it
 *  and `CREATE VIEW IF NOT EXISTS` then silently no-ops. Provisioning must refuse rather than appear to
 *  succeed while a page reads the wrong object. The name match is `COLLATE NOCASE`: SQLite resolves
 *  object names case-insensitively, so a real table `plans__tracking` shadows a configured view
 *  `Plans__tracking` at DROP/CREATE time — a binary `=` here would miss it and defeat this guard. */
function nonViewObjectExists(db: ProvisionDb, name: string): boolean {
  const rows = db.all<{ type: string }>(`SELECT type FROM sqlite_master WHERE name = ? COLLATE NOCASE AND type <> 'view'`, [name]);
  return rows.length > 0;
}

/** Retire (DROP) a previously-managed tracking VIEW by name. Used on every skip path (a binding with no
 *  `statusField`, a base-column collision) so a manifest change or a schema drift cannot leave a stale,
 *  still-readable derived surface behind. Only ever drops a VIEW (never a real table of the same name),
 *  and never throws through — a retire failure must not break the mount. */
function retireManagedTrackingView(api: Pick<AppApi, "log">, db: ProvisionDb, viewName: string, table: string): void {
  try {
    db.exec(`DROP VIEW IF EXISTS main."${viewName}";`);
  } catch (err) {
    api.log("warn", `instanceTracking: failed to retire stale derived VIEW "${viewName}"`, {
      table,
      error: String(err),
    });
  }
}

/** Retire (DROP) every managed tracking VIEW for these bindings, used when the projection feed is
 *  unavailable (`tryInstanceProjections` returned undefined because projection-store provisioning
 *  failed). Without this, a VIEW an earlier successful boot published is left readable and keeps
 *  deriving a value over projection tables this mount has no coherent source for — a silent stale
 *  surface. Retiring turns that into an honest "no such object" instead. Absent- and error-safe: with
 *  no default data source there is no db and nothing managed to retire, and a retire failure never
 *  breaks the mount. Deduplicates by folded VIEW name (a status-bearing + status-less binding on one
 *  table share the default name) so we DROP each once. */
function retireInstanceTrackingViews(api: AppApi, bindings: readonly InstanceTracking[]): void {
  if (bindings.length === 0) return;
  if (!api.data.hasDefaultSource()) return;
  let db: ProvisionDb;
  try {
    db = api.data.source().db;
  } catch (err) {
    api.log("warn", "instanceTracking: failed to resolve default source; stale derived VIEWs not retired", {
      error: String(err),
    });
    return;
  }
  const retired = new Set<string>();
  for (const binding of bindings) {
    let viewName: string;
    try {
      viewName = assertSqlIdentifier("instanceTracking.readModel.view", instanceTrackingReadModelTarget(binding).view);
    } catch {
      // A non-identifier view name was never provisionable, so there is nothing managed to retire.
      continue;
    }
    const folded = viewName.toLowerCase();
    if (retired.has(folded)) continue;
    retired.add(folded);
    retireManagedTrackingView(api, db, viewName, binding.table);
  }
}

/** Provision each binding's DERIVED read-model VIEW on the app's default data source (ADR 0065, the
 *  writer→source inversion). The VIEW re-exports `base.*` plus a derived effective-status column computed
 *  by a `defineReadModel` derivation over the canonical projections, so the operator page reads the
 *  derived status with no stored write. Registers the canonical projection NAME→physical-table mapping
 *  first (idempotent) so the VIEW's `EXISTS` resolves to the `_urban_*` tables even if the worker mount
 *  did not run. Truly MANAGED — DROP+CREATE — so a changed derivation always replaces a stale VIEW body.
 *  Absent- and error-safe like lineage: no default source provisions nothing, and a VIEW failure never
 *  breaks the mount. A binding with no `statusField` has no derivable status, so no VIEW is provisioned
 *  (its projections are still fed). */
function provisionInstanceTrackingViews(api: AppApi, bindings: readonly InstanceTracking[]): void {
  if (bindings.length === 0) return;
  // Make the DSL projection names (`urban_instance_state` / `urban_open_user_tasks`) resolve to their
  // physical `_urban_*` tables. Idempotent; safe even when the worker mount already registered them.
  registerCanonicalProjections();
  if (!api.data.hasDefaultSource()) {
    api.log("debug", "instanceTracking: no default data source; derived VIEW provisioning skipped");
    return;
  }
  let db: ProvisionDb;
  try {
    db = api.data.source().db;
  } catch (err) {
    api.log("warn", "instanceTracking: failed to resolve default source; derived VIEWs not provisioned", {
      error: String(err),
    });
    return;
  }
  // View names claimed by a CURRENT status-bearing binding (folded — SQLite folds identifiers). A
  // status-less binding shares its base table's default `<table>__tracking` name with a status-bearing
  // binding on the same table, and its retire path (below) would otherwise DROP the view that binding
  // just created (iteration-order dependent). Validation guarantees no two status-bearing bindings share
  // a view name, so this set is unambiguous. Retirement consults it so it only drops UNCLAIMED names.
  const claimedByStatusful = new Set<string>();
  for (const b of bindings) {
    if (typeof b.statusField !== "string" || b.statusField.length === 0) continue;
    claimedByStatusful.add(instanceTrackingReadModelTarget(b).view.toLowerCase());
  }
  for (const binding of bindings) {
    // Resolve the managed VIEW name (config override or `<table>__tracking`) up front — we need it even
    // on the skip paths below to RETIRE a previously-managed VIEW, so a manifest change (statusField
    // dropped) or a collision cannot leave a stale, still-readable derived surface behind.
    const { view: targetView, statusColumn } = instanceTrackingReadModelTarget(binding);
    let viewName: string;
    try {
      viewName = assertSqlIdentifier("instanceTracking.readModel.view", targetView);
    } catch (err) {
      api.log("warn", "instanceTracking: invalid read-model view name; derived VIEW skipped", {
        table: binding.table,
        error: String(err),
      });
      continue;
    }

    let model: ReturnType<typeof defineInstanceTrackingReadModel>;
    try {
      model = defineInstanceTrackingReadModel(binding);
    } catch (err) {
      api.log("warn", "instanceTracking: invalid read-model config; derived VIEW skipped", {
        table: binding.table,
        error: String(err),
      });
      continue;
    }
    if (!model) {
      // No statusField ⇒ nothing derivable to project. Retire any VIEW an earlier boot managed under
      // this name — UNLESS a current status-bearing binding claims the same name (a status-bearing +
      // status-less binding on one table share the default view name; retiring here would drop the view
      // the owner provisions). Without the retire, dropping `statusField` from a binding would otherwise
      // leave the old derived surface discoverable/readable while the runtime believes it provisioned
      // nothing.
      if (!claimedByStatusful.has(viewName.toLowerCase())) {
        retireManagedTrackingView(api, db, viewName, binding.table);
      }
      continue;
    }
    // Base-column collision guard (ADR 0065): the VIEW selects `base.*` and appends the derived status as
    // `${statusColumn} AS ...`. If the base table ALREADY has a column of that name (the default
    // `derived_status`, or an override that happens to match a real column), SQLite keeps the base column
    // under that name and auto-renames the derived one — provisioning "succeeds" but a page querying
    // `statusColumn` reads the STALE stored value. Detect it and skip (loudly) rather than publish a VIEW
    // that silently defeats the derivation. `readModel.statusColumn === statusField` is already rejected at
    // manifest validation; this catches collisions with ANY other base column, which needs the live schema.
    try {
      const cols = db.all<{ name: string }>(`PRAGMA table_info("${assertSqlIdentifier("instanceTracking.table", binding.table)}")`);
      const folded = statusColumn.toLowerCase();
      if (cols.some((c) => typeof c.name === "string" && c.name.toLowerCase() === folded)) {
        api.log(
          "warn",
          `instanceTracking: derived status column "${statusColumn}" collides with an existing "${binding.table}" column; derived VIEW skipped (set readModel.statusColumn to a non-colliding name)`,
          { table: binding.table, statusColumn },
        );
        // Retire any stale VIEW managed under this name — a collision means we can't publish a CORRECT
        // derivation, and leaving an earlier boot's VIEW in place would keep serving a stale surface.
        retireManagedTrackingView(api, db, viewName, binding.table);
        continue;
      }
    } catch (err) {
      api.log("warn", "instanceTracking: failed to introspect base columns; derived VIEW skipped", {
        table: binding.table,
        error: String(err),
      });
      continue;
    }
    // A real (non-view) object of this name shares SQLite's table/view namespace: `DROP VIEW IF EXISTS`
    // won't remove it and `CREATE VIEW IF NOT EXISTS` then silently no-ops, so a page configured for this
    // view would read the wrong object with no derived column while the mount looks successful. Refuse
    // explicitly rather than pretend to provision. (Cross-binding name/table collisions are rejected at
    // manifest validation; this catches an undeclared app table that happens to share the name.)
    try {
      if (nonViewObjectExists(db, viewName)) {
        api.log(
          "warn",
          `instanceTracking: managed VIEW name "${viewName}" is taken by an existing non-view object; derived VIEW skipped (choose a distinct readModel.view)`,
          { table: binding.table, view: viewName },
        );
        continue;
      }
    } catch (err) {
      api.log("warn", "instanceTracking: failed to inspect existing objects; derived VIEW skipped", {
        table: binding.table,
        error: String(err),
      });
      continue;
    }
    // A registered read model (seam (a): `readModelRegistry`) already OWNS a VIEW of this name —
    // `mountWorkers` provisioned it before this mount. Our unconditional `DROP VIEW … ; CREATE VIEW …`
    // below would silently clobber that registered derivation (and a later worker mount could clobber
    // ours back), with neither side detecting the conflict the registry itself rejects for two registered
    // models. Refuse rather than fight over the name, mirroring the `nonViewObjectExists` guard above.
    if (readModelRegistry.get(viewName)) {
      api.log(
        "warn",
        `instanceTracking: managed VIEW name "${viewName}" collides with a registered read model; derived VIEW skipped (choose a distinct readModel.view)`,
        { table: binding.table, view: viewName },
      );
      continue;
    }
    try {
      // Qualify the DROP to `main.` for the same reason `ReadModelRegistry.ensureViews` does: an
      // unqualified DROP resolves a stray TEMP view of the same name first (e.g. leaked from a parity
      // run), leaving the managed `main` view stale.
      db.exec(`DROP VIEW IF EXISTS main."${viewName}";`);
      db.exec(model.viewDdl());
    } catch (err) {
      api.log("warn", `instanceTracking: failed to provision derived VIEW "${model.decl.name}"`, {
        error: String(err),
      });
    }
  }
}

/**
 * Mount the `instanceTracking` reconciler: provision each binding's derived read-model VIEW, construct
 * the canonical projection stores once, and arm one poll loop per binding. Each loop selects the active
 * rows, asks the engine which of their instances are terminated / parked on a human, and FEEDS that
 * engine truth into the canonical projections (never a base-row write — the status edges are DERIVED;
 * ADR 0065). `stop()` cancels every armed timer.
 */
export function mountInstanceTracking(
  ctx: RuntimeContext,
  api: AppApi,
  sched: SchedulerDeps = defaultScheduler(),
): InstanceTrackingHandle {
  const bindings = ctx.manifest.instanceTracking ?? [];
  const timers = new Set<unknown>();
  const armed: string[] = [];
  let stopped = false;

  // Ensure the canonical projection tables (`_urban_*`) exist BEFORE creating the derived VIEWs that
  // SELECT over them: a VIEW built on missing sidecar tables is created fine (SQLite does not validate a
  // view body) but then reads `no such table`, so the mount would look successful while the page fails.
  // Both are absent-safe: with no default data source `projections` is undefined and no VIEW is
  // provisioned, so each poll degrades to a pure engine query that feeds nothing (never throwing). When
  // projection setup FAILS after an earlier boot succeeded (undefined despite a default source), there is
  // nothing coherent to derive over, so instead of leaving a prior boot's VIEW readable over an
  // unavailable/stale projection we RETIRE the managed VIEWs — an honest missing surface, not a silent
  // stale one.
  const projections = tryInstanceProjections(api);
  if (projections) provisionInstanceTrackingViews(api, bindings);
  else retireInstanceTrackingViews(api, bindings);

  for (const binding of bindings) {
    // `pollMs` feeds a self-rescheduling timer, so a non-number/NaN/zero/negative value would
    // clamp to a 0-delay hot loop. `??` only guards null/undefined; sanitize to a finite positive
    // number and otherwise fall back to the default. (Manifest validation rejects bad values up
    // front; this is belt-and-suspenders for a binding mounted without validation.)
    const rawPoll = binding.pollMs;
    const pollMs = typeof rawPoll === "number" && Number.isFinite(rawPoll) && rawPoll > 0
      ? rawPoll
      : DEFAULT_INSTANCE_TRACKING_POLL_MS;
    // A single setTimeout delay overflows its 32-bit signed range (~24.8 days) and fires
    // immediately — which for a self-rescheduling poll would become a hot loop. Clamp through
    // the one shared constant the cron trigger loop uses (derive-don't-duplicate).
    const delayMs = Math.min(pollMs, MAX_TIMER_DELAY_MS);
    const label = `${binding.table}.${binding.keyField}`;
    armed.push(label);

    const arm = (): void => {
      if (stopped) return;
      let handle: unknown;
      handle = sched.setTimer(() => {
        timers.delete(handle);
        if (stopped) return;
        void (async () => {
          try {
            await reconcileOnce(api, binding, projections);
          } catch (err) {
            api.log("error", `instanceTracking "${label}": reconcile failed`, {
              error: String(err),
            });
          } finally {
            arm(); // reschedule regardless of outcome (at-least-once, idempotent)
          }
        })();
      }, delayMs);
      timers.add(handle);
    };
    arm();
  }

  return {
    name: "instanceTracking",
    bindings: armed,
    async stop(): Promise<void> {
      stopped = true;
      for (const h of timers) sched.clearTimer(h);
      timers.clear();
    },
    describe(): Record<string, unknown> {
      return { bindings: armed };
    },
  };
}
