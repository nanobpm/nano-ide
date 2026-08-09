// The Urban-native "cancel a process instance" primitive.
//
// Cancelling a running process from a page action must do two honest things that a bare
// `engine.cancelInstance` call does not:
//
//   1. Report the *real* outcome. A cancel can fail (permissions, the instance already gone,
//      a transport error). Swallowing that and reporting success leaves an instance running in
//      the engine while the UI claims it stopped — the worst possible lie for a "cancel" button.
//   2. Reconcile the tracked row immediately. Apps bind process instances to rows via
//      `instanceTracking`; the poll reconciler flips a row to its terminal status within a few
//      seconds of the instance terminating. When *we* are the one terminating it, we can apply
//      that same declared patch right away instead of waiting for the next poll tick.
//
// This primitive verifies the post-cancel state against the engine's read model and only claims
// success when the instance is genuinely no longer active. It reuses the instanceTracking
// bindings' `onTerminated.set` patch, so the immediate reconcile can never drift from the poll
// reconciler's.

import type { AppApi } from "../context.ts";
import type { InstanceTracking } from "../manifest.ts";
import { errorMessage } from "../guards.ts";
import { reconcileTerminatedKey } from "./instance-tracking.ts";

export type CancelInstanceState = "ACTIVE" | "COMPLETED" | "TERMINATED" | "gone";

export interface CancelInstanceResult {
  ok: boolean;
  processInstanceKey: string;
  /** The instance state as read back from the engine after the cancel attempt.
   *  `"gone"` means the engine has no record of the key (already cleaned up / never existed). */
  state: CancelInstanceState;
  /** Rows flipped to their terminal status by the immediate instanceTracking reconcile. */
  reconciled: number;
  error?: string;
}

type CancelApi = Pick<AppApi, "engine" | "data" | "log">;

/**
 * Cancel a process instance honestly: terminate it, verify it is actually gone, and immediately
 * reconcile any instanceTracking row bound to its key.
 *
 * Outcome rules:
 *  - `cancelInstance` returns without throwing → the engine accepted the termination (a committed
 *    204); trust it even if the read model still lags at ACTIVE.
 *  - `cancelInstance` throws but the instance reads back non-ACTIVE (already TERMINATED/COMPLETED
 *    /gone) → the cancel was effectively idempotent; treat as success.
 *  - `cancelInstance` throws and the instance is still ACTIVE → an honest failure: report it and
 *    do NOT touch any row (the instance is still running).
 *
 * Reconcile only on `TERMINATED`: a COMPLETED instance's terminal row-write is owned by the app's
 * own finalize logic, and a gone/ACTIVE instance has nothing to flip here.
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

  if (threw && state === "ACTIVE") {
    // The cancel genuinely failed and the instance is still running — never flip a row to a
    // terminal status while the engine keeps executing it.
    api.log("error", "cancel: engine termination failed, instance still active", {
      processInstanceKey: key,
      error: errorMessage(threw),
    });
    return { ok: false, processInstanceKey: key, state, reconciled: 0, error: errorMessage(threw) };
  }

  let reconciled = 0;
  if (state === "TERMINATED") {
    reconciled = await reconcileTerminatedKey(api, bindings, key);
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
