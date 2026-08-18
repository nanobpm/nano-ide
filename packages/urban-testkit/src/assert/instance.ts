// STUB — `assertThatInstance` fluent matcher. The real body lands in the
// `instance-assert` slice (which edits ONLY this file). Declared here so the
// package barrel can be wired once and the sibling slice never touches
// `index.ts`. Do not implement matchers here.

import type { TestApp } from "../boot-app.ts";
import type { InstanceSelector } from "./selectors.ts";

/** Narrows which incident an instance-level incident matcher targets (e.g. by
 *  element id or error message). Shape is filled in by the `instance-assert` slice. */
export interface IncidentSelector {
  readonly elementId?: string;
  readonly errorMessage?: string;
}

/** Fluent assertions over a single process instance's state, elements,
 *  variables, and incidents. Implemented by the `instance-assert` slice. */
export interface InstanceAssert {
  readonly _stub?: never;
}

/** Assert over a single process instance, resolved from `keyOrSelector`
 *  (a bare key, `byKey(...)`, `byProcessId(...)`, or omitted for the single
 *  ACTIVE instance). */
export function assertThatInstance(
  _app: TestApp,
  _keyOrSelector?: string | InstanceSelector,
): InstanceAssert {
  throw new Error("not implemented");
}
