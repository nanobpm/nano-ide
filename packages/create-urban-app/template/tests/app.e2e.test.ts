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
import { bootTestApp, type TestApp } from "@nanobpm/urban-testkit";

// The app root is this repo's root (one level up from `tests/`).
const APP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// Provision the app's SQLite in a throwaway temp dir so tests never touch (or leak into)
// your real ./db/app.db, and every run starts from a freshly-migrated, empty schema. The
// harness resolves the manifest's `${NANO_APP_DB_URL}` from this env overlay.
const DB_DIR = mkdtempSync(join(tmpdir(), "urban-e2e-"));

describe("app e2e (urban-testkit)", () => {
  let app: TestApp;

  before(async () => {
    app = await bootTestApp(APP_ROOT, {
      env: { NANO_APP_DB_URL: `file:${join(DB_DIR, "app.db")}` },
      // Enable the S4 coverage gate: pre-declares this app's operations (from openapi.yaml)
      // and workers (from nano.app.json), and records each as the test exercises it.
      coverage: true,
    });
    // This app declares an `api` binding, so the spec-driven operations driver is present.
    assert.ok(app.api, "app.api should be defined (nano.app.json declares an `api` binding)");
  });

  after(async () => {
    await app?.stop();
    rmSync(DB_DIR, { recursive: true, force: true });
  });

  test("records a greeting through the full POST → process → worker → GET pipeline", async () => {
    const api = app.api;
    assert.ok(api);

    // POST /greetings — publishes the greet message (returns 202 Accepted; the work is async).
    const created = await api.call<{ accepted: boolean; who: string }>("createGreeting", {
      body: { who: "Ada" },
    });
    assert.equal(created.status, 202, "createGreeting returns 202 Accepted");
    assert.equal(created.body.who, "Ada");

    // Drive the app to a quiescent fixpoint: the message starts greet.bpmn, whose service task
    // dispatches to workers/greet.ts, which inserts the row — all at the current virtual instant.
    await app.settle();

    // GET /greetings — the greeting the worker recorded is now visible.
    const list = await api.call<{ greetings: Array<{ who: string; message: string }> }>(
      "listGreetings",
    );
    assert.equal(list.status, 200, "listGreetings returns 200 OK");
    assert.equal(list.body.greetings.length, 1, "exactly one greeting was recorded");
    assert.equal(list.body.greetings[0].who, "Ada");
    assert.equal(list.body.greetings[0].message, "Hello, Ada!", "the worker composed the message");

    // Coverage gate (S4): now that the pipeline has driven every surface, assert nothing was
    // left un-exercised. This fails — naming the un-exercised ids — the moment you add an
    // operation or worker without a test that drives it. Asserting it here (rather than in a
    // separate test) keeps the check self-contained: it doesn't depend on another test having
    // run first. Scope it with `assertFullCoverage({ surfaces: ["operations"] })` to gate only
    // some surfaces.
    app.coverage?.assertFullCoverage();
  });
});
