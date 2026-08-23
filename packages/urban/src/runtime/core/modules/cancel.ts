// The Urban-native "cancel a process instance" primitive.
//
// Cancelling a running process from a page action must do two honest things that a bare
// `engine.cancelInstance` call does not:
//
//   1. Report the *real* outcome. A cancel can fail (permissions, the instance already gone,
//      a transport error). Swallowing that and reporting success leaves an instance running in
//      the engine while the UI claims it stopped — the worst possible lie for a "cancel" button.
//   2. Reconcile the tracked instance immediately. Apps bind process instances to rows via
//      `instanceTracking`; since ADR 0065 the reconciler is a SOURCE, not a writer — its poll feeds
//      engine truth into the canonical `urban_instance_state` projection and the terminal status edge
//      is DERIVED from it (no stored column to tear; nano-workforce#422). When *we* are the one
//      terminating the instance, we can record that same terminal source right away instead of waiting
//      for the next poll tick, and the derived read model reflects it on the next read.
//
// This primitive keys success on the engine's response, then reconciles off the read model: a
// non-throwing `cancelInstance` is a committed termination (trusted even if the read model still
// lags at ACTIVE), while a throw that does not read back a positively-terminal state (still ACTIVE,
// or absent from the read model) is an honest failure. It records the terminal source through the
// SAME `reconcileTerminatedKey` the poll reconciler uses, so cancel and poll can never drift.

import type { AppApi } from "../context.ts";
import type { InstanceTracking } from "../manifest.ts";
import { errorMessage } from "../guards.ts";
import { reconcileTerminatedKey, tryInstanceProjections } from "./instance-tracking.ts";

export type CancelInstanceState = "ACTIVE" | "COMPLETED" | "TERMINATED" | "gone";

export interface CancelInstanceResult {
  ok: boolean;
  processInstanceKey: string;
  /** The instance state as read back from the engine after the cancel attempt.
   *  `"gone"` means the engine has no record of the key (already cleaned up / never existed). */
  state: CancelInstanceState;
  /** 1 when the immediate reconcile recorded the terminal source into the canonical instance-state
   *  projection (so the derived terminal status edge reflects it at once), else 0. */
  reconciled: number;
  error?: string;
}

type CancelApi = Pick<AppApi, "engine" | "data" | "log">;

/**
 * Cancel a process instance honestly: terminate it, verify it is actually gone, and immediately
 * record the terminal source for its key into the canonical instance-state projection.
 *
 * Outcome rules:
 *  - `cancelInstance` returns without throwing → the engine accepted the termination (a committed
 *    204); trust it even if the read model still lags at ACTIVE or has already cleaned the instance
 *    up ("gone"), and record the terminal source for the key so the derived view flips at once.
 *  - `cancelInstance` throws but the instance reads back positively terminal (TERMINATED/COMPLETED)
 *    → the cancel was effectively idempotent; treat as success. A TERMINATED read records a terminal
 *    source here; a COMPLETED read intentionally records nothing.
 *  - `cancelInstance` throws and the read is NOT positively terminal — still ACTIVE, or "gone"
 *    (absent from the read model, which after an engine restart can transiently lack a live
 *    instance) → an honest failure: report it and do NOT record anything (the instance may still be
 *    running). A throw is not a committed cancel, and absence from the read model is not proof of
 *    termination, so success is never inferred from it.
 *
 * Record when the cancellation is CONFIRMED — an accepted (non-throwing) cancel of any non-COMPLETED
 * readback (ACTIVE lag / gone / TERMINATED), or a throw that reads back TERMINATED. A COMPLETED
 * instance's terminal outcome is owned by the app's own finalize logic, so it records nothing. When
 * the app declares no `instanceTracking` bindings there is nothing to reconcile, so the feed is
 * skipped.
 */
export async function cancelInstanceReconciling(
  api: CancelApi,
  bindings: InstanceTracking[],
  processInstanceKey: string,
): Promise<CancelInstanceResult> {
  const key = String(processInstanceKey);

  let threw: unknown;
  try {
    await api.engine.cancelInstance({ processInstanceKey: key });
  } catch (error) {
    threw = error;
  }

  const state = await readState(api, key, threw);

  if (threw && state !== "TERMINATED" && state !== "COMPLETED") {
    // The cancel threw, so we never got a committed 204 — and the verify read did NOT positively
    // confirm a terminal state. Two shapes land here, both honest failures:
    //   • state === "ACTIVE": the instance is demonstrably still running.
    //   • state === "gone":   the read model has no record of the key. A throw makes this
    //     ambiguous — after an engine restart the query store can transiently lack a live instance
    //     before it rehydrates, so "gone" is absence-of-evidence, NOT proof of termination.
    // Trust neither as success: claiming a cancel that may not have happened (while the run keeps
    // executing) is the worst possible lie for a cancel button. Report ok:false so the caller
    // surfaces it and retries; never record a terminal source while the instance may live.
    api.log("error", "cancel: engine termination not confirmed, instance may still be active", {
      processInstanceKey: key,
      state,
      error: errorMessage(threw),
    });
    return { ok: false, processInstanceKey: key, state, reconciled: 0, error: errorMessage(threw) };
  }

  let reconciled = 0;
  // Record the terminal source whenever the cancellation is CONFIRMED — not only on a positively
  // TERMINATED readback. An accepted (non-throwing) `cancelInstance` is a committed 204: the instance
  // WILL terminate, even if the read model still lags at ACTIVE or the engine has already cleaned the
  // instance up ("gone"). A throw that nonetheless reads back TERMINATED is idempotently confirmed too.
  // Excluded: COMPLETED (its terminal outcome is owned by the app's own finalize logic) and the honest-
  // failure case (a throw with a non-terminal read), which already returned ok:false above. Without
  // recording on the accepted-but-lagging read, a committed cancel returned ok:true / reconciled:0 and
  // the derived view stayed on the stored worker status until a poll caught up — and NEVER, if the
  // engine no longer exposes the instance for the poll to observe (issue: accepted-cancel/read-lag).
  const cancelConfirmed = !threw || state === "TERMINATED";
  if (cancelConfirmed && state !== "COMPLETED" && bindings.length > 0) {
    // Record through the SAME `reconcileTerminatedKey` the poll path uses, over the app's own
    // projection stores, so cancel and poll can never drift. It is internally absent-safe and never
    // throws through — a projection-write failure logs a warn and returns 0 rather than turning a
    // successful engine termination into a 500; the poll reconciler catches the projection up on its
    // next tick. The extra try/catch is belt-and-suspenders against a store construction fault.
    try {
      const projections = tryInstanceProjections(api);
      reconciled = reconcileTerminatedKey(api, projections, key);
    } catch (error) {
      api.log("error", "cancel: instance terminated but projection reconcile failed", {
        processInstanceKey: key,
        error: errorMessage(error),
      });
      return { ok: true, processInstanceKey: key, state, reconciled: 0, error: errorMessage(error) };
    }
  }

  return { ok: true, processInstanceKey: key, state, reconciled };
}

/** Read the instance state back from the engine to verify what actually happened. When the read
 *  itself fails we fall back to the cancel call's own result: a thrown cancel with an unverifiable
 *  state is reported as still-ACTIVE (honest worst case); an accepted cancel is trusted as gone. */
async function readState(
  api: CancelApi,
  key: string,
  threw: unknown,
): Promise<CancelInstanceState> {
  try {
    const [snapshot] = await api.engine.searchProcessInstances({ processInstanceKeys: [key] });
    if (snapshot) return snapshot.state;
    return "gone";
  } catch (error) {
    api.log("warn", "cancel: could not verify post-cancel state", {
      processInstanceKey: key,
      error: errorMessage(error),
    });
    return threw ? "ACTIVE" : "gone";
  }
}
