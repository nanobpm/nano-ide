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
import { defaultScheduler, type SchedulerDeps } from "./scheduler.ts";

/** Default poll interval when a binding does not set `pollMs`. */
export const DEFAULT_INSTANCE_TRACKING_POLL_MS = 15_000;

export interface InstanceTrackingHandle extends Mounted {
  /** `table.keyField` labels of the armed bindings, for `inspect()`. */
  readonly bindings: string[];
}

type Row = Record<string, unknown>;

/** The set of process instance keys currently marked active in the read model, plus the
 *  patch to apply to each row that turns out terminated. Returns `undefined` for a binding
 *  that selects no active rows this tick (nothing to poll). */
async function reconcileOnce(
  api: AppApi,
  binding: InstanceTracking,
): Promise<{ scanned: number; reconciled: number }> {
  const table = api.data.table<Row>(binding.table, binding.keyField);

  // Select the rows worth polling. With a statusField + activeStatuses, only rows in an
  // active status are candidates (a row already terminal is skipped); otherwise every row
  // is a candidate. Terminal rows are never re-touched, keeping the reconcile idempotent.
  let candidates: Row[];
  if (binding.statusField && binding.activeStatuses && binding.activeStatuses.length > 0) {
    const perStatus = await Promise.all(
      binding.activeStatuses.map((s) => table.find({ [binding.statusField as string]: s } as Partial<Row>)),
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

  const patch = binding.onTerminated.set as Partial<Row>;
  let reconciled = 0;
  for (const snap of snapshots) {
    if (snap.state !== "TERMINATED") continue; // defensive; we asked for TERMINATED only
    if (!keyToRows.has(snap.processInstanceKey)) continue; // not one we were tracking
    const changed = await table.update(snap.processInstanceKey, patch);
    if (changed > 0) {
      reconciled += changed;
      api.log("info", "instanceTracking: reconciled terminated instance", {
        table: binding.table,
        keyField: binding.keyField,
        processInstanceKey: snap.processInstanceKey,
        rowsChanged: changed,
      });
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
    const pollMs = binding.pollMs ?? DEFAULT_INSTANCE_TRACKING_POLL_MS;
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
      }, pollMs);
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
