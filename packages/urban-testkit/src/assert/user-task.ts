// STUB — `assertThatUserTask` fluent matcher. The real body lands in the
// `usertask-assert` slice (which edits ONLY this file). Declared here so the
// package barrel can be wired once. Do not implement matchers here.

import type { TestApp } from "../boot-app.ts";
import type { InstanceSelector } from "./selectors.ts";

/** Selects a user task by its owning instance (key / selector) and/or its
 *  element id. Shape is finalised by the `usertask-assert` slice. */
export type UserTaskSelector = {
  readonly instance?: string | InstanceSelector;
  readonly elementId?: string;
};

/** Fluent assertions over a user task's state, assignee, and candidate groups.
 *  Implemented by the `usertask-assert` slice. */
export interface UserTaskAssert {
  readonly _stub?: never;
}

/** Assert over the user task selected by `selector`. */
export function assertThatUserTask(
  _app: TestApp,
  _selector: UserTaskSelector,
): UserTaskAssert {
  throw new Error("not implemented");
}
