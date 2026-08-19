// Full end-to-end test for your Urban app, powered by @nanobpm/urban-testkit.
//
// `bootTestApp` boots the WHOLE app in-process — the WASM engine, your SQLite
// migrations, your workers, and the OpenAPI operation surface — against a virtual
// clock. No server is started, no port is opened, and no wall-clock is waited on,
// so it's fast and deterministic in CI.
//
// This drives the starter "greeting" pipeline end to end:
//
//   POST /greetings (createGreeting) ─▶ engine.publishMessage ─▶ greet.bpmn
//     ─▶ workers/greet.ts inserts a row ─▶ GET /greetings (listGreetings) shows it.
//
// The assertions use the fluent `assertThat*` DSL: `assertThatResponse` reads the
// HTTP responses, `assertThatInstance` reads the engine's process state, and
// `assertThatDb` reads the app's SQLite — three windows onto the same run, each
// throwing an intent-revealing error on mismatch.
//
// Then it asserts the S4 coverage gate: every OpenAPI operation and every declared
// worker was exercised. Add your own operations/workers and this gate fails until a
// test drives them — turning "we forgot to test X" into a build failure.
//
// Run it with `npm test`.

import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import {
  assertThatDb,
  assertThatInstance,
  assertThatResponse,
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
    dbDir = mkdtempSync(join(tmpdir(), "urban-e2e-"));
    app = await bootTestApp(APP_ROOT, {
      env: { NANO_APP_DB_URL: `file:${join(dbDir, "app.db")}` },
      // Enable the S4 coverage gate: pre-declares this app's operations (from openapi.yaml)
      // and workers (from nano.app.json), and records each as the test exercises it.
      coverage: true,
    });
    // This app declares an `api` binding, so the spec-driven operations driver is present.
    assert.ok(app.api, "app.api should be defined (nano.app.json declares an `api` binding)");
  });

  after(async () => {
    await app?.stop();
    if (dbDir) rmSync(dbDir, { recursive: true, force: true });
  });

  test("records a greeting through the full POST → process → worker → GET pipeline", async () => {
    // `app` is optional (assigned in `before()`); narrow it once here so the rest of the test
    // reads a definitely-present `TestApp` without optional chaining.
    assert.ok(app, "app was booted in before()");
    const api = app.api;
    assert.ok(api);

    // POST /greetings — publishes the greet message (returns 202 Accepted; the work is async).
    // `assertThatResponse` fluently checks the status AND the JSON body (a subset match — extra
    // keys are ignored) in one chain.
    const created = await api.call<{ accepted: boolean; who: string }>("createGreeting", {
      body: { who: "Ada" },
    });
    assertThatResponse(created).hasStatus(202).hasJson({ accepted: true, who: "Ada" });

    // Drive the app to a quiescent fixpoint: the message starts greet.bpmn, whose service task
    // dispatches to workers/greet.ts, which inserts the row — all at the current virtual instant.
    await app.settle();

    // Assert directly on the ENGINE: the `greet` instance ran to completion and exercised every
    // element of the pipeline — the message start event, the `Greet` service task, and the end
    // event. `byProcessId` selects the single instance of the deployed `greet` process.
    assertThatInstance(app, byProcessId("greet"))
      .hasCompleted()
      .hasCompletedElements("StartGreet", "Greet", "EndGreet")
      .hasNoIncident();

    // Assert directly on the DATABASE: the worker persisted exactly one greeting row holding the
    // composed message. `hasRow` is a subset match (the `id`/`createdAt` columns are ignored);
    // each matcher awaits a fresh read of the table.
    await assertThatDb(app).table("greetings").rowCount(1);
    await assertThatDb(app).table("greetings").hasRow({ who: "Ada", message: "Hello, Ada!" });

    // GET /greetings — the greeting the worker recorded is now visible over the API.
    const list = await api.call<{ greetings: Array<{ who: string; message: string }> }>(
      "listGreetings",
    );
    assertThatResponse(list)
      .hasStatus(200)
      .hasJson({ greetings: [{ who: "Ada", message: "Hello, Ada!" }] });

    // Coverage gate (S4): now that the pipeline has driven every surface, assert nothing was
    // left un-exercised. This fails — naming the un-exercised ids — the moment you add an
    // operation or worker without a test that drives it. Asserting it here (rather than in a
    // separate test) keeps the check self-contained: it doesn't depend on another test having
    // run first. Scope it with `assertFullCoverage({ surfaces: ["operations"] })` to gate only
    // some surfaces.
    //
    // Assert the gate is actually present before invoking it (no optional chaining): we booted
    // with `coverage: true`, so a missing `app.coverage` means the gate silently vanished
    // (misconfig or API drift). Fail loudly here rather than let the coverage check no-op away.
    assert.ok(app.coverage, "coverage gate is enabled (bootTestApp was called with { coverage: true })");
    app.coverage.assertFullCoverage();
  });
});
