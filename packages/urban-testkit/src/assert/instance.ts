// `assertThatInstance` — fluent assertions over a single process instance.
//
// Every matcher reads synchronously from `app.snapshot()` (the engine's parsed
// process snapshot) and throws an intent-revealing `node:assert` `AssertionError`
// that NAMES the actual state / elements / variables / incidents on failure. The
// whole file is deterministic: it never touches a wall-clock (`Date.now`,
// `setTimeout`/`setInterval`), an entropy source (`Math.random`), or real-time
// `await` — a matcher's verdict is a pure function of the current snapshot.
//
// Only the body of this file is owned by the `instance-assert` slice; the shared
// resolver/selectors (`./selectors.ts`), the failure-message helpers
// (`./format.ts`), and the package barrel (`../index.ts`) are owned by the
// scaffold and are NOT edited here.

import type { TestApp } from "../boot-app.ts";
import type { ProcessInstanceState } from "../wasm-engine.ts";
import { wasmStateToProcessInstanceState } from "../wasm-engine.ts";
import { deepEqual, deepSubset, failAssertion, formatValue } from "./format.ts";
import { type InstanceSelector, readInstances, resolveInstanceKey } from "./selectors.ts";

/** Narrows which incident an instance-level incident matcher targets. When both
 *  fields are given, an incident must satisfy BOTH (element id is matched exactly;
 *  error message is matched as a substring of the incident's reason). */
export interface IncidentSelector {
  /** Match only incidents raised on this BPMN element. */
  readonly elementId?: string;
  /** Match only incidents whose failure reason CONTAINS this text. */
  readonly errorMessage?: string;
}

/** Fluent assertions over a single process instance's state, active/completed
 *  elements, variables, and instance-level incidents. Every matcher returns the
 *  same object so calls chain. */
export interface InstanceAssert {
  /** The instance's lifecycle state is `ACTIVE`. */
  isActive(): InstanceAssert;
  /** The instance's lifecycle state is `COMPLETED`. */
  hasCompleted(): InstanceAssert;
  /** The instance's lifecycle state is `TERMINATED` (cancelled/terminated). */
  isTerminated(): InstanceAssert;
  /** The element `elementId` currently has an active token in this instance. */
  hasActiveElement(elementId: string): InstanceAssert;
  /** Every one of the given element ids currently has an active token in this instance. */
  hasActiveElements(firstElementId: string, ...moreElementIds: string[]): InstanceAssert;
  /** Every one of the given element ids has completed at least once. */
  hasCompletedElements(firstElementId: string, ...moreElementIds: string[]): InstanceAssert;
  /** The variable `name` is present and deep-equals `value`. */
  hasVariable(name: string, value: unknown): InstanceAssert;
  /** Every key/value in `subset` is present and deep-equal (extra vars ignored). */
  hasVariables(subset: Record<string, unknown>): InstanceAssert;
  /** No variable named `name` is present on the instance. */
  hasNoVariable(name: string): InstanceAssert;
  /** The instance has at least one incident (optionally narrowed by `selector`). */
  hasIncident(selector?: IncidentSelector): InstanceAssert;
  /** The instance has no incidents. */
  hasNoIncident(): InstanceAssert;
}

/** A single incident record, projected from the snapshot's top-level `incidents`. */
interface IncidentRow {
  readonly instanceKey: string | undefined;
  readonly elementId: string | undefined;
  readonly reason: string | undefined;
  readonly kind: string | undefined;
  readonly key: string | undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/** The resolved instance's raw snapshot record, re-read fresh on every matcher so
 *  the DSL always reflects the current snapshot. Throws if the instance vanished. */
function instanceRecord(app: TestApp, key: string): Record<string, unknown> {
  const raw = app.snapshot().instances;
  const list = Array.isArray(raw) ? raw : [];
  const rec = list.find((item) => isRecord(item) && readString(item.key) === key);
  if (rec === undefined || !isRecord(rec)) {
    failAssertion({
      message: `Instance ${formatValue(key)} is no longer present in the snapshot.`,
      operator: "assertThatInstance",
      diff: false,
    });
  }
  return rec;
}

/** The element ids that currently hold an active token in `rec`. */
function activeElementIds(rec: Record<string, unknown>): string[] {
  const raw = rec.activeElements;
  if (!Array.isArray(raw)) return [];
  const ids: string[] = [];
  for (const item of raw) {
    if (!isRecord(item)) continue;
    const id = readString(item.elementId);
    if (id !== undefined) ids.push(id);
  }
  return ids;
}

/** The element ids that have completed at least once, read from the snapshot's
 *  top-level `elementStats` (`{ elementId, active, completed, incidents }`). The
 *  engine snapshot exposes completion counts only at this aggregate level — a
 *  per-instance record carries only its live `activeElements` — so this is only
 *  sound when the snapshot holds a single instance that is the resolved one;
 *  `hasCompletedElements` guards that precondition (presence + single-instance),
 *  and tests boot an isolated app per case. */
function completedElementIds(snapshot: Record<string, unknown>): string[] {
  const raw = snapshot.elementStats;
  if (!Array.isArray(raw)) return [];
  const ids: string[] = [];
  for (const item of raw) {
    if (!isRecord(item)) continue;
    const id = readString(item.elementId);
    const completed = item.completed;
    if (id !== undefined && typeof completed === "number" && completed > 0) ids.push(id);
  }
  return ids;
}

function variablesOf(rec: Record<string, unknown>): Record<string, unknown> {
  return isRecord(rec.variables) ? rec.variables : {};
}

/** The incidents raised on the resolved instance, from the snapshot's top-level
 *  `incidents` array filtered by `instanceKey`. */
function incidentsFor(snapshot: Record<string, unknown>, key: string): IncidentRow[] {
  const raw = snapshot.incidents;
  if (!Array.isArray(raw)) return [];
  const rows: IncidentRow[] = [];
  for (const item of raw) {
    if (!isRecord(item)) continue;
    if (readString(item.instanceKey) !== key) continue;
    rows.push({
      instanceKey: readString(item.instanceKey),
      elementId: readString(item.elementId),
      reason: readString(item.reason),
      kind: readString(item.kind),
      key: readString(item.key),
    });
  }
  return rows;
}

function incidentMatches(incident: IncidentRow, selector: IncidentSelector): boolean {
  if (selector.elementId !== undefined && incident.elementId !== selector.elementId) return false;
  if (selector.errorMessage !== undefined && !(incident.reason ?? "").includes(selector.errorMessage)) {
    return false;
  }
  return true;
}

function describeIncidents(incidents: IncidentRow[]): string {
  if (incidents.length === 0) return "no incidents";
  return `[${incidents
    .map(
      (i) =>
        `{ elementId: ${formatValue(i.elementId)}, kind: ${formatValue(i.kind)}, reason: ${formatValue(i.reason)} }`,
    )
    .join(", ")}]`;
}

/** Resolve `keyOrSelector` to a concrete process-instance key.
 *
 *  A bare string key, a `byKey`/`byProcessId` selector, and the "no selector →
 *  the single ACTIVE instance" convenience are all delegated to the shared
 *  {@link resolveInstanceKey} — the single source of truth for selector
 *  resolution — which normalises the mixed-case wasm snapshot `state` (e.g.
 *  "Active") through the canonical mapping. Kept as a thin alias so this slice's
 *  matchers read against one resolver. */
function resolveKey(app: TestApp, keyOrSelector?: string | InstanceSelector): string {
  return resolveInstanceKey(app, keyOrSelector);
}

/** Assert over a single process instance, resolved from `keyOrSelector`
 *  (a bare key, `byKey(...)`, `byProcessId(...)`, or omitted for the single
 *  ACTIVE instance). */
export function assertThatInstance(
  app: TestApp,
  keyOrSelector?: string | InstanceSelector,
): InstanceAssert {
  const key = resolveKey(app, keyOrSelector);

  const assertState = (want: ProcessInstanceState, operator: string): InstanceAssert => {
    const rec = instanceRecord(app, key);
    const actual = wasmStateToProcessInstanceState(rec.state);
    if (actual !== want) {
      failAssertion({
        message: `Expected instance ${formatValue(key)} to be ${want}, but it is ${actual ?? formatValue(rec.state)}.`,
        actual: actual ?? rec.state,
        expected: want,
        operator,
      });
    }
    return self;
  };

  const requireActiveElements = (elementIds: string[], operator: string): InstanceAssert => {
    const rec = instanceRecord(app, key);
    const actual = activeElementIds(rec);
    const missing = elementIds.filter((id) => !actual.includes(id));
    if (missing.length > 0) {
      failAssertion({
        message: `Expected instance ${formatValue(key)} to have active element(s) ${formatValue(missing)}, but its active elements are ${formatValue(actual)}.`,
        actual,
        expected: elementIds,
        operator,
      });
    }
    return self;
  };

  const self: InstanceAssert = {
    isActive: () => assertState("ACTIVE", "isActive"),
    hasCompleted: () => assertState("COMPLETED", "hasCompleted"),
    isTerminated: () => assertState("TERMINATED", "isTerminated"),

    hasActiveElement: (elementId) => requireActiveElements([elementId], "hasActiveElement"),
    hasActiveElements: (first, ...rest) => requireActiveElements([first, ...rest], "hasActiveElements"),

    hasCompletedElements: (first, ...rest) => {
      const elementIds = [first, ...rest];
      const snapshot = app.snapshot();
      const instances = readInstances(snapshot);
      // `elementStats` is snapshot-global, not per-instance, so a completion
      // count is only attributable to THIS instance when it is the snapshot's
      // sole instance. Two ways that precondition can break:
      //   1. the resolved instance is no longer present (it vanished, or the lone
      //      surviving instance is a different key) — every sibling matcher guards
      //      this via `instanceRecord`, so mirror it here rather than borrow a
      //      verdict from the wrong (or a gone) instance; and
      //   2. several instances coexist — the aggregate cannot be split per key.
      // Refuse in both cases (tests scope the happy path to an isolated app).
      if (!instances.some((row) => row.key === key)) {
        failAssertion({
          message: `Cannot assert completed elements on instance ${formatValue(key)}: it is no longer present in the snapshot — a per-instance verdict would be read from the wrong instance's (snapshot-global) completions. Actual instances: ${formatValue(instances.map((row) => row.key))}.`,
          operator: "hasCompletedElements",
          diff: false,
        });
      }
      const instanceCount = instances.length;
      if (instanceCount > 1) {
        failAssertion({
          message: `Cannot assert completed elements on instance ${formatValue(key)}: the snapshot holds more than one instance (${instanceCount}), and the engine reports element completion counts only at the aggregate (snapshot-global) level — a per-instance verdict would be unsound. Assert completed elements against a snapshot containing a single instance.`,
          operator: "hasCompletedElements",
          diff: false,
        });
      }
      const actual = completedElementIds(snapshot);
      const missing = elementIds.filter((id) => !actual.includes(id));
      if (missing.length > 0) {
        failAssertion({
          message: `Expected instance ${formatValue(key)} to have completed element(s) ${formatValue(missing)}, but its completed elements are ${formatValue(actual)}.`,
          actual,
          expected: elementIds,
          operator: "hasCompletedElements",
        });
      }
      return self;
    },

    hasVariable: (name, value) => {
      const vars = variablesOf(instanceRecord(app, key));
      if (!Object.hasOwn(vars, name)) {
        failAssertion({
          message: `Expected instance ${formatValue(key)} to have variable ${formatValue(name)}, but its variables are ${formatValue(vars)}.`,
          actual: vars,
          expected: name,
          operator: "hasVariable",
          diff: false,
        });
      }
      if (!deepEqual(vars[name], value)) {
        failAssertion({
          message: `Variable ${formatValue(name)} on instance ${formatValue(key)} does not equal the expected value.`,
          actual: vars[name],
          expected: value,
          operator: "hasVariable",
        });
      }
      return self;
    },

    hasVariables: (subset) => {
      const vars = variablesOf(instanceRecord(app, key));
      if (!deepSubset(vars, subset)) {
        failAssertion({
          message: `Instance ${formatValue(key)} variables do not contain the expected subset.`,
          actual: vars,
          expected: subset,
          operator: "hasVariables",
        });
      }
      return self;
    },

    hasNoVariable: (name) => {
      const vars = variablesOf(instanceRecord(app, key));
      if (Object.hasOwn(vars, name)) {
        failAssertion({
          message: `Expected instance ${formatValue(key)} to have NO variable ${formatValue(name)}, but it is present with value ${formatValue(vars[name])}.`,
          actual: vars[name],
          expected: undefined,
          operator: "hasNoVariable",
          diff: false,
        });
      }
      return self;
    },

    hasIncident: (selector) => {
      const incidents = incidentsFor(app.snapshot(), key);
      const matching = selector === undefined
        ? incidents
        : incidents.filter((i) => incidentMatches(i, selector));
      if (matching.length === 0) {
        const wanted = selector === undefined
          ? "an incident"
          : `an incident matching ${formatValue(selector)}`;
        const actualClause = incidents.length === 0
          ? "it has no incidents"
          : `its incidents are ${describeIncidents(incidents)}`;
        failAssertion({
          message: `Expected instance ${formatValue(key)} to have ${wanted}, but ${actualClause}.`,
          operator: "hasIncident",
          diff: false,
        });
      }
      return self;
    },

    hasNoIncident: () => {
      const incidents = incidentsFor(app.snapshot(), key);
      if (incidents.length > 0) {
        failAssertion({
          message: `Expected instance ${formatValue(key)} to have no incidents, but found ${describeIncidents(incidents)}.`,
          operator: "hasNoIncident",
          diff: false,
        });
      }
      return self;
    },
  };

  return self;
}
