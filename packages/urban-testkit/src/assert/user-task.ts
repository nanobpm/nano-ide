// `assertThatUserTask` — fluent assertions over the user task(s) a selector picks.
//
// The matcher implementation now lives in `@nanobpm/engine-testkit` (issue
// Magikcraft/nano-bpm#894, S2), reading the structural `EngineReadModel` port's
// user-task channel (`searchUserTasks` / `openUserTasks`). urban-testkit adapts
// the app onto that port via `engineReadModel(app)` (user-task reads flow through
// `app.engine`), so the assignee/candidate-group narrowing and CREATED/COMPLETED
// semantics are unchanged.
import { assertThatUserTask as assertThatUserTaskOnEngine } from "@nanobpm/engine-testkit";
import type { UserTaskAssert, UserTaskSelector } from "@nanobpm/engine-testkit";
import type { TestApp } from "../boot-app.ts";
import { engineReadModel } from "./engine-read-model.ts";

/** Assert over the user task(s) selected by `selector`, reading the engine read model. */
export function assertThatUserTask(app: TestApp, selector: UserTaskSelector): UserTaskAssert {
  return assertThatUserTaskOnEngine(engineReadModel(app), selector);
}
