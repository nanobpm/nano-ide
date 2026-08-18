// Failure-message regression for the `assertThat*` DSL (issue #295, wave 2).
//
// The whole value of these matchers is an intent-revealing failure message that
// NAMES the actual state / elements / variables / rows / status. This suite pins
// the EXACT message of a failing case for EVERY matcher across all four DSL files
// (`instance.ts`, `user-task.ts`, `db.ts`, `response.ts`) against an inline
// expected string, so a change to the diff/format turns red and must be reviewed.
//
// Determinism: the messages are made byte-stable by CONTROLLING the inputs —
//   • instance matchers read a hand-authored snapshot (fixed keys) via a doctored
//     `app.snapshot()`, the same override the instance slice's own tests use;
//   • db matchers read explicitly-keyed seeded rows;
//   • response matchers read constructed `ApiResponse` values;
//   • user-task matchers read the real engine read model, whose only dynamic
//     values (the numeric process-instance and user-task keys) are normalised to
//     `<PIK>` / `<UTK>` placeholders before the comparison.
// The repo has no snapshot-file harness, so we assert against inline strings (the
// documented fallback). This is a NEW test file (wave 2); no matcher is modified.

import { test } from "node:test";
import assert from "node:assert/strict";
import { AssertionError } from "node:assert";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bootTestApp, type TestApp } from "../boot-app.ts";
import type { ApiResponse } from "../openapi-driver.ts";
import { assertThatInstance } from "./instance.ts";
import { assertThatUserTask } from "./user-task.ts";
import { assertThatDb } from "./db.ts";
import { assertThatResponse } from "./response.ts";

/** Run a synchronous matcher expected to fail and return its `AssertionError`
 *  message (fails the test if it does not throw an `AssertionError`). */
function messageOf(fn: () => unknown): string {
  try {
    fn();
  } catch (err) {
    assert.ok(err instanceof AssertionError, `expected an AssertionError, got ${String(err)}`);
    return err.message;
  }
  throw new AssertionError({ message: "matcher did not throw on its failing case" });
}

/** Async counterpart of {@link messageOf} for the db / user-task matchers. */
async function messageOfAsync(fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn();
  } catch (err) {
    assert.ok(err instanceof AssertionError, `expected an AssertionError, got ${String(err)}`);
    return err.message;
  }
  throw new AssertionError({ message: "matcher did not throw on its failing case" });
}

// --- instance.ts — messages pinned against a doctored, fixed-key snapshot -------

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

async function makeFixture(migration: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "urban-testkit-msgreg-"));
  await mkdir(join(dir, "processes"), { recursive: true });
  await mkdir(join(dir, "db", "migrations"), { recursive: true });
  await writeFile(join(dir, "processes", "review.bpmn"), REVIEW_BPMN);
  await writeFile(join(dir, "db", "migrations", "001_init.sql"), migration);
  const manifest = {
    schemaVersion: 1,
    id: "testkit-msgreg-fixture",
    name: "Testkit Message-Regression Fixture",
    models: { processes: ["processes/*.bpmn"] },
    data: {
      default: "app",
      sources: { app: { driver: "sqlite", url: "file:./db/app.db", migrations: "db/migrations" } },
    },
  };
  await writeFile(join(dir, "nano.app.json"), JSON.stringify(manifest, null, 2));
  return dir;
}

/** A booted app with `snapshot()` swapped for a fixed, hand-authored one — the
 *  override the instance slice's own tests already use — so instance-matcher
 *  messages carry the fixed key `PI-1` and are byte-deterministic. */
function withSnapshot(app: TestApp, snapshot: Record<string, unknown>): TestApp {
  return { ...app, snapshot: () => snapshot };
}

test("instance.ts — every matcher's failure message is pinned", async () => {
  const dir = await makeFixture("CREATE TABLE marker (id INTEGER PRIMARY KEY);");
  try {
    const app = await bootTestApp(dir);
    try {
      const active: Record<string, unknown> = {
        instances: [
          {
            key: "PI-1",
            state: "Active",
            processId: "order",
            variables: { who: "world", count: 3 },
            activeElements: [{ elementId: "work" }],
          },
        ],
        elementStats: [{ elementId: "work", active: 1, completed: 0 }],
      };
      const completed: Record<string, unknown> = {
        instances: [{ key: "PI-1", state: "Completed", processId: "order", variables: {} }],
      };
      const completedEl: Record<string, unknown> = {
        instances: [{ key: "PI-1", state: "Completed", processId: "order", variables: {} }],
        elementStats: [{ elementId: "work", active: 0, completed: 1 }],
      };
      const withIncident: Record<string, unknown> = {
        instances: [{ key: "PI-1", state: "Active", processId: "order", variables: {} }],
        incidents: [
          { instanceKey: "PI-1", elementId: "work", kind: "JOB_NO_RETRIES", reason: "kaboom", key: "INC-1" },
        ],
      };

      const at = (snapshot: Record<string, unknown>) => assertThatInstance(withSnapshot(app, snapshot), "PI-1");

      assert.equal(
        messageOf(() => at(completed).isActive()),
        'Expected instance "PI-1" to be ACTIVE, but it is COMPLETED.\n  expected: "ACTIVE"\n  actual:   "COMPLETED"',
      );
      assert.equal(
        messageOf(() => at(active).hasCompleted()),
        'Expected instance "PI-1" to be COMPLETED, but it is ACTIVE.\n  expected: "COMPLETED"\n  actual:   "ACTIVE"',
      );
      assert.equal(
        messageOf(() => at(active).isTerminated()),
        'Expected instance "PI-1" to be TERMINATED, but it is ACTIVE.\n  expected: "TERMINATED"\n  actual:   "ACTIVE"',
      );
      assert.equal(
        messageOf(() => at(active).hasActiveElement("ghost")),
        'Expected instance "PI-1" to have active element(s) ["ghost"], but its active elements are ["work"].\n  expected: ["ghost"]\n  actual:   ["work"]',
      );
      assert.equal(
        messageOf(() => at(active).hasActiveElements("work", "ghost")),
        'Expected instance "PI-1" to have active element(s) ["ghost"], but its active elements are ["work"].\n  expected: ["work", "ghost"]\n  actual:   ["work"]',
      );
      assert.equal(
        messageOf(() => at(completedEl).hasCompletedElements("ghost")),
        'Expected instance "PI-1" to have completed element(s) ["ghost"], but its completed elements are ["work"].\n  expected: ["ghost"]\n  actual:   ["work"]',
      );
      assert.equal(
        messageOf(() => at(active).hasVariable("who", "mars")),
        'Variable "who" on instance "PI-1" does not equal the expected value.\n  expected: "mars"\n  actual:   "world"',
      );
      assert.equal(
        messageOf(() => at(active).hasVariables({ count: 99 })),
        'Instance "PI-1" variables do not contain the expected subset.\n  expected: {"count": 99}\n  actual:   {"count": 3, "who": "world"}',
      );
      assert.equal(
        messageOf(() => at(active).hasNoVariable("who")),
        'Expected instance "PI-1" to have NO variable "who", but it is present with value "world".',
      );
      assert.equal(
        messageOf(() => at(withIncident).hasIncident({ elementId: "s" })),
        'Expected instance "PI-1" to have an incident matching {"elementId": "s"}, but its incidents are [{ elementId: "work", kind: "JOB_NO_RETRIES", reason: "kaboom" }].',
      );
      assert.equal(
        messageOf(() => at(withIncident).hasNoIncident()),
        'Expected instance "PI-1" to have no incidents, but found [{ elementId: "work", kind: "JOB_NO_RETRIES", reason: "kaboom" }].',
      );
    } finally {
      await app.stop();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// --- db.ts — messages pinned against explicitly-keyed seeded rows ---------------

test("db.ts — every matcher's failure message is pinned", async () => {
  const dir = await makeFixture("CREATE TABLE orders (id INTEGER PRIMARY KEY, item TEXT, status TEXT);");
  try {
    const app = await bootTestApp(dir);
    try {
      const orders = app.db.table<{ id: number; item: string; status: string }>("orders");
      await orders.insert({ id: 1, item: "widget", status: "packed" });
      await orders.insert({ id: 2, item: "gadget", status: "active" });

      assert.equal(
        await messageOfAsync(() => assertThatDb(app).table("orders").hasRow({ item: "widget", status: "active" })),
        'assertThatDb().table("orders").hasRow: no row matches the expected subset (2 row(s) in the table)\n' +
          '  expected: {"item": "widget", "status": "active"}\n' +
          '  actual:   [{"id": 1, "item": "widget", "status": "packed"}, {"id": 2, "item": "gadget", "status": "active"}]',
      );
      assert.equal(
        await messageOfAsync(() => assertThatDb(app).table("orders").rowCount(5)),
        'assertThatDb().table("orders").rowCount: expected 5 row(s) but found 2\n' +
          '  rows: [{"id": 1, "item": "widget", "status": "packed"}, {"id": 2, "item": "gadget", "status": "active"}]\n' +
          "  expected: 5\n  actual:   2",
      );
      assert.equal(
        await messageOfAsync(() => assertThatDb(app).table("orders").isEmpty()),
        'assertThatDb().table("orders").isEmpty: expected no rows but found 2\n' +
          '  rows: [{"id": 1, "item": "widget", "status": "packed"}, {"id": 2, "item": "gadget", "status": "active"}]\n' +
          "  expected: 0\n  actual:   2",
      );
    } finally {
      await app.stop();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// --- response.ts — messages pinned against constructed responses ----------------

function makeResponse<T>(parts: {
  status?: number;
  headers?: Record<string, string>;
  body: T;
}): ApiResponse<T> {
  return {
    status: parts.status ?? 200,
    headers: new Headers(parts.headers ?? {}),
    text: "",
    body: parts.body,
  };
}

test("response.ts — every matcher's failure message is pinned", () => {
  assert.equal(
    messageOf(() => assertThatResponse(makeResponse({ status: 200, body: { ok: true } })).hasStatus(404)),
    'assertThatResponse().hasStatus: expected status 404 but got 200\n  body: {"ok": true}\n  expected: 404\n  actual:   200',
  );
  assert.equal(
    messageOf(() => assertThatResponse(makeResponse({ body: { item: "widget" } })).hasJson({ item: "gadget" })),
    'assertThatResponse().hasJson: the response body does not match the expected subset\n' +
      '  expected: {"item": "gadget"}\n  actual:   {"item": "widget"}',
  );
  const withHeaders = makeResponse({
    headers: { "content-type": "application/json", "x-order-id": "ord-42" },
    body: {},
  });
  assert.equal(
    messageOf(() => assertThatResponse(withHeaders).hasHeader("x-missing")),
    'assertThatResponse().hasHeader: expected header "x-missing" to be present\n' +
      '  headers: {"content-type": "application/json", "x-order-id": "ord-42"}',
  );
  assert.equal(
    messageOf(() => assertThatResponse(withHeaders).hasHeader("x-order-id", "ord-99")),
    'assertThatResponse().hasHeader: header "x-order-id" does not equal the expected value\n' +
      '  expected: "ord-99"\n  actual:   "ord-42"',
  );
});

// --- user-task.ts — messages pinned with the dynamic keys normalised ------------

/** Replace the run-specific numeric process-instance / user-task keys (rendered
 *  quoted by `formatValue`) with stable placeholders so the message is comparable
 *  to an inline expected string. */
function normaliseKeys(message: string, pik: string, utk: string): string {
  return message.replaceAll(`"${utk}"`, '"<UTK>"').replaceAll(`"${pik}"`, '"<PIK>"');
}

test("user-task.ts — every matcher's failure message is pinned", async () => {
  const dir = await makeFixture("CREATE TABLE marker (id INTEGER PRIMARY KEY);");
  try {
    const app = await bootTestApp(dir);
    try {
      const { processInstanceKey: pik } = await app.engine.createInstance({ processDefinitionId: "review" });
      const open = await app.engine.searchUserTasks({ processInstanceKey: pik, state: "CREATED" });
      assert.equal(open.length, 1, "fixture must park exactly one CREATED user task");
      const utk = open[0].userTaskKey;
      const sel = { instance: pik, elementId: "approve" };
      const norm = (message: string) => normaliseKeys(message, pik, utk);

      // While the task is open (CREATED): isCompleted / hasAssignee / hasCandidateGroup fail.
      assert.equal(
        norm(await messageOfAsync(() => assertThatUserTask(app, sel).isCompleted())),
        'Expected a user task matching instance "<PIK>" / elementId "approve" to be COMPLETED, but none is. ' +
          'matching user tasks: [{ userTaskKey: "<UTK>", elementId: "approve", state: CREATED }].',
      );
      assert.equal(
        norm(await messageOfAsync(() => assertThatUserTask(app, sel).hasAssignee("bob"))),
        'Expected a user task matching instance "<PIK>" / elementId "approve" assigned to "bob", but no ' +
          "matching task carries that assignee (the read model surfaces assignee only through its filter, so " +
          "the actual assignee value is not projected on the row). " +
          'matching user tasks: [{ userTaskKey: "<UTK>", elementId: "approve", state: CREATED }].',
      );
      assert.equal(
        norm(await messageOfAsync(() => assertThatUserTask(app, sel).hasCandidateGroup("nope"))),
        'Expected a user task matching instance "<PIK>" / elementId "approve" offering candidate group "nope", ' +
          "but no matching task offers it (the read model surfaces candidate groups only through its filter, so " +
          "the actual groups are not projected on the row). " +
          'matching user tasks: [{ userTaskKey: "<UTK>", elementId: "approve", state: CREATED }].',
      );

      // Complete the task, then isCreated fails naming the now-COMPLETED task.
      await app.engine.completeUserTask(utk);
      assert.equal(
        norm(await messageOfAsync(() => assertThatUserTask(app, sel).isCreated())),
        'Expected a user task matching instance "<PIK>" / elementId "approve" to be CREATED (open), but none ' +
          'is open. matching user tasks: [{ userTaskKey: "<UTK>", elementId: "approve", state: COMPLETED }].',
      );
    } finally {
      await app.stop();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
