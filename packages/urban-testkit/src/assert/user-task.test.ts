// Red/Green coverage for `assertThatUserTask` (the `usertask-assert` slice).
//
// Boots a real Urban app in-process via `bootTestApp` against the WASM engine + virtual
// clock, drives a small BPMN with a native user task carrying an assignee and candidate
// groups, and proves EVERY matcher both PASSES on its positive case and FAILS (throwing an
// intent-revealing AssertionError) on its negative case. Deterministic: no wall-clock, no
// polling — every read is a synchronous read-model query.

import assert from "node:assert/strict";
import { AssertionError } from "node:assert";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { assertThatUserTask } from "./user-task.ts";
import { byKey, byProcessId } from "./selectors.ts";
import { bootTestApp, type TestApp } from "../boot-app.ts";

// A process that parks on a single native user task assigned to `alice` and offered to the
// `reviewers` / `managers` candidate groups.
const REVIEW_BPMN = `<?xml version="1.0" encoding="UTF-8"?>
<definitions xmlns="http://www.omg.org/spec/BPMN/20100524/MODEL"
             xmlns:zeebe="http://camunda.org/schema/zeebe/1.0"
             targetNamespace="http://nanobpm/testkit">
  <process id="review" isExecutable="true">
    <startEvent id="s"/>
    <sequenceFlow id="f1" sourceRef="s" targetRef="approve"/>
    <userTask id="approve">
      <extensionElements>
        <zeebe:userTask/>
        <zeebe:assignmentDefinition assignee="alice" candidateGroups="reviewers,managers"/>
      </extensionElements>
    </userTask>
    <sequenceFlow id="f2" sourceRef="approve" targetRef="e"/>
    <endEvent id="e"/>
  </process>
</definitions>`;

const MIGRATION = `CREATE TABLE marker (id INTEGER PRIMARY KEY);`;

/** Build a minimal Urban app on disk: one user-task process plus a SQLite source (a data
 *  layer is required by `bootTestApp`). */
async function makeFixture(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "urban-testkit-usertask-"));
  await mkdir(join(dir, "processes"), { recursive: true });
  await mkdir(join(dir, "db", "migrations"), { recursive: true });
  await writeFile(join(dir, "processes", "review.bpmn"), REVIEW_BPMN);
  await writeFile(join(dir, "db", "migrations", "001_init.sql"), MIGRATION);
  const manifest = {
    schemaVersion: 1,
    id: "testkit-usertask-fixture",
    name: "Testkit UserTask Fixture",
    models: { processes: ["processes/*.bpmn"] },
    data: {
      default: "app",
      sources: {
        app: { driver: "sqlite", url: "file:./db/app.db", migrations: "db/migrations" },
      },
    },
  };
  await writeFile(join(dir, "nano.app.json"), JSON.stringify(manifest, null, 2));
  return dir;
}

/** Start a `review` instance (parks CREATED at the `approve` user task) and return its key. */
async function startReview(app: TestApp): Promise<string> {
  const { processInstanceKey } = await app.engine.createInstance({ processDefinitionId: "review" });
  return processInstanceKey;
}

/** Assert `fn` throws a `node:assert` AssertionError whose message contains each `needle`. */
async function rejectsWith(fn: () => Promise<unknown>, ...needles: string[]): Promise<void> {
  await assert.rejects(fn, (err: unknown) => {
    assert.ok(err instanceof AssertionError, `expected an AssertionError, got ${String(err)}`);
    for (const needle of needles) {
      assert.ok(
        err.message.includes(needle),
        `expected failure message to include ${JSON.stringify(needle)}, got:\n${err.message}`,
      );
    }
    return true;
  });
}

test("assertThatUserTask.isCreated: passes for an open task, fails for a completed one", async () => {
  const dir = await makeFixture();
  const app = await bootTestApp(dir);
  try {
    const key = await startReview(app);

    // GREEN: the task is open (CREATED).
    await assertThatUserTask(app, { instance: key, elementId: "approve" }).isCreated();

    // Complete the task; the instance completes and the task leaves the open set.
    const open = await app.engine.searchUserTasks({ processInstanceKey: key, state: "CREATED" });
    assert.equal(open.length, 1);
    await app.engine.completeUserTask(open[0].userTaskKey);

    // RED: the completed task is no longer CREATED.
    await rejectsWith(
      () => assertThatUserTask(app, { instance: key, elementId: "approve" }).isCreated(),
      "to be CREATED",
      "state: COMPLETED",
    );
  } finally {
    await app.stop();
    await rm(dir, { recursive: true, force: true });
  }
});

test("assertThatUserTask.isCompleted: passes for a completed task, fails for an open one", async () => {
  const dir = await makeFixture();
  const app = await bootTestApp(dir);
  try {
    const key = await startReview(app);

    // RED: the task is still open — not COMPLETED.
    await rejectsWith(
      () => assertThatUserTask(app, { instance: key, elementId: "approve" }).isCompleted(),
      "to be COMPLETED",
      "state: CREATED",
    );

    // Complete it.
    const open = await app.engine.searchUserTasks({ processInstanceKey: key, state: "CREATED" });
    await app.engine.completeUserTask(open[0].userTaskKey);

    // GREEN: now COMPLETED.
    await assertThatUserTask(app, { instance: key, elementId: "approve" }).isCompleted();
  } finally {
    await app.stop();
    await rm(dir, { recursive: true, force: true });
  }
});

test("assertThatUserTask.hasAssignee: passes for the real assignee, fails otherwise", async () => {
  const dir = await makeFixture();
  const app = await bootTestApp(dir);
  try {
    const key = await startReview(app);

    // GREEN: the task is assigned to alice.
    await assertThatUserTask(app, { instance: key, elementId: "approve" }).hasAssignee("alice");

    // RED: not assigned to bob — the message names bob and the actual matching task.
    await rejectsWith(
      () => assertThatUserTask(app, { instance: key, elementId: "approve" }).hasAssignee("bob"),
      '"bob"',
      "elementId: \"approve\"",
    );
  } finally {
    await app.stop();
    await rm(dir, { recursive: true, force: true });
  }
});

test("assertThatUserTask.hasCandidateGroup: passes for an offered group, fails otherwise", async () => {
  const dir = await makeFixture();
  const app = await bootTestApp(dir);
  try {
    const key = await startReview(app);

    // GREEN: both declared candidate groups match.
    await assertThatUserTask(app, { instance: key, elementId: "approve" }).hasCandidateGroup(
      "reviewers",
    );
    await assertThatUserTask(app, { instance: key, elementId: "approve" }).hasCandidateGroup(
      "managers",
    );

    // RED: an undeclared group does not match.
    await rejectsWith(
      () =>
        assertThatUserTask(app, { instance: key, elementId: "approve" }).hasCandidateGroup("nope"),
      '"nope"',
      "candidate group",
    );
  } finally {
    await app.stop();
    await rm(dir, { recursive: true, force: true });
  }
});

test("assertThatUserTask: selectors (byKey / byProcessId / elementId) and chaining", async () => {
  const dir = await makeFixture();
  const app = await bootTestApp(dir);
  try {
    const key = await startReview(app);

    // byKey selector resolves the same task as the bare key.
    await assertThatUserTask(app, { instance: byKey(key), elementId: "approve" }).isCreated();

    // byProcessId selector (single instance of `review` → unambiguous).
    await assertThatUserTask(app, { instance: byProcessId("review"), elementId: "approve" })
      .isCreated();

    // elementId-only selector (no instance) matches across the app's single task.
    await assertThatUserTask(app, { elementId: "approve" }).isCreated();

    // Chaining: await each async matcher in turn on the same fluent object.
    const a = assertThatUserTask(app, { instance: key, elementId: "approve" });
    await (await (await a.isCreated()).hasAssignee("alice")).hasCandidateGroup("reviewers");
  } finally {
    await app.stop();
    await rm(dir, { recursive: true, force: true });
  }
});

test("assertThatUserTask: an unresolvable selector fails clearly", async () => {
  const dir = await makeFixture();
  const app = await bootTestApp(dir);
  try {
    await startReview(app);

    // No task for element `ghost` → isCreated fails naming the selector.
    await rejectsWith(
      () => assertThatUserTask(app, { elementId: "ghost" }).isCreated(),
      "elementId \"ghost\"",
      "no user task matches",
    );

    // An instance key that does not exist → the shared resolver throws.
    await rejectsWith(
      () => assertThatUserTask(app, { instance: "does-not-exist" }).isCreated(),
      "Could not resolve a process instance",
    );
  } finally {
    await app.stop();
    await rm(dir, { recursive: true, force: true });
  }
});
