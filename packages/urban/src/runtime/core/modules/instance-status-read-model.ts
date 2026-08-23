// instance-status-read-model — the DERIVED half of the `instanceTracking` writer→source inversion
// (ADR 0065, surface #1; #439-L1 / #318). The reconciler used to WRITE the derivable status edges
// (`onTerminated.set` / `onWaitingHuman.set` applied as `table.update` patches); that stored-derived
// value tore from its inputs (nano-workforce#422: an answered escalation still showed a stale ⚠).
//
// After the inversion, the reconciler is a SOURCE — it feeds engine truth into the canonical
// projections (`urban_instance_state`, `urban_open_user_tasks`, ADR 0065 #1) — and the two derivable
// status edges are DERIVED here, once, in the closed `defineReadModel` expression DSL:
//
//   terminal edge:      EXISTS(urban_instance_state    WHERE process_instance_key = base.<keyField>
//                                                        AND state = 'TERMINATED')  -> onTerminated value
//   wait-on-human edge: EXISTS(urban_open_user_tasks   WHERE process_instance_key = base.<keyField>)
//                                                                                   -> onWaitingHuman value
//
// authored ONCE and compiled to BOTH the SQLite VIEW and the in-process TS function (surface #2 is
// closed by the two-backend compiler). Because a derived edge is recomputed on every read over the
// LIVE projections, a re-escalation after an answer re-flips by construction and #422 cannot recur:
// once `OpenUserTasksStore.syncInstance` retires the answered task, the `EXISTS` goes false on the
// next read — no stored column to leave stale.

import type { InstanceTracking } from "../manifest.ts";
import {
  and,
  caseWhen,
  col,
  defineReadModel,
  eq,
  type Expr,
  exists,
  lit,
  not,
  pcol,
  type ReadModel,
  type WhenClause,
  when,
} from "../read-model.ts";
import { INSTANCE_STATE_PROJECTION } from "./instance-state-store.ts";
import { OPEN_USER_TASKS_PROJECTION } from "./open-user-tasks-store.ts";

/** The engine-truth terminal lifecycle state the terminal edge keys on (mirrors
 *  `ProcessInstanceState`'s `TERMINATED`). Reconciled only on `TERMINATED` — never `COMPLETED`, whose
 *  terminal row-write the app's own finalize worker owns — exactly as the pre-inversion reconciler was. */
export const TERMINATED_STATE = "TERMINATED";

/** The default derived-status column name a binding's read-model VIEW exposes. Distinct from the base
 *  `statusField` on purpose: the managed VIEW re-exports `base.*` (so pages keep every base column),
 *  and SQLite lets the base column win over a same-named derived alias — so the EFFECTIVE (derived)
 *  status is surfaced under its own column, which the operator page reads instead of the stored one.
 *  A binding may override it via `readModel.statusColumn`. */
export const DEFAULT_DERIVED_STATUS_COLUMN = "derived_status";

/** The default managed-VIEW name for a binding: `<table>__tracking`. Distinct from the base table
 *  (SQLite forbids a VIEW and a table sharing a name). An app with more than one binding on the same
 *  base table must give each a distinct `readModel.view`. */
export function defaultInstanceTrackingViewName(table: string): string {
  return `${table}__tracking`;
}

/** `EXISTS(urban_instance_state WHERE process_instance_key = base.<keyField> AND state = 'TERMINATED')`
 *  — the terminal edge, derived over the canonical instance-state projection. Authored once; compiles
 *  to both the SQLite VIEW `EXISTS` and the TS `projections["urban_instance_state"].some(...)`. */
export function terminatedEdgeExpr(keyField: string): Expr {
  return exists(
    INSTANCE_STATE_PROJECTION,
    and(eq(pcol("process_instance_key"), col(keyField)), eq(pcol("state"), lit(TERMINATED_STATE))),
  );
}

/** `EXISTS(urban_open_user_tasks WHERE process_instance_key = base.<keyField>)` — the wait-on-human
 *  edge, derived over the canonical open-user-tasks projection (an instance is parked on a human iff it
 *  has an open user task). Authored once; compiles to both backends. */
export function waitingHumanEdgeExpr(keyField: string): Expr {
  return exists(OPEN_USER_TASKS_PROJECTION, eq(pcol("process_instance_key"), col(keyField)));
}

/**
 * The effective-status derivation for one binding, in the closed expression DSL:
 *
 *   CASE
 *     WHEN <terminated>                    THEN <onTerminated.set[statusField]>   -- terminal wins
 *     WHEN <waiting-on-human> AND NOT <terminated> THEN <onWaitingHuman.set[statusField]>
 *     ELSE base.<statusField>              -- the worker-owned / business-outcome transient status
 *   END
 *
 * Precedence (terminated over waiting-human) is preserved: the terminal `WHEN` is emitted first, and
 * the waiting `WHEN` is additionally guarded by `NOT <terminated>` so it is correct even when the two
 * patches touch disjoint columns. When a binding's patch does not set the `statusField` (it reconciles
 * only secondary columns), that edge contributes no `WHEN` and the derived status passes the stored
 * value through — a derived read model never re-introduces a stored derivable write.
 */
export function deriveInstanceStatusExpr(binding: InstanceTracking, statusField: string): Expr {
  const terminated = terminatedEdgeExpr(binding.keyField);
  const whens: WhenClause[] = [];

  const terminalStatus = patchValueForColumn(binding.onTerminated?.set, statusField);
  if (terminalStatus !== undefined) {
    whens.push(when(terminated, lit(terminalStatus)));
  }

  const waitingStatus = patchValueForColumn(binding.onWaitingHuman?.set, statusField);
  if (waitingStatus !== undefined) {
    whens.push(when(and(waitingHumanEdgeExpr(binding.keyField), not(terminated)), lit(waitingStatus)));
  }

  // No edge touches the status column ⇒ the derived status is exactly the stored transient (no CASE).
  return whens.length > 0 ? caseWhen(whens, col(statusField)) : col(statusField);
}

/** Read the patch value a `*.set` map assigns to the status COLUMN, matching the key case-insensitively.
 *  SQL column identifiers fold case (SQLite), but a JS `set[statusField]` lookup is case-sensitive, so a
 *  binding with `statusField: "Status"` and `onTerminated.set: { status: "abandoned" }` would emit no
 *  terminal `WHEN` and silently fall through to the base column. Fold the comparison so the derivation
 *  matches the column the equivalent SQL UPDATE would have addressed. */
function patchValueForColumn(set: unknown, statusField: string): string | number | boolean | null | undefined {
  if (set === null || typeof set !== "object") return undefined;
  const folded = statusField.toLowerCase();
  for (const [k, v] of Object.entries(set)) {
    if (k.toLowerCase() !== folded) continue;
    if (v === undefined) return undefined;
    if (v === null || typeof v === "string" || typeof v === "number" || typeof v === "boolean") return v;
    return undefined;
  }
  return undefined;
}

/** The managed-VIEW name + derived-status column a binding's read model uses (config overrides applied). */
export function instanceTrackingReadModelTarget(binding: InstanceTracking): {
  readonly view: string;
  readonly statusColumn: string;
} {
  return {
    view: binding.readModel?.view ?? defaultInstanceTrackingViewName(binding.table),
    statusColumn: binding.readModel?.statusColumn ?? DEFAULT_DERIVED_STATUS_COLUMN,
  };
}

/**
 * Build the derived read model for one `instanceTracking` binding: a managed VIEW over the binding's
 * base table that re-exports `base.*` plus one derived `statusColumn` computed by
 * {@link deriveInstanceStatusExpr} over the canonical projections. Returns `undefined` when the binding
 * declares no `statusField` (there is no single status column to derive — the projections still get fed,
 * but nothing well-defined can be projected as "the effective status").
 *
 * The two backends (SQLite VIEW select-list + in-process TS function) fall out of the one AST, so they
 * cannot drift; `assertReadModelParity` verifies it in tests.
 */
export function defineInstanceTrackingReadModel(binding: InstanceTracking): ReadModel | undefined {
  const statusField = binding.statusField;
  if (typeof statusField !== "string" || statusField.length === 0) return undefined;
  const { view, statusColumn } = instanceTrackingReadModelTarget(binding);
  return defineReadModel({
    name: view,
    baseTable: binding.table,
    derive: { [statusColumn]: deriveInstanceStatusExpr(binding, statusField) },
  });
}
