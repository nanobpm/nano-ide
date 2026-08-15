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
import { BIND_MODES, isBindMode, isConfiguredStatusSelector } from "./manifest.ts";
import type { AppManifest } from "./manifest.ts";

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
    } else if ("bind" in network && !isBindMode(network.bind)) {
      issues.push({
        path: "network.bind",
        message: `must be one of: ${BIND_MODES.map((mode) => `"${mode}"`).join(", ")}`,
      });
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
      if (typeof b?.table !== "string" || b.table.length === 0) {
        issues.push({ path: `instanceTracking[${i}].table`, message: "missing table" });
      }
      if (typeof b?.keyField !== "string" || b.keyField.length === 0) {
        issues.push({ path: `instanceTracking[${i}].keyField`, message: "missing keyField" });
      }
      const onTerminated = isRecord(b?.onTerminated) ? b.onTerminated : undefined;
      const set = isRecord(onTerminated?.set) ? onTerminated.set : undefined;
      if (!set || Object.keys(set).length === 0) {
        issues.push({
          path: `instanceTracking[${i}].onTerminated.set`,
          message: "missing onTerminated.set patch (a non-empty column → value map)",
        });
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
