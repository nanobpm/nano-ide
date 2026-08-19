// Adapt a booted Urban `TestApp` to the engine-testkit `EngineReadModel` port.
//
// The engine-facing `assertThat*` DSL was lifted into `@nanobpm/engine-testkit`
// (issue Magikcraft/nano-bpm#894, S2), where every matcher is a pure function of
// the structural `EngineReadModel` port — a process `snapshot()` plus a user-task
// read channel (`searchUserTasks` / `openUserTasks`). This adapter wires a
// `TestApp` onto that port, preserving the *exact* channels urban's matchers read
// before the lift:
//
//   • `snapshot()` delegates to `app.snapshot()` — NOT `app.engine.snapshot()`.
//     This is the seam tests deliberately override (`{ ...app, snapshot: () =>
//     fixed }`) to pin instance-matcher messages against a hand-authored
//     snapshot; reading the engine directly would bypass that override and make
//     those fixtures see an empty engine.
//   • the user-task channel delegates to `app.engine`, whose `searchUserTasks` /
//     `openUserTasks` are the read paths urban's `assertThatUserTask` always used.
//
// For a real booted app `app.snapshot()` is literally `() => app.engine.snapshot()`
// (see `boot-app.ts`), so this introduces no re-derivation or drift — it simply
// keeps the overridable seam that the DSL, and its tests, have always read.
import type { EngineReadModel, UserTaskQuery, UserTaskRow } from "@nanobpm/engine-testkit";
import type { TestApp } from "../boot-app.ts";

/** The engine read model the `assertThat*` matchers assert over, taken from a
 *  booted app: instance reads flow through the overridable `app.snapshot()` seam,
 *  user-task reads through the app's WASM engine. */
export function engineReadModel(app: TestApp): EngineReadModel {
  return {
    snapshot: () => app.snapshot(),
    searchUserTasks: (query: UserTaskQuery): Promise<readonly UserTaskRow[]> =>
      app.engine.searchUserTasks(query),
    openUserTasks: (query: UserTaskQuery): Promise<readonly UserTaskRow[]> =>
      app.engine.openUserTasks(query),
  };
}
