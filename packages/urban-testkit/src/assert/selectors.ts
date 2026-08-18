// Shared process-instance selectors and resolver for the `assertThat*` DSL.
//
// `assertThatInstance` and `assertThatUserTask` both need to turn a caller's
// selector — a bare process-instance key, `byKey(...)`, `byProcessId(...)`, or
// the "the single active instance" convenience — into a concrete instance key,
// resolved against the engine's parsed `snapshot()`. That logic lives here once
// so the two slices cannot drift. It is fully deterministic: it reads the
// snapshot synchronously and never touches a wall-clock or entropy source.

import type { TestApp } from "../boot-app.ts";
import { failAssertion, formatValue } from "./format.ts";

/** Select an instance by its exact process-instance key. */
export interface ByKeySelector {
  readonly kind: "key";
  readonly key: string;
}

/** Select an instance by its BPMN process id (the deployed process definition's id). */
export interface ByProcessIdSelector {
  readonly kind: "processId";
  readonly processId: string;
}

/** A discriminated union of the ways to point at a single process instance. */
export type InstanceSelector = ByKeySelector | ByProcessIdSelector;

/** Select the instance whose process-instance key is `key`. */
export function byKey(key: string): InstanceSelector {
  return { kind: "key", key };
}

/** Select the instance whose BPMN process id is `processId`. */
export function byProcessId(processId: string): InstanceSelector {
  return { kind: "processId", processId };
}

/** The subset of an engine snapshot instance record the resolver reads. */
export interface InstanceRow {
  readonly key: string;
  readonly state: string | undefined;
  readonly processId: string | undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/** Project the `instances` array of a parsed engine snapshot into the typed rows
 *  the resolver reasons over. Keyless instances are dropped (a missing key can't
 *  be selected). Exported so the sibling slices — and unit tests — can read the
 *  same normalised view without re-implementing the snapshot shape. */
export function readInstances(snapshot: Record<string, unknown>): InstanceRow[] {
  const raw = snapshot.instances;
  if (!Array.isArray(raw)) return [];
  const rows: InstanceRow[] = [];
  for (const item of raw) {
    if (!isRecord(item)) continue;
    const key = readString(item.key);
    if (key === undefined) continue;
    rows.push({
      key,
      state: readString(item.state),
      processId: readString(item.processId) ?? readString(item.bpmnProcessId),
    });
  }
  return rows;
}

function describeInstances(instances: InstanceRow[]): string {
  if (instances.length === 0) return "no instances in the snapshot";
  const rendered = instances
    .map((i) => `{ key: ${formatValue(i.key)}, state: ${formatValue(i.state)}, processId: ${formatValue(i.processId)} }`)
    .join(", ");
  return `instances: [${rendered}]`;
}

function throwResolution(reason: string, instances: InstanceRow[]): never {
  failAssertion({
    message: `Could not resolve a process instance: ${reason}. Actual ${describeInstances(instances)}.`,
    operator: "resolveInstance",
    diff: false,
  });
}

/** Resolve a selector (or bare key, or "the single active instance" when
 *  omitted) against a set of instance rows, returning the concrete
 *  process-instance key. Throws an intent-revealing `AssertionError` naming the
 *  actual instances when resolution is ambiguous or fails. Kept separate from
 *  {@link resolveInstanceKey} so its pure logic is unit-testable without a booted app. */
export function resolveFromInstances(
  instances: InstanceRow[],
  selectorOrKey?: string | InstanceSelector,
): string {
  if (selectorOrKey === undefined) {
    const active = instances.filter((i) => i.state === "ACTIVE");
    if (active.length === 0) {
      throwResolution("no ACTIVE instance to default to — pass a key or selector", instances);
    }
    if (active.length > 1) {
      throwResolution(
        `${active.length} ACTIVE instances — ambiguous; pass byKey(...) or byProcessId(...)`,
        instances,
      );
    }
    return active[0].key;
  }

  if (typeof selectorOrKey === "string") {
    const match = instances.find((i) => i.key === selectorOrKey);
    if (match === undefined) {
      throwResolution(`no instance with key ${formatValue(selectorOrKey)}`, instances);
    }
    return match.key;
  }

  if (selectorOrKey.kind === "key") {
    const match = instances.find((i) => i.key === selectorOrKey.key);
    if (match === undefined) {
      throwResolution(`no instance with key ${formatValue(selectorOrKey.key)}`, instances);
    }
    return match.key;
  }

  const kind: string = selectorOrKey.kind;
  if (kind !== "processId") {
    throwResolution(`unknown selector kind ${formatValue(kind)}`, instances);
  }

  const matches = instances.filter((i) => i.processId === selectorOrKey.processId);
  if (matches.length === 0) {
    throwResolution(`no instance with processId ${formatValue(selectorOrKey.processId)}`, instances);
  }
  if (matches.length > 1) {
    throwResolution(
      `${matches.length} instances with processId ${formatValue(selectorOrKey.processId)} — ambiguous; select byKey(...)`,
      instances,
    );
  }
  return matches[0].key;
}

/** Resolve `selectorOrKey` against `app.snapshot()`, returning the concrete
 *  process-instance key. Used by the instance and user-task matcher slices. */
export function resolveInstanceKey(
  app: TestApp,
  selectorOrKey?: string | InstanceSelector,
): string {
  return resolveFromInstances(readInstances(app.snapshot()), selectorOrKey);
}
