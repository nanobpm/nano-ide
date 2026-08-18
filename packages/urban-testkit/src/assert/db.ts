// STUB — `assertThatDb` fluent matcher over the app's SQLite. The real body
// lands in the `urban-surface-assert` slice (which edits ONLY this file).
// Declared here so the package barrel can be wired once. Do not implement here.

import type { TestApp } from "../boot-app.ts";

/** Fluent assertions over the rows of a single SQLite table. Implemented by the
 *  `urban-surface-assert` slice. */
export interface TableAssert {
  readonly _stub?: never;
}

/** Entry point for SQLite-table assertions; `table(name)` narrows to one table. */
export interface DbAssert {
  table(name: string): TableAssert;
}

/** Assert over the app's provisioned SQLite (`app.db`). */
export function assertThatDb(_app: TestApp): DbAssert {
  throw new Error("not implemented");
}
