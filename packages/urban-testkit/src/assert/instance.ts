// `assertThatInstance` — fluent assertions over a single process instance.
//
// The matcher implementation now lives in `@nanobpm/engine-testkit` (issue
// Magikcraft/nano-bpm#894, S2), defined against the structural `EngineReadModel`
// port so it is reusable beyond Urban apps. urban-testkit keeps its
// `TestApp`-based public API by forwarding the app's WASM engine — which
// satisfies the port — to the lifted matcher. The failure-message behaviour,
// selectors and incident handling are unchanged; they are simply sourced from
// their single canonical home.
import { assertThatInstance as assertThatInstanceOnEngine } from "@nanobpm/engine-testkit";
import type { InstanceAssert, InstanceSelector } from "@nanobpm/engine-testkit";
import type { TestApp } from "../boot-app.ts";
import { engineReadModel } from "./engine-read-model.ts";

/** Assert over a single process instance, resolved from `keyOrSelector`
 *  (a bare key, `byKey(...)`, `byProcessId(...)`, or omitted for the single
 *  ACTIVE instance). */
export function assertThatInstance(
  app: TestApp,
  keyOrSelector?: string | InstanceSelector,
): InstanceAssert {
  return assertThatInstanceOnEngine(engineReadModel(app), keyOrSelector);
}
