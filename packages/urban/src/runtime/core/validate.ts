// Manifest validation. We deliberately avoid a heavyweight JSON-Schema engine here to keep
// core lean and runtime-agnostic. Instead we drive validation *from* the canonical
// nano-app.schema.json (the ADR 0027 source of truth, imported from the
// @nanobpm/nano-app-schema package) for the top-level envelope — required keys, allowed keys
// (additionalProperties:false), the schemaVersion const, and the id slug pattern — and then
// layer the runtime's binding rules (a worker needs a handler, a data source needs
// driver+url, a typed table needs fields, a trigger needs id+type). Importing the shared
// schema JSON means the envelope check tracks the published schema and can't drift from it
// silently — the whole point of consuming the package rather than vendoring a copy.

import schema from "@nanobpm/nano-app-schema/schema" with { type: "json" };
import { isRecord } from "./guards.ts";
import { BIND_MODES, NETWORK_KEYS, isBindMode, isConfiguredStatusSelector } from "./manifest.ts";
import type { AppManifest } from "./manifest.ts";
import {
  DEFAULT_DERIVED_STATUS_COLUMN,
  defaultInstanceTrackingViewName,
} from "./modules/instance-status-read-model.ts";
import { SQL_IDENT, isReservedObjectName } from "./read-model.ts";

export interface ValidationIssue {
  path: string;
  message: string;
}

export class ManifestValidationError extends Error {
  readonly issues: ValidationIssue[];
  constructor(issues: ValidationIssue[]) {
    super(
      `Invalid Urban manifest (${issues.length} issue${issues.length === 1 ? "" : "s"}):\n` +
        issues.map((i) => `  • ${i.path}: ${i.message}`).join("\n"),
    );
    this.name = "ManifestValidationError";
    this.issues = issues;
  }
}

interface JsonSchema {
  required?: string[];
  properties?: Record<string, unknown>;
  additionalProperties?: boolean;
  $defs?: { slug?: { pattern?: string } };
}

const S: JsonSchema = schema;

/** Validate a parsed manifest. Returns the list of issues (empty === valid). */
export function collectManifestIssues(m: unknown): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (!isRecord(m)) {
    return [{ path: "$", message: "manifest must be a JSON object" }];
  }
  const obj = m;

  // — Envelope, driven by the schema —
  for (const req of S.required ?? []) {
    if (!(req in obj)) issues.push({ path: req, message: "required by nano-app.schema.json" });
  }
  const allowed = new Set(Object.keys(S.properties ?? {}));
  // `network` (issue #235) is threaded as a runtime-side setting until
  // @nanobpm/nano-app-schema ships the field in its JSON Schema; allow it here so the
  // envelope check doesn't reject it. Remove this once the schema owns `network` (it
  // then flows from `S.properties` like every other block). The matching local type
  // (NetworkConfig) lives in manifest.ts — mirrored like the `api` binding (ADR 0058),
  // never via a `declare module` augmentation (CI bans augmenting the schema type).
  allowed.add("network");
  if (S.additionalProperties === false) {
    for (const k of Object.keys(obj)) {
      if (!allowed.has(k)) {
        issues.push({ path: k, message: "unknown top-level key (additionalProperties: false)" });
      }
    }
  }
  if ("network" in obj) {
    const network = isRecord(obj.network) ? obj.network : undefined;
    if (!network) {
      issues.push({ path: "network", message: "must be an object" });
    } else {
      if ("bind" in network && !isBindMode(network.bind)) {
        issues.push({
          path: "network.bind",
          message: `must be one of: ${BIND_MODES.map((mode) => `"${mode}"`).join(", ")}`,
        });
      }
      // `network` is mirrored runtime-side until the schema owns it, so this is its only
      // validation surface: mirror the schema's `additionalProperties: false` intent and
      // reject unknown keys so typos (e.g. `binn`) fail loudly instead of silently no-op'ing.
      for (const k of Object.keys(network)) {
        if (!NETWORK_KEYS.some((known) => known === k)) {
          issues.push({ path: `network.${k}`, message: "unknown key (network additionalProperties: false)" });
        }
      }
    }
  }
  if ("schemaVersion" in obj && obj.schemaVersion !== 1) {
    issues.push({ path: "schemaVersion", message: "must be 1" });
  }
  const slugPattern = S.$defs?.slug?.pattern;
  if (slugPattern && typeof obj.id === "string" && !new RegExp(slugPattern).test(obj.id)) {
    issues.push({ path: "id", message: `must match slug pattern ${slugPattern}` });
  }
  if ("name" in obj && (typeof obj.name !== "string" || obj.name.length === 0)) {
    issues.push({ path: "name", message: "must be a non-empty string" });
  }

  // — Runtime binding rules —
  const workers = Array.isArray(obj.workers) ? obj.workers : undefined;
  if (workers) {
    workers.forEach((w, i) => {
      const worker = isRecord(w) ? w : undefined;
      if (typeof worker?.taskType !== "string" || worker.taskType.length === 0) {
        issues.push({ path: `workers[${i}]`, message: "missing taskType" });
      }
      // A worker is backed by exactly one of: a `handler` file, an `llm` binding,
      // or an installed `connector` pack (ADR 0050). The schema models these as a
      // oneOf; enforce the "exactly one" here without forcing `handler`. Whether a
      // `connector` actually resolves to an installed pack is a runtime seam check
      // (mountConnectors), not something this static manifest check can see.
      const backings: string[] = [];
      if (typeof worker?.handler === "string" && worker.handler.length > 0) backings.push("handler");
      if (typeof worker?.llm === "string" && worker.llm.length > 0) backings.push("llm");
      if (typeof worker?.connector === "string" && worker.connector.length > 0) backings.push("connector");
      if (backings.length === 0) {
        issues.push({
          path: `workers[${i}]`,
          message: "worker requires a `handler`, `llm`, or `connector`",
        });
      } else if (backings.length > 1) {
        issues.push({
          path: `workers[${i}]`,
          message: `worker declares ${backings.join(" + ")} (mutually exclusive)`,
        });
      }
      // A `connection` must reference a declared top-level `connections` entry.
      if (typeof worker?.connection === "string" && worker.connection.length > 0) {
        const conns =
          isRecord(obj.connections)
            ? obj.connections
            : undefined;
        if (!conns || !(worker.connection in conns)) {
          issues.push({
            path: `workers[${i}].connection`,
            message: `no such connection "${worker.connection}" (add it to connections)`,
          });
        }
      }
    });
  }

  const data = isRecord(obj.data) ? obj.data : undefined;
  const sources = isRecord(data?.sources) ? data.sources : undefined;
  if (sources) {
    for (const [name, src] of Object.entries(sources)) {
      const source = isRecord(src) ? src : undefined;
      if (!source || typeof source.driver !== "string") {
        issues.push({ path: `data.sources.${name}.driver`, message: "missing driver" });
      }
      if (!source || typeof source.url !== "string") {
        issues.push({ path: `data.sources.${name}.url`, message: "missing url" });
      }
    }
    if (typeof data?.default === "string" && !sources[data.default]) {
      issues.push({ path: "data.default", message: `no such source "${data.default}"` });
    }
  }

  const types = isRecord(obj.types) ? obj.types : undefined;
  if (types) {
    for (const [name, t] of Object.entries(types)) {
      // `table` is optional in the schema: a type may declare `fields` without a
      // `table` (a transient / non-persisted domain type). Don't require it.
      if (t && typeof t !== "object") {
        issues.push({ path: `types.${name}`, message: "must be an object" });
      }
    }
  }

  const triggers = Array.isArray(obj.triggers) ? obj.triggers : undefined;
  if (triggers) {
    triggers.forEach((t, i) => {
      const trigger = isRecord(t) ? t : undefined;
      if (!trigger?.id) issues.push({ path: `triggers[${i}].id`, message: "missing id" });
      if (!trigger?.type) issues.push({ path: `triggers[${i}].type`, message: "missing type" });
    });
  }

  // instanceTracking: each binding must name the table + key column it tracks and a
  // non-empty `onTerminated.set` patch — a reconciler with nothing to write is inert
  // and almost certainly a mistake. `activeStatuses` without `statusField` is incoherent
  // (no column to read the statuses from), so the runtime would silently poll every row.
  const tracking = Array.isArray(obj.instanceTracking) ? obj.instanceTracking : undefined;
  if (tracking) {
    tracking.forEach((t, i) => {
      const b = isRecord(t) ? t : undefined;
      // Only a status-bearing binding builds a derived VIEW; a status-less binding just feeds projections
      // and is polled through `api.data.table()`, whose `Table<T>` gateway safely `quoteIdent`s the base
      // table and key column (so a name like `external-orders` works). The SQL_IDENT restriction below is
      // therefore required ONLY when a VIEW is actually built (`table`/`keyField` are interpolated raw into
      // its DDL/edge predicates then) — enforcing it on a status-less binding wrongly rejects a valid name
      // that provisioning never touches. Gate on `buildsView` so validation and provisioning agree exactly
      // (No Drift — a name is rejected here iff it would break at VIEW build).
      const buildsView = typeof b?.statusField === "string" && b.statusField.length > 0;
      if (typeof b?.table !== "string" || b.table.length === 0) {
        issues.push({ path: `instanceTracking[${i}].table`, message: "missing table" });
      } else if (buildsView && !SQL_IDENT.test(b.table)) {
        // The base `table` is compiled directly into the derived VIEW's DDL (`defineReadModel` asserts
        // `baseTable` matches SQL_IDENT). Manifest validation historically only checked non-empty, so a
        // name like `external-orders` validated and was polled while the VIEW was silently skipped at
        // mount (read-model construction throws). Enforce the identifier rule at author time so validation
        // and provisioning agree (No Drift — a name accepted here is accepted at VIEW build).
        issues.push({
          path: `instanceTracking[${i}].table`,
          message: `table must be a SQL identifier (${SQL_IDENT.source})`,
        });
      }
      if (typeof b?.keyField !== "string" || b.keyField.length === 0) {
        issues.push({ path: `instanceTracking[${i}].keyField`, message: "missing keyField" });
      } else if (buildsView && !SQL_IDENT.test(b.keyField)) {
        // `keyField` is interpolated into the derived VIEW's edge predicates (`terminatedEdgeExpr`), so it
        // must be a bare identifier for the same reason `table` must — but only when a VIEW is built.
        issues.push({
          path: `instanceTracking[${i}].keyField`,
          message: `keyField must be a SQL identifier (${SQL_IDENT.source})`,
        });
      }
      // `statusField`, when present, becomes a VIEW output column (`col(statusField)`), so it must also be
      // a bare identifier — a non-identifier would fail opaquely at VIEW construction.
      if (typeof b?.statusField === "string" && b.statusField.length > 0 && !SQL_IDENT.test(b.statusField)) {
        issues.push({
          path: `instanceTracking[${i}].statusField`,
          message: `statusField must be a SQL identifier (${SQL_IDENT.source})`,
        });
      }
      const onTerminated = isRecord(b?.onTerminated) ? b.onTerminated : undefined;
      const set = isRecord(onTerminated?.set) ? onTerminated.set : undefined;
      if (!set || Object.keys(set).length === 0) {
        issues.push({
          path: `instanceTracking[${i}].onTerminated.set`,
          message: "missing onTerminated.set patch (a non-empty column → value map)",
        });
      }
      // The single derived-status target for this binding (used by the readModel.statusColumn collision
      // guard below). Undefined when absent/blank.
      const statusFieldName = typeof b?.statusField === "string" && b.statusField.length > 0 ? b.statusField : undefined;
      // `onWaitingHuman` (issue #355) is the optional wait-on-human edge — the twin of
      // `onTerminated`. It is optional (a binding may reconcile only the terminal edge), but when
      // present its `set` must be a non-empty column → value patch for the same reason
      // `onTerminated.set` must be: a reconciler with nothing to write is inert and almost
      // certainly a mistake.
      if (b?.onWaitingHuman !== undefined) {
        const onWaitingHuman = isRecord(b.onWaitingHuman) ? b.onWaitingHuman : undefined;
        const waitingSet = isRecord(onWaitingHuman?.set) ? onWaitingHuman.set : undefined;
        if (!waitingSet || Object.keys(waitingSet).length === 0) {
          issues.push({
            path: `instanceTracking[${i}].onWaitingHuman.set`,
            message: "missing onWaitingHuman.set patch (a non-empty column → value map)",
          });
        }
      }
      // `activeStatuses` (fail-closed allow-list) and `terminalStatuses` (fail-open exclusion) are
      // both consumed as arrays of status strings. A malformed value — a bare string, or an array
      // holding a non-string/empty entry — would misbehave at runtime (`new Set("abandoned")`
      // becomes a set of characters; `activeStatuses.map(...)` crashes), so reject any non-`unset`
      // shape that isn't a non-empty array of non-empty strings. An empty array is treated as
      // "unset" (the runtime's `isConfiguredStatusSelector` gate does the same), so it is allowed.
      for (const sel of ["activeStatuses", "terminalStatuses"] as const) {
        const v = b?.[sel];
        const malformed = v !== undefined &&
          (!Array.isArray(v) || v.some((s) => typeof s !== "string" || s.length === 0));
        if (malformed) {
          issues.push({
            path: `instanceTracking[${i}].${sel}`,
            message: `${sel} must be an array of non-empty strings`,
          });
        }
      }
      if (isConfiguredStatusSelector(b?.activeStatuses) && (typeof b?.statusField !== "string" || b.statusField.length === 0)) {
        issues.push({
          path: `instanceTracking[${i}].activeStatuses`,
          message: "activeStatuses requires statusField",
        });
      }
      // `terminalStatuses` is the fail-open exclusion selector (poll every row NOT in one of
      // these). Like `activeStatuses` it reads `statusField`, so it too requires one; and the two
      // selectors are mutually exclusive — declaring both is ambiguous, so reject it.
      if (isConfiguredStatusSelector(b?.terminalStatuses) && (typeof b?.statusField !== "string" || b.statusField.length === 0)) {
        issues.push({
          path: `instanceTracking[${i}].terminalStatuses`,
          message: "terminalStatuses requires statusField",
        });
      }
      // Mutual exclusion is gated on the same "configured" predicate the runtime uses, so an empty
      // array (which the runtime treats as unset) does not spuriously trip the both-declared error.
      if (isConfiguredStatusSelector(b?.activeStatuses) && isConfiguredStatusSelector(b?.terminalStatuses)) {
        issues.push({
          path: `instanceTracking[${i}].terminalStatuses`,
          message: "activeStatuses and terminalStatuses are mutually exclusive; declare only one",
        });
      }
      // `pollMs`, when set, schedules a self-rescheduling timer; a non-number/NaN/non-positive
      // value would become a 0-delay hot loop at runtime, so reject it at author time.
      if (b?.pollMs !== undefined && (typeof b.pollMs !== "number" || !Number.isFinite(b.pollMs) || b.pollMs <= 0)) {
        issues.push({
          path: `instanceTracking[${i}].pollMs`,
          message: "pollMs must be a finite positive number of milliseconds",
        });
      }
      // `readModel` (ADR 0065, the writer→source inversion) overrides the derived status VIEW name /
      // column the runtime provisions. Both are compiled into SQL identifiers, so a non-identifier
      // value would fail opaquely at VIEW provisioning; validate them here. The VIEW must differ from
      // the base `table` (SQLite forbids a view and a table sharing a name).
      if (b?.readModel !== undefined) {
        const rm = isRecord(b.readModel) ? b.readModel : undefined;
        if (!rm) {
          issues.push({
            path: `instanceTracking[${i}].readModel`,
            message: "readModel must be an object with optional `view` / `statusColumn`",
          });
        } else {
          // Mirror the schema's `additionalProperties: false` intent (as the `network` block does): reject
          // unknown keys so a typo like `statusColum` fails loudly instead of silently falling back to the
          // default derived column while the page reads the wrong field.
          for (const k of Object.keys(rm)) {
            if (k !== "view" && k !== "statusColumn") {
              issues.push({
                path: `instanceTracking[${i}].readModel.${k}`,
                message: "unknown key (readModel additionalProperties: false)",
              });
            }
          }
          for (const field of ["view", "statusColumn"] as const) {
            const v = rm[field];
            if (v !== undefined && (typeof v !== "string" || !SQL_IDENT.test(v))) {
              issues.push({
                path: `instanceTracking[${i}].readModel.${field}`,
                message: `readModel.${field} must be a SQL identifier (${SQL_IDENT.source})`,
              });
            }
          }
          // Fold case before comparing: `defineReadModel`/SQLite treat identifiers case-insensitively,
          // so `table:"plans"` + `readModel.view:"Plans"` would pass a case-sensitive check here yet be
          // rejected as a base-table collision at VIEW construction. Compare folded so author-time
          // validation matches provisioning behavior.
          if (typeof rm.view === "string" && typeof b?.table === "string" && rm.view.toLowerCase() === b.table.toLowerCase()) {
            issues.push({
              path: `instanceTracking[${i}].readModel.view`,
              message: "readModel.view must differ from the base table (a view cannot shadow its table)",
            });
          }
          // The VIEW emits `${statusColumn} AS ...` after `base.*`; if the derived status column folds to
          // the same identifier as the base `statusField`, SQLite exposes two output columns of that name
          // and keeps the base (stored) one — so consumers read the STALE value, silently defeating the
          // derivation. Reject the collision at author time (case-insensitive, matching SQLite's folding).
          if (typeof rm.statusColumn === "string" && statusFieldName !== undefined &&
            rm.statusColumn.toLowerCase() === statusFieldName.toLowerCase()) {
            issues.push({
              path: `instanceTracking[${i}].readModel.statusColumn`,
              message: `readModel.statusColumn must differ from statusField "${statusFieldName}" (a same-named derived column is shadowed by the stored base column and reads stale)`,
            });
          }
        }
      }
      // Validate the EFFECTIVE default target too, not just an explicit override. When
      // `readModel.statusColumn` is omitted (or `readModel` entirely), the VIEW derives the status
      // under the default column `derived_status`. A binding with `statusField: "derived_status"` and
      // no override therefore collides with the default derived column exactly as an explicit override
      // would — SQLite keeps the stored base column and the derived read is stale. The explicit-override
      // collision is caught above; this closes the omitted-override path (which the runtime would
      // otherwise only discover at boot, then skip the VIEW).
      const rmRec = isRecord(b?.readModel) ? b.readModel : undefined;
      const hasExplicitStatusColumn = typeof rmRec?.statusColumn === "string" && rmRec.statusColumn.length > 0;
      if (statusFieldName !== undefined && !hasExplicitStatusColumn &&
        DEFAULT_DERIVED_STATUS_COLUMN.toLowerCase() === statusFieldName.toLowerCase()) {
        issues.push({
          path: `instanceTracking[${i}].statusField`,
          message: `statusField "${statusFieldName}" collides with the default derived status column "${DEFAULT_DERIVED_STATUS_COLUMN}" (set readModel.statusColumn to a distinct name, or rename statusField)`,
        });
      }
      // Reserved-base-table guard (ADR 0065): the base `table` must not itself be a reserved runtime
      // object (`_urban_` / `_nano_` / `sqlite_`). The reserved-VIEW guard below only rejects a reserved
      // *effective view name*, so a binding like `table: "_urban_instance_state", readModel: { view:
      // "tracking" }` slips through — it would publish a NON-reserved `tracking` VIEW that SELECTs the
      // runtime's hidden instance-state sidecar, and `gateway.schema()` filters only the object NAME, so
      // `/app/data/.../tracking` would expose those internal rows. A tracking binding over a reserved
      // runtime table is never legitimate; reject it at author time regardless of statusField.
      if (typeof b?.table === "string" && b.table.length > 0 && isReservedObjectName(b.table)) {
        issues.push({
          path: `instanceTracking[${i}].table`,
          message: `base table "${b.table}" uses a reserved prefix (_urban_ / _nano_ / sqlite_); tracking a reserved runtime table would publish a derived VIEW over hidden runtime state (choose an application base table)`,
        });
      }
      // Reserved-prefix guard (ADR 0065): the effective managed VIEW name (`readModel.view` or the
      // default `<table>__tracking`) must not begin with a reserved object prefix (`_urban_` / `_nano_`
      // / `sqlite_`). Such a VIEW provisions fine but is filtered out of the datasource `schema()`
      // surface (`gateway.ts`), so the operator page configured for it reads `unknown table`. Reject at
      // author time rather than let it fail opaquely at read. Only bindings with a `statusField`
      // provision a VIEW, so only those can hit this.
      if (statusFieldName !== undefined && typeof b?.table === "string" && b.table.length > 0) {
        const rmView = typeof rmRec?.view === "string" && rmRec.view.length > 0 ? rmRec.view : undefined;
        const effectiveView = rmView ?? defaultInstanceTrackingViewName(b.table);
        if (isReservedObjectName(effectiveView)) {
          issues.push({
            path: rmView ? `instanceTracking[${i}].readModel.view` : `instanceTracking[${i}].table`,
            message: `managed VIEW name "${effectiveView}" uses a reserved prefix (_urban_ / _nano_ / sqlite_); such a view is hidden from the datasource surface and cannot be read by a page (choose a non-reserved readModel.view or base table name)`,
          });
        }
      }
    });
    // Duplicate managed-VIEW names across bindings (ADR 0065): each binding's read model DROP+CREATEs a
    // VIEW named `readModel.view` or, by default, `<table>__tracking`. Two bindings that fold to the same
    // VIEW name (two bindings on one base table with no distinct override, or names differing only by
    // case) would silently clobber each other at provisioning — the later CREATE wins and the earlier
    // binding loses its derivation. Reject the collision here, folded (SQLite folds identifiers), naming
    // both bindings. Only bindings with a `statusField` provision a VIEW, so only those can collide.
    const viewOwners = new Map<string, number>();
    // Also reserve every binding's BASE TABLE name: SQLite shares one namespace for tables and views,
    // so a managed VIEW `orders__tracking` for one binding collides with another binding whose base
    // `table` is `orders__tracking`. The manifest would pass validation, then `CREATE VIEW` fails at boot
    // and the first binding loses its derived surface. Collect base tables first (folded), then flag any
    // managed-view name that lands on one.
    const baseTableOwners = new Map<string, number>();
    tracking.forEach((t, i) => {
      const b = isRecord(t) ? t : undefined;
      if (typeof b?.table !== "string" || b.table.length === 0) return;
      const folded = b.table.toLowerCase();
      if (!baseTableOwners.has(folded)) baseTableOwners.set(folded, i);
    });
    tracking.forEach((t, i) => {
      const b = isRecord(t) ? t : undefined;
      if (typeof b?.table !== "string" || b.table.length === 0) return;
      if (typeof b?.statusField !== "string" || b.statusField.length === 0) return; // no VIEW ⇒ no collision
      const rm = isRecord(b.readModel) ? b.readModel : undefined;
      const view = typeof rm?.view === "string" && rm.view.length > 0 ? rm.view : defaultInstanceTrackingViewName(b.table);
      const folded = view.toLowerCase();
      const prev = viewOwners.get(folded);
      if (prev !== undefined) {
        issues.push({
          path: `instanceTracking[${i}].readModel.view`,
          message: `managed VIEW name "${view}" collides with instanceTracking[${prev}] (identifiers fold case-insensitively); give each binding a distinct readModel.view`,
        });
      } else {
        viewOwners.set(folded, i);
      }
      // A managed VIEW name that folds to another binding's base table shares SQLite's table/view
      // namespace and would fail `CREATE VIEW` at boot. (Its own base table is already rejected above as
      // "view cannot shadow its table"; here we catch collisions with a DIFFERENT binding's base table.)
      const tableOwner = baseTableOwners.get(folded);
      if (tableOwner !== undefined && tableOwner !== i) {
        issues.push({
          path: `instanceTracking[${i}].readModel.view`,
          message: `managed VIEW name "${view}" collides with the base table of instanceTracking[${tableOwner}] (SQLite shares one table/view namespace); give this binding a distinct readModel.view`,
        });
      }
    });
  }

  return issues;
}


export function assertValidManifest(m: unknown): asserts m is AppManifest {
  const issues = collectManifestIssues(m);
  if (issues.length > 0) throw new ManifestValidationError(issues);
}

/** Throw ManifestValidationError if the manifest is invalid; otherwise return it typed. */
export function validateManifest(m: unknown): AppManifest {
  assertValidManifest(m);
  return m;
}
