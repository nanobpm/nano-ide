// Full end-to-end test for your code-first Urban app, powered by @nanobpm/urban-testkit.
//
// `bootTestApp` boots the app in-process — the WASM engine, your SQLite migrations, and
// the process derived from your `defineFlow` (`urban gen` emits it into
// `resources/processes/`, which deploy-by-convention picks up) — against a virtual clock.
// No server is started, no port is opened, and no wall-clock is waited on, so it's fast and
// deterministic in CI.
//
// This drives the starter "greeting" pipeline: it starts a `greet` instance, lets it run to
// its `hello` service task, and asserts the result with the fluent `assertThat*` DSL —
// `assertThatInstance(...)` reads the engine's process state and `assertThatDb(...)` reads the
// app's SQLite. (A code-first app has no OpenAPI `api` binding, so there is no HTTP response to
// `assertThatResponse` over, and this starter flow has no user task to `assertThatUserTask` on —
// add either and the matching matcher slots in the same way.)
//
// One wrinkle worth knowing: `bootTestApp` hosts the app's *manifest* surface, but a code-first
// app hosts its `w.run` worker itself in `main.ts` (via `@nanobpm/workflow`'s `Worker`), which
// `bootTestApp` does NOT run. So we stand that worker in with `app.mockWorker("greet:hello")` —
// completing the service task with the message a real run would return — and seed the greeting the
// worker would have written, letting us showcase the engine- AND database-level assertions.
// When you move persistence into a manifest worker (or assert against a real write), drop the
// mock/seed and assert `hasRow(...)` on the row your handler inserts.
//
// Then it asserts the S4 coverage gate: every declared worker was exercised. Add another service
// task and this gate fails until a test drives it — turning "we forgot to test X" into a build
// failure.
//
// Run it with `npm test` (Node) or `deno task test` (Deno).

import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import {
  assertThatDb,
  assertThatInstance,
  bootTestApp,
  byProcessId,
  type TestApp,
} from "@nanobpm/urban-testkit";

// The app root is this repo's root (one level up from `tests/`).
const APP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

describe("app e2e (urban-testkit)", () => {
  // Optional because they're only assigned in `before()`. Under `strict` (the template's
  // `typecheck` script runs `tsc --noEmit`) a non-optional `let app: TestApp;` read from a
  // closure trips TS2454 "used before being assigned"; modelling the lifecycle as optional is
  // the honest type. The test narrows `app` with `assert.ok` before use.
  let app: TestApp | undefined;
  // Provision the app's SQLite in a throwaway temp dir so tests never touch (or leak into)
  // your real ./db/app.db, and every run starts from a freshly-migrated, empty schema. Created
  // in `before()` (not at module load) so a filtered/skipped run has no filesystem side effects.
  // The harness resolves the manifest's `${NANO_APP_DB_URL}` from this env overlay.
  let dbDir: string | undefined;

  before(async () => {
    dbDir = mkdtempSync(join(tmpdir(), "urban-cf-e2e-"));
    app = await bootTestApp(APP_ROOT, {
      env: { NANO_APP_DB_URL: `file:${join(dbDir, "app.db")}` },
      // Enable the S4 coverage gate: pre-declares this app's workers (the service tasks of the
      // derived process) and records each as the test exercises it.
      coverage: true,
      // Stand in for the write the code-first `w.run` worker (hosted in main.ts) performs — see
      // the file header. Persisting it here lets `assertThatDb` read a real row.
      seed: async (db) => {
        await db.table("greetings", "id").insert({
          who: "Ada",
          message: "Hello, Ada!",
          createdAt: new Date().toISOString(),
        });
      },
    });
  });

  after(async () => {
    await app?.stop();
    if (dbDir) rmSync(dbDir, { recursive: true, force: true });
  });

  test("runs a greeting through the derived greet flow", async () => {
    // `app` is optional (assigned in `before()`); narrow it once here so the rest of the test
    // reads a definitely-present `TestApp` without optional chaining.
    assert.ok(app, "app was booted in before()");

    // Stand in for the code-first worker (hosted by main.ts, not by bootTestApp): complete the
    // `hello` service task with the message a real run returns, so the instance drains to
    // completion under the virtual clock.
    app.mockWorker("greet:hello").completeWith({ message: "Hello, Ada!" });

    // Start a `greet` instance — the code-first equivalent of `WorkflowClient.start(greet, {...})`
    // in scripts/greet.ts, driven straight through the in-process engine.
    await app.engine.createInstance({
      processDefinitionId: "greet",
      variables: { who: "Ada" },
    });

    // Drive the app to a quiescent fixpoint: the instance advances through its `hello` service
    // task (served by the mock) to the end event — all at the current virtual instant.
    await app.settle();

    // Assert directly on the ENGINE: the `greet` instance ran to completion and exercised every
    // element of the flow — the start event, the `hello` service task, and the end event.
    // `byProcessId` selects the single instance of the deployed `greet` process.
    assertThatInstance(app, byProcessId("greet"))
      .hasCompleted()
      .hasCompletedElements("Start", "hello", "End")
      .hasNoIncident();

    // Assert directly on the DATABASE: the greeting is recorded exactly once and holds the composed
    // message. `hasRow` is a subset match (the `id`/`createdAt` columns are ignored); each matcher
    // awaits a fresh read of the table.
    await assertThatDb(app).table("greetings").rowCount(1);
    await assertThatDb(app).table("greetings").hasRow({ who: "Ada", message: "Hello, Ada!" });

    // Coverage gate (S4): now that the pipeline has driven every declared worker, assert nothing was
    // left un-exercised. This fails — naming the un-exercised ids — the moment you add a service task
    // without a test that drives it. Asserting it here (rather than in a separate test) keeps the
    // check self-contained: it doesn't depend on another test having run first.
    //
    // Assert the gate is actually present before invoking it (no optional chaining): we booted with
    // `coverage: true`, so a missing `app.coverage` means the gate silently vanished (misconfig or
    // API drift). Fail loudly here rather than let the coverage check no-op away.
    assert.ok(app.coverage, "coverage gate is enabled (bootTestApp was called with { coverage: true })");
    app.coverage.assertFullCoverage();
  });
});
