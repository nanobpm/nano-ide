// STUB — `assertThatResponse` fluent matcher over an HTTP `ApiResponse`. The
// real body lands in the `urban-surface-assert` slice (which edits ONLY this
// file). Declared here so the package barrel can be wired once. Do not
// implement here.

import type { ApiResponse } from "../openapi-driver.ts";

/** Fluent assertions over an already-resolved HTTP response's status, JSON
 *  body, and headers. Implemented by the `urban-surface-assert` slice. */
export interface ResponseAssert<T> {
  readonly _body?: T;
}

/** Assert over an already-resolved {@link ApiResponse} (synchronous). */
export function assertThatResponse<T>(_res: ApiResponse<T>): ResponseAssert<T> {
  throw new Error("not implemented");
}
