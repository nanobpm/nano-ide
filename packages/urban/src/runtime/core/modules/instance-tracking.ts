// instance-tracking — the process-instance lifecycle reconciler (manifest `instanceTracking`).
//
// The problem it closes: an Urban app derives a row's status from the workers that run
// along a process's *happy path*. When an instance instead reaches an engine-truth state with
// no worker to record it, the read-model row lies. Two such edges are reconciled declaratively:
//
//  - The **terminal** edge (`onTerminated`): each binding's poll asks the engine which of its
//    active instances are `TERMINATED` and applies `onTerminated.set` (→ e.g. `abandoned`). A
//    terminated instance runs no completion worker, so nothing else would ever close the row.
//
//  - The **wait-on-human** edge (`onWaitingHuman`, issue #355): the symmetric primitive for
//    "this instance is parked waiting on a human." That state is authoritatively knowable — an
//    instance is waiting on a human *iff* it has an open user task (`openUserTasks` =
//    `searchUserTasks({state:"CREATED"})`) — for every process, forever, with no per-element
//    registry. On each poll, an active, non-terminated row whose instance has any open user task
//    has `onWaitingHuman.set` applied (typically `status = "awaiting_operator"`). This retires the
//    per-subject imperative pattern (workers writing the status on escalate/answer plus a bespoke
//    self-heal poller): the parked status becomes a derived view over the one user-task
//    projection, so there is no second surface to drift (No Drift Surfaces).
//
// Precedence per active row, all derived from engine truth (never a worker write):
//   terminated              -> onTerminated.set   (e.g. abandoned)      // terminal edge
//   else has open user task  -> onWaitingHuman.set  (e.g. awaiting_operator)  // wait-on-human edge
//   else                     -> leave the worker-owned transient status (running / converging / …)
//
// It deliberately reconciles the terminal edge only on `TERMINATED` — the state that by
// definition runs no completion worker — and never on `COMPLETED`, whose terminal row-write the
// app's own finalize worker owns (reconciling it here would race that worker and could clobber a
// legitimately-completed row). The wait-on-human edge reads *open* user tasks via `openUserTasks`
// (never a bare `searchUserTasks`, which lags a completion and would latch `awaiting_operator`
// onto a just-answered task). The poll is driven through the shared `SchedulerDeps` seam so tests
// are deterministic.

import type { AppApi, Mounted, RuntimeContext } from "../context.ts";
import { type InstanceTracking, isConfiguredStatusSelector } from "../manifest.ts";
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

/** Apply a binding's `onTerminated.set` patch to the single row keyed by `processInstanceKey`.
 *  Only the binding whose table owns that key has a matching row, so callers can fan this over
 *  every binding and let the no-match ones be no-ops. Returns rows changed. The single place that
 *  writes the terminal patch (and logs the reconcile): both the poll reconciler below (`reconcileOnce`,
 *  once per TERMINATED key it discovers) and the cancel primitive (immediately when it terminates an
 *  instance) route through here, so the two can never drift on the patch or the log. */
export async function reconcileTerminatedKey(
  api: Pick<AppApi, "data" | "log">,
  bindings: InstanceTracking[],
  processInstanceKey: string,
): Promise<number> {
  const key = String(processInstanceKey);
  let reconciled = 0;
  for (const binding of bindings) {
    const table = api.data.table<Row>(binding.table, binding.keyField);
    const changed = await table.update(key, binding.onTerminated.set);
    if (changed > 0) {
      reconciled += changed;
      api.log("info", "instanceTracking: reconciled terminated instance", {
        table: binding.table,
        keyField: binding.keyField,
        processInstanceKey: key,
        rowsChanged: changed,
      });
    }
  }
  return reconciled;
}

/** Whether `row` already satisfies `patch` on every column it sets — used to make the
 *  wait-on-human writer quiet-idempotent. Unlike a terminated row (which flips to a terminal
 *  status and then drops out of the active set), a row parked at a user task stays active and is
 *  re-polled every tick, so re-writing/re-logging the same `awaiting_operator` patch on every poll
 *  would be noise; skip the write when it would be a no-op. */
function patchAlreadyApplied(row: Row, set: Record<string, string | number | boolean | null>): boolean {
  return Object.entries(set).every(([col, value]) => row[col] === value);
}

/** Apply a binding's `onWaitingHuman.set` patch to the single row keyed by `processInstanceKey`
 *  — the wait-on-human twin of {@link reconcileTerminatedKey} (issue #355). The caller establishes
 *  the precondition (the instance is non-terminated and has an open user task); this is the single
 *  place that writes `onWaitingHuman.set` and logs the reconcile. Bindings without an
 *  `onWaitingHuman` edge are no-ops, so callers can fan this over every binding. It skips the write
 *  when the row already carries the patch (quiet-idempotent — a long-parked instance is re-polled
 *  every tick and must not re-log). Returns rows changed. */
export async function reconcileWaitingHumanKey(
  api: Pick<AppApi, "data" | "log">,
  bindings: InstanceTracking[],
  processInstanceKey: string,
): Promise<number> {
  const key = String(processInstanceKey);
  let reconciled = 0;
  for (const binding of bindings) {
    const onWaitingHuman = binding.onWaitingHuman;
    if (!onWaitingHuman) continue;
    const table = api.data.table<Row>(binding.table, binding.keyField);
    // Quiet-idempotence must consider EVERY row sharing this key, not just one. `keyField` need not
    // be a unique column (e.g. a read model keyed on a non-PK `process_key`), and `table.update`
    // patches ALL matching rows — so a `get()` (LIMIT 1) that happens to hit one already-patched row
    // would skip the write and leave the OTHER matching rows unreconciled. Skip only when every
    // matching row already carries the patch; otherwise fall through and re-patch them all.
    const current = await table.find({ [binding.keyField]: key });
    if (current.length > 0 && current.every((row) => patchAlreadyApplied(row, onWaitingHuman.set))) {
      continue;
    }
    const changed = await table.update(key, onWaitingHuman.set);
    if (changed > 0) {
      reconciled += changed;
      api.log("info", "instanceTracking: reconciled instance awaiting operator", {
        table: binding.table,
        keyField: binding.keyField,
        processInstanceKey: key,
        rowsChanged: changed,
      });
    }
  }
  return reconciled;
}

/** Poll one binding's instances once. Selects the active rows, asks the engine which of their
 *  instances are TERMINATED, and applies `onTerminated.set` to each; then, for the binding's
 *  wait-on-human edge (`onWaitingHuman`, issue #355), applies `onWaitingHuman.set` to every
 *  non-terminated active row whose instance has an open user task. Returns how many keys were
 *  scanned and how many rows were reconciled this tick. */
async function reconcileOnce(
  api: AppApi,
  binding: InstanceTracking,
): Promise<{ scanned: number; reconciled: number }> {
  const table = api.data.table<Row>(binding.table, binding.keyField);

  // Select the rows worth polling. Three modes, in precedence order:
  //  - `terminalStatuses` (fail-open exclusion): poll every row whose `statusField` is NOT
  //    a terminal value. A newly-added non-terminal status is polled by default, so it can't
  //    silently fall out of reconciliation; only already-terminal rows are excluded (bounded).
  //  - `activeStatuses` (fail-closed allow-list): poll only rows in an enumerated active status.
  //  - neither: poll every row; a terminal instance's row is idempotently re-patched (the engine
  //    query returns only TERMINATED instances and the patch is a no-op once applied).
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
    candidates = all.filter((row) => !terminal.has(String(row[statusField])));
  } else if (statusField && isConfiguredStatusSelector(binding.activeStatuses)) {
    const perStatus = await Promise.all(
      binding.activeStatuses.map((s): Promise<Row[]> => table.find({ [statusField]: s })),
    );
    candidates = perStatus.flat();
  } else {
    candidates = await table.all();
  }

  // Map each active row to its tracked instance key. A row with no/empty key can't be
  // reconciled (it never started an instance, or the column is unset) — skip it.
  const keyToRows = new Map<string, Row[]>();
  for (const row of candidates) {
    const raw = row[binding.keyField];
    if (raw == null || raw === "") continue;
    const key = String(raw);
    const list = keyToRows.get(key);
    if (list) list.push(row);
    else keyToRows.set(key, [row]);
  }
  const keys = [...keyToRows.keys()];
  if (keys.length === 0) return { scanned: 0, reconciled: 0 };

  const snapshots = await api.engine.searchProcessInstances({
    processInstanceKeys: keys,
    state: "TERMINATED",
  });

  // Apply the terminal patch through the shared `reconcileTerminatedKey` — the one place that
  // writes `onTerminated.set` and logs the reconcile — so the poll path and the cancel primitive
  // can never drift on the patch or its logging (No Drift Surfaces).
  let reconciled = 0;
  const terminatedKeys = new Set<string>();
  for (const snap of snapshots) {
    if (snap.state !== "TERMINATED") continue; // defensive; we asked for TERMINATED only
    if (!keyToRows.has(snap.processInstanceKey)) continue; // not one we were tracking
    terminatedKeys.add(snap.processInstanceKey);
    reconciled += await reconcileTerminatedKey(api, [binding], snap.processInstanceKey);
  }

  // Wait-on-human edge (issue #355), symmetric to onTerminated. Precedence: terminated wins, so a
  // key reconciled as terminated above is excluded here. An instance is "waiting on a human" iff
  // it has an open user task — the authoritative engine truth — so read `openUserTasks` (never a
  // bare `searchUserTasks`, which lags a completion and would latch `awaiting_operator` onto a
  // just-answered task; issue #355 "instance B"). When there is no open user task the row is left
  // untouched, so a worker-owned transient status (running / converging / merging) survives and a
  // stale `awaiting_operator` is not re-latched. Because the condition is derived every tick, a
  // re-escalation after an answer re-flips to `awaiting_operator` on the next poll by construction
  // (issue #355 "instance A"). Probe in bounded-parallel batches (`WAITING_HUMAN_PROBE_CONCURRENCY`)
  // so a pass over a large active backlog scales with max latency rather than N×latency.
  if (binding.onWaitingHuman) {
    const humanKeys = keys.filter((key) => !terminatedKeys.has(key)); // terminated already won
    for (let i = 0; i < humanKeys.length; i += WAITING_HUMAN_PROBE_CONCURRENCY) {
      const batch = humanKeys.slice(i, i + WAITING_HUMAN_PROBE_CONCURRENCY);
      const perKey = await Promise.all(
        batch.map(async (key): Promise<number> => {
          const openTasks = await api.engine.openUserTasks({ processInstanceKey: key });
          if (openTasks.length === 0) return 0; // not parked on a human ⇒ leave the transient status
          return reconcileWaitingHumanKey(api, [binding], key);
        }),
      );
      for (const n of perKey) reconciled += n;
    }
  }
  return { scanned: keys.length, reconciled };
}

/**
 * Mount the `instanceTracking` reconciler: arm one poll loop per binding. Each loop selects
 * the active rows, asks the engine which of their instances are terminated, and applies the
 * declared patch. `stop()` cancels every armed timer.
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
            await reconcileOnce(api, binding);
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
