// Completeness guard for the `assertThat*` DSL (issue #295, wave 2).
//
// Mirrors the philosophy of the S4 coverage gate (`src/coverage.ts` /
// `coverage-gate.test.ts`): every state / surface IN THE DSL'S DECLARED SCOPE
// must have a corresponding matcher, so adding a new in-scope engine state or
// Urban surface without a matcher fails CI. Four dimensions, and no others (we do
// NOT invent a dimension for a type the repo does not define):
//
//   (a) PROCESS-INSTANCE STATE — FULL DERIVATION from `ProcessInstanceState`.
//   (b) ELEMENT-STATE KINDS    — EXPLICIT {active, completed} allowlist.
//   (c) USER-TASK STATE        — EXPLICIT {CREATED, COMPLETED} allowlist.
//   (d) URBAN SURFACES         — {SQLite table, HTTP response}.
//
// (a) and (c)/(b) differ deliberately: where a source-of-truth union exists and
// the DSL covers ALL of it (process-instance state) the guard DERIVES from the
// union so a new member fails tsc/CI; where the DSL deliberately covers only PART
// of a surface (user-task state) or the repo defines NO enum at all (element
// state) the guard uses an explicit, commented allowlist that maps EXACTLY onto
// the shipped matchers — it must never demand a matcher the DSL intentionally
// omits.
//
// This is a NEW guard file (wave 2); it does not modify any matcher.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { UserTaskState } from "@nanobpm/urban/runtime";
import { bootTestApp, type TestApp } from "../boot-app.ts";
import type { ProcessInstanceState } from "../wasm-engine.ts";
import { assertThatInstance, type InstanceAssert } from "./instance.ts";
import { assertThatUserTask, type UserTaskAssert } from "./user-task.ts";
import { assertThatDb } from "./db.ts";
import { assertThatResponse } from "./response.ts";
import type { ApiResponse } from "../openapi-driver.ts";

// ---------------------------------------------------------------------------
// (a) PROCESS-INSTANCE STATE — FULL DERIVATION.
//
// `Record<ProcessInstanceState, keyof InstanceAssert>` makes this map EXHAUSTIVE
// over the union and TYPE-CHECKED against the matcher names: adding a new
// `ProcessInstanceState` member (e.g. "SUSPENDED") without a matcher fails `tsc`
// with a missing-key error, and renaming a state matcher fails because the value
// is no longer `keyof InstanceAssert`. The guard thus tracks the union at the
// type level, not via a duplicated literal list.
const PROCESS_INSTANCE_STATE_MATCHERS = {
  ACTIVE: "isActive",
  COMPLETED: "hasCompleted",
  TERMINATED: "isTerminated",
} satisfies Record<ProcessInstanceState, keyof InstanceAssert>;

// ---------------------------------------------------------------------------
// (b) ELEMENT-STATE KINDS — EXPLICIT {active, completed} SCOPE (NOT a derivation).
//
// There is deliberately NO repo-wide element-state enum to enumerate, so this is
// NOT derived from a type — `assertThatInstance` intentionally supports exactly
// two element lifecycle kinds, ACTIVE and COMPLETED, and no others. This
// commented allowlist is the DSL's intentional supported element-state scope; it
// maps exactly onto the shipped matchers and must not demand element matchers the
// DSL never builds (do NOT try to import/derive an `ElementInstanceState` type —
// none exists).
const ELEMENT_STATE_MATCHERS: Readonly<Record<"active" | "completed", readonly (keyof InstanceAssert)[]>> = {
  active: ["hasActiveElement", "hasActiveElements"],
  completed: ["hasCompletedElements"],
};

// ---------------------------------------------------------------------------
// (c) USER-TASK STATE — EXPLICIT, JUSTIFIED {CREATED, COMPLETED} ALLOWLIST.
//
// `UserTaskState` is a 4-member union (CREATED | COMPLETED | CANCELED | FAILED),
// but the DSL deliberately exposes state matchers for only the two states an
// integration test asserts on. CANCELED and FAILED are intentionally OUT OF
// SCOPE — no `isCanceled()` / `isFailed()` — so this allowlist is NOT derived
// from the full union (deriving from it would wrongly fail CI for the omitted
// states). `Partial<Record<UserTaskState, …>>` still type-checks that each
// allow-listed key is a genuine `UserTaskState` member (a typo like "CREATE"
// fails tsc) without forcing exhaustiveness. This set MUST stay in lockstep with
// the {CREATED, COMPLETED} scope declared in `assert/user-task.ts`.
const USER_TASK_STATE_MATCHERS = {
  CREATED: "isCreated",
  COMPLETED: "isCompleted",
} satisfies Partial<Record<UserTaskState, keyof UserTaskAssert>>;

// ---------------------------------------------------------------------------
// (d) URBAN SURFACES — the two surfaces the process-engine DSL has no analog for.
const URBAN_SURFACES = {
  sqliteTable: "assertThatDb",
  httpResponse: "assertThatResponse",
} as const;

/** True when `obj` exposes `name` as a callable matcher method. Uses `Reflect.get`
 *  so no `as`-cast is needed to index by a dynamic key. */
function hasMatcher(obj: object, name: string): boolean {
  return typeof Reflect.get(obj, name) === "function";
}

// A single service task with no worker → the instance parks ACTIVE at `work`, so
// `assertThatInstance(app)` (single-ACTIVE convenience) resolves a real object we
// can introspect. The completeness guard reasons over object SHAPE, not verdicts.
const PARK_BPMN = `<?xml version="1.0" encoding="UTF-8"?>
<definitions xmlns="http://www.omg.org/spec/BPMN/20100524/MODEL"
             xmlns:zeebe="http://camunda.org/schema/zeebe/1.0"
             targetNamespace="http://nanobpm/testkit">
  <process id="park" isExecutable="true">
    <startEvent id="s"/>
    <sequenceFlow id="f1" sourceRef="s" targetRef="work"/>
    <serviceTask id="work">
      <extensionElements><zeebe:taskDefinition type="park.work"/></extensionElements>
    </serviceTask>
    <sequenceFlow id="f2" sourceRef="work" targetRef="e"/>
    <endEvent id="e"/>
  </process>
</definitions>`;

const NOOP_MIGRATION = "CREATE TABLE marker (id INTEGER PRIMARY KEY);";

async function makeFixture(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "urban-testkit-completeness-"));
  await mkdir(join(dir, "db", "migrations"), { recursive: true });
  await writeFile(join(dir, "db", "migrations", "001_init.sql"), NOOP_MIGRATION);
  const manifest = {
    schemaVersion: 1,
    id: "testkit-completeness-fixture",
    name: "Testkit Completeness Fixture",
    data: {
      default: "app",
      sources: { app: { driver: "sqlite", url: "file:./db/app.db", migrations: "db/migrations" } },
    },
  };
  await writeFile(join(dir, "nano.app.json"), JSON.stringify(manifest, null, 2));
  return dir;
}

async function withActiveApp(body: (app: TestApp) => Promise<void>): Promise<void> {
  const dir = await makeFixture();
  const app = await bootTestApp(dir);
  try {
    await app.engine.deployResources([
      { name: "park.bpmn", content: PARK_BPMN, contentType: "application/bpmn+xml" },
    ]);
    // No worker registered → the instance parks ACTIVE at `work`.
    await app.engine.createInstance({ processDefinitionId: "park" });
    await body(app);
  } finally {
    await app.stop();
    await rm(dir, { recursive: true, force: true });
  }
}

/** A trivially-constructed resolved response, enough to introspect the fluent
 *  `ResponseAssert` shape (the matcher is a pure function of an `ApiResponse`). */
function sampleResponse(): ApiResponse<Record<string, unknown>> {
  return { status: 200, headers: new Headers(), text: "", body: {} };
}

test("(a) every ProcessInstanceState member has an assertThatInstance state matcher", async () => {
  await withActiveApp(async (app) => {
    const instance = assertThatInstance(app);
    // Derived from the union via the `satisfies Record<ProcessInstanceState, …>`
    // map above — a new member without a matcher already fails tsc; here we also
    // prove each derived matcher name is a real callable method at runtime.
    const states = Object.keys(PROCESS_INSTANCE_STATE_MATCHERS);
    assert.deepEqual(
      [...states].sort(),
      ["ACTIVE", "COMPLETED", "TERMINATED"],
      "the ProcessInstanceState union must map to exactly {ACTIVE, COMPLETED, TERMINATED}",
    );
    for (const [state, matcher] of Object.entries(PROCESS_INSTANCE_STATE_MATCHERS)) {
      assert.ok(
        hasMatcher(instance, matcher),
        `assertThatInstance must expose \`${matcher}()\` for ProcessInstanceState ${state}`,
      );
    }
  });
});

test("(b) each supported element-state kind {active, completed} has an assertThatInstance matcher", async () => {
  await withActiveApp(async (app) => {
    const instance = assertThatInstance(app);
    assert.deepEqual(
      Object.keys(ELEMENT_STATE_MATCHERS).sort(),
      ["active", "completed"],
      "the DSL's supported element-state scope is exactly {active, completed}",
    );
    for (const [kind, matchers] of Object.entries(ELEMENT_STATE_MATCHERS)) {
      for (const matcher of matchers) {
        assert.ok(
          hasMatcher(instance, matcher),
          `assertThatInstance must expose \`${matcher}()\` for element-state kind ${kind}`,
        );
      }
    }
  });
});

test("(c) each allow-listed user-task state {CREATED, COMPLETED} has an assertThatUserTask matcher", async () => {
  await withActiveApp(async (app) => {
    const userTask = assertThatUserTask(app, {});
    assert.deepEqual(
      Object.keys(USER_TASK_STATE_MATCHERS).sort(),
      ["COMPLETED", "CREATED"],
      "the DSL's supported user-task state scope is exactly {CREATED, COMPLETED} (CANCELED/FAILED are intentionally omitted)",
    );
    for (const [state, matcher] of Object.entries(USER_TASK_STATE_MATCHERS)) {
      assert.ok(
        hasMatcher(userTask, matcher),
        `assertThatUserTask must expose \`${matcher}()\` for user-task state ${state}`,
      );
    }
    // The intentionally-unsupported states must NOT have matchers — otherwise the
    // {CREATED, COMPLETED} scope declared here and in user-task.ts has drifted.
    for (const omitted of ["isCanceled", "isFailed"]) {
      assert.ok(
        !hasMatcher(userTask, omitted),
        `assertThatUserTask must NOT expose \`${omitted}()\` — CANCELED/FAILED are out of scope by design`,
      );
    }
  });
});

test("(d) both Urban surfaces {SQLite table, HTTP response} are covered", async () => {
  await withActiveApp(async (app) => {
    assert.deepEqual(
      Object.keys(URBAN_SURFACES).sort(),
      ["httpResponse", "sqliteTable"],
      "the DSL declares exactly two Urban surfaces: a SQLite table and an HTTP response",
    );

    // SQLite table: assertThatDb(app).table(name) → { hasRow, rowCount, isEmpty }.
    const table = assertThatDb(app).table("marker");
    for (const matcher of ["hasRow", "rowCount", "isEmpty"]) {
      assert.ok(hasMatcher(table, matcher), `assertThatDb().table() must expose \`${matcher}()\``);
    }

    // HTTP response: assertThatResponse(res) → { hasStatus, hasJson, hasHeader }.
    const response = assertThatResponse(sampleResponse());
    for (const matcher of ["hasStatus", "hasJson", "hasHeader"]) {
      assert.ok(hasMatcher(response, matcher), `assertThatResponse() must expose \`${matcher}()\``);
    }
  });
});
