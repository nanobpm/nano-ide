// Pure planner for the write-once operation-delegate scaffolder (ADR 0059). Given a parsed OpenAPI
// document, it plans one typed delegate stub per declared `operationId` — the ONE part of the HTTP
// surface that cannot be derived from the spec (the handler *body* is human logic). Everything here
// is pure and testable like a deriver; the impure write-if-absent edge lives in `../scaffold.ts`.
//
// scaffold ≠ derive: stubs are human-owned files under `<dir>/<operationId>.ts`, so they are planned
// once and never overwritten — unlike the derived `nano-generated/` tree (which includes the
// controller registry that statically imports these delegates and type-checks the whole set).

import { DEFAULT_OPERATIONS_DIR, normalizeApiDir } from "../api-dir.ts";
import { collectOperations, type OpenApiDoc } from "../../openapi/spec.ts";

export { DEFAULT_OPERATIONS_DIR };

/** One planned operation-delegate stub. */
export interface OperationStubPlan {
  operationId: string;
  /** App-relative delegate path: `<dir>/<operationId>.ts`. */
  handlerPath: string;
  /** The stub file contents (a typed `defineOperation` that throws `NotImplemented` → HTTP 501). */
  stub: string;
}

/** Normalize an `api.dir` to a clean relative segment (see `normalizeApiDir`); rejects absolute
 *  paths and `..` segments so stubs are scaffolded where the runtime resolves delegates from. */
function normalizeDir(dir: string): string {
  return normalizeApiDir(dir);
}

/** Number of `../` hops from `<dir>/<file>.ts` back up to the app root (dir may be nested). */
function upToRoot(dir: string): string {
  const depth = dir.split("/").filter((s) => s.length > 0).length;
  return "../".repeat(depth);
}

/** Render a stub matching a real hand-authored operation delegate (default-exported, typed via the
 *  generated `defineOperation`). It throws `NotImplemented` so the endpoint returns 501 until the
 *  body is implemented — never a silent 500, never a drift from the contract. */
export function renderOperationStub(operationId: string, dir: string = DEFAULT_OPERATIONS_DIR): string {
  const up = upToRoot(normalizeDir(dir));
  const key = JSON.stringify(operationId);
  return (
    `// Operation delegate stub for the \`${operationId}\` endpoint, scaffolded from the OpenAPI spec\n` +
    `// (ADR 0059). This file is yours to edit — \`urban stubs\` will never overwrite it. The\n` +
    `// generated controller (nano-generated/controller.ts) imports this default export and\n` +
    `// type-checks it against the spec, so the signature cannot drift. Implement the body below\n` +
    `// (the validated \`{ req, params, query, body }\` input + the injected \`app\`) and delete the throw.\n` +
    `import { NotImplemented } from "@nanobpm/urban";\n` +
    `import { defineOperation } from ${JSON.stringify(`${up}nano-generated/operations.ts`)};\n` +
    `\n` +
    `export default defineOperation(${key}, async (input, app) => {\n` +
    `  // \`input\` is the validated request (params/query/body/req); reach app state + services\n` +
    `  // through the injected \`app\` API. Return \`{ status?, headers?, body? }\` (or nothing → 204).\n` +
    `  throw new NotImplemented(${key});\n` +
    `});\n`
  );
}

/**
 * Plan write-once delegate stubs from the spec: one per declared `operationId` (collectOperations
 * already skips ops without a safe id). The planner emits a plan for every operation; the impure
 * edge (`scaffoldOperations`) keeps an existing file verbatim and creates only the absent ones.
 */
export function planOperationScaffold(
  doc: OpenApiDoc,
  dir: string = DEFAULT_OPERATIONS_DIR,
): OperationStubPlan[] {
  const cleanDir = normalizeDir(dir);
  return collectOperations(doc).map((op) => ({
    operationId: op.operationId,
    handlerPath: `${cleanDir}/${op.operationId}.ts`,
    stub: renderOperationStub(op.operationId, cleanDir),
  }));
}
