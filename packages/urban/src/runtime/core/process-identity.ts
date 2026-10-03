// The single, transport-agnostic normalizer for a {@link ProcessDefinitionIdentity}. Both engine
// adapters — the live SDK/REST adapter (`engine/nanosdk.ts`, `SdkEngineClient`) and the in-process
// WASM test adapter (`@nanobpm/urban-testkit`, `WasmEngineClient`) — report which deployed
// definition an instance runs on *both* `createInstance` and `searchProcessInstances`. Each used to
// carry its own hand-mirrored `pickProcessDefinitionIdentity` (plus a re-declared identity type), so
// the two could silently diverge the moment identity validation changed — exactly the drift class
// the shared form-contract normalizer exists to kill (`./form-contract.ts`, issue #252). Centralizing
// the mapper (and reusing the canonical {@link ProcessDefinitionIdentity}) here removes that surface:
// a created instance and its later snapshot describe the same definition identically, for every
// adapter, because they run the *same* code.

import type { ProcessDefinitionIdentity } from "./host.ts";

export type { ProcessDefinitionIdentity };

/** A non-empty string form of an engine key/id, or `undefined` when absent/blank (including a
 *  whitespace-only string). Coerces a *finite* numeric key to a string (the engine may serialize a
 *  key either way) but never `String(...)`-coerces an arbitrary object into a garbage
 *  `"[object Object]"` id, nor a non-finite number into `"NaN"`/`"Infinity"`. The blank check trims,
 *  matching the read-path blank-key guards, so a `"   "` key can never leak into a result. */
export function presentEngineKey(value: unknown): string | undefined {
  if (typeof value === "number") {
    return Number.isFinite(value) ? String(value) : undefined;
  }
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

/** A present string-only identifier (e.g. a BPMN process id) under the shared trim rule; a
 *  non-string is absent and never `String(...)`-coerced. */
export function presentString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

/** The {@link ProcessDefinitionIdentity} an engine row (a create response or a process-instance
 *  search row) reports — the single mapping both `createInstance` and `searchProcessInstances` use,
 *  so a created instance and its later snapshot describe the same definition identically. Each field
 *  passes the shared presence rule; a version that is not a positive integer number is omitted
 *  (never coerced). */
export function pickProcessDefinitionIdentity(row: {
  processDefinitionKey?: unknown;
  processDefinitionId?: unknown;
  processDefinitionVersion?: unknown;
}): ProcessDefinitionIdentity {
  const processDefinitionKey = presentEngineKey(row.processDefinitionKey);
  const processDefinitionId = presentString(row.processDefinitionId);
  const version = row.processDefinitionVersion;
  const processDefinitionVersion =
    typeof version === "number" && Number.isInteger(version) && version > 0 ? version : undefined;
  return {
    ...(processDefinitionKey ? { processDefinitionKey } : {}),
    ...(processDefinitionId ? { processDefinitionId } : {}),
    ...(processDefinitionVersion !== undefined ? { processDefinitionVersion } : {}),
  };
}
