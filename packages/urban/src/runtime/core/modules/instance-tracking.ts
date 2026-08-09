// instance-tracking — the process-instance lifecycle reconciler (manifest `instanceTracking`).
//
// The problem it closes: an Urban app derives a row's status from the workers that run
// along a process's *happy path*. When an instance instead reaches a terminal state with
// no completion job — an operator/`cancelInstance` termination, or a crash — no worker
// runs, so the read-model row stays "active" forever and any UI derived from it lies.
//
// Each `instanceTracking` binding names a datasource table whose rows track an instance by
// a key column. This module polls the engine for those rows' instances and, when one is
// `TERMINATED`, applies the binding's `onTerminated.set` patch to the row. It deliberately
// reconciles only on `TERMINATED` — the state that by definition runs no completion worker
// — and never on `COMPLETED`, whose terminal row-write the app's own finalize worker owns
// (reconciling it here would race that worker and could clobber a legitimately-completed
// row). The poll is driven through the shared `SchedulerDeps` seam so tests are deterministic.

import type { AppApi, Mounted, RuntimeContext } from "../context.ts";
import type { InstanceTracking } from "../manifest.ts";
import { defaultScheduler, MAX_TIMER_DELAY_MS, type SchedulerDeps } from "./scheduler.ts";

/** Default poll interval when a binding does not set `pollMs`. */
export const DEFAULT_INSTANCE_TRACKING_POLL_MS = 15_000;

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

/** Poll one binding's instances once. Selects the active rows, asks the engine which of their
 *  instances are TERMINATED, and applies `onTerminated.set` to each. Returns how many keys were
 *  scanned and how many rows were reconciled this tick. */
async function reconcileOnce(
  api: AppApi,
  binding: InstanceTracking,
): Promise<{ scanned: number; reconciled: number }> {
  const table = api.data.table<Row>(binding.table, binding.keyField);

  // Select the rows worth polling. With a statusField + activeStatuses, only rows in an
  // active status are candidates, so a row already in a terminal status is skipped; without
  // them every row is polled and a terminal instance's row is idempotently re-patched (the
  // engine query returns only TERMINATED instances and the patch is a no-op once applied).
  let candidates: Row[];
  const statusField = binding.statusField;
  if (statusField && binding.activeStatuses && binding.activeStatuses.length > 0) {
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
  for (const snap of snapshots) {
    if (snap.state !== "TERMINATED") continue; // defensive; we asked for TERMINATED only
    if (!keyToRows.has(snap.processInstanceKey)) continue; // not one we were tracking
    reconciled += await reconcileTerminatedKey(api, [binding], snap.processInstanceKey);
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
