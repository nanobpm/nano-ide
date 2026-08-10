// `@nanobpm/urban/worker` — the runtime-free worker-authoring surface.
//
// A service-task handler only needs a handful of *types*: the handler signature and the
// shapes it is handed. Those all live under `runtime/core/`, which is guaranteed free of any
// `node:*` import or `Deno` reference (the ADR 0052 purity invariant, enforced by
// core/purity.test.ts). Importing them from the package barrel (`@nanobpm/urban`) instead
// drags in `runtime/index.ts`, which re-exports the Node and Deno host adapters — so the
// barrel's type graph transitively references `node:*` and a consumer must have `@types/node`
// resolvable (or `skipLibCheck` on) just to typecheck a handler.
//
// This entry re-exports ONLY those core authoring types, so a worker module (e.g. a scaffolded
// stub, ADR 0056) typechecks on Node or Deno, with or without `skipLibCheck`, and never needs
// `@types/node`. It is types-only: nothing here emits runtime code.
//
// (One caveat: `AppApi.sdk` exposes the full `@nanobpm/nano-sdk` client by design, so the
// handler surface also reaches the SDK's types. Those are kept node-free by the
// `@nanobpm/nano-sdk` >= 1.2.2 floor in package.json — see ADR 0056.)

export type { AppJobHandler } from "./runtime/core/modules/workers.ts";
export type { EngineJob, JobHandler } from "./runtime/core/host.ts";
export type { AppApi } from "./runtime/core/context.ts";
export type { Logger, LogLevel, LogFields } from "./runtime/core/logger.ts";
