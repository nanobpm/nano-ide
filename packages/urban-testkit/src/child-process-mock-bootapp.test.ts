// e2e coverage for the `TestApp.mockChildProcess` seam (epic #296, S3) through a real app boot.
//
// Proves the harness-level surface: booting a real Urban app whose process contains a call activity,
// then `app.mockChildProcess(id).completeWith(...)` makes the parent continue with the mocked child
// output WITHOUT the real called process running — driven through the same deploy path an app uses,
// so the deploy-time call-activity rewrite is exercised end-to-end (not just against the raw engine).

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bootTestApp } from "./boot-app.ts";

const PARENT_BPMN = `<?xml version="1.0" encoding="UTF-8"?>
<definitions xmlns="http://www.omg.org/spec/BPMN/20100524/MODEL"
             xmlns:zeebe="http://camunda.org/schema/zeebe/1.0"
             targetNamespace="http://nanobpm/testkit">
  <process id="parent" isExecutable="true">
    <startEvent id="s"/>
    <sequenceFlow id="f1" sourceRef="s" targetRef="ca"/>
    <callActivity id="ca">
      <extensionElements><zeebe:calledElement processId="fulfilment"/></extensionElements>
    </callActivity>
    <sequenceFlow id="f2" sourceRef="ca" targetRef="review"/>
    <userTask id="review"><extensionElements><zeebe:userTask/></extensionElements></userTask>
    <sequenceFlow id="f3" sourceRef="review" targetRef="e"/>
    <endEvent id="e"/>
  </process>
</definitions>`;

// The real called process has a service task that would EXPLODE if it ran — proving the mock
// stands in for the whole child process.
const FULFILMENT_BPMN = `<?xml version="1.0" encoding="UTF-8"?>
<definitions xmlns="http://www.omg.org/spec/BPMN/20100524/MODEL"
             xmlns:zeebe="http://camunda.org/schema/zeebe/1.0"
             targetNamespace="http://nanobpm/testkit">
  <process id="fulfilment" isExecutable="true">
    <startEvent id="cs"/>
    <sequenceFlow id="cf1" sourceRef="cs" targetRef="ship"/>
    <serviceTask id="ship"><extensionElements><zeebe:taskDefinition type="fulfilment.ship"/></extensionElements></serviceTask>
    <sequenceFlow id="cf2" sourceRef="ship" targetRef="ce"/>
    <endEvent id="ce"/>
  </process>
</definitions>`;

const HANDLERS = `export const handlers = {
  "fulfilment.ship": async () => { throw new Error("real fulfilment.ship must not run when the child is mocked"); },
};`;

const MIGRATION = `CREATE TABLE noop (id INTEGER PRIMARY KEY);`;

async function makeFixture(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "urban-testkit-childproc-"));
  await mkdir(join(dir, "processes"), { recursive: true });
  await mkdir(join(dir, "workers"), { recursive: true });
  await mkdir(join(dir, "db", "migrations"), { recursive: true });
  await writeFile(join(dir, "processes", "parent.bpmn"), PARENT_BPMN);
  await writeFile(join(dir, "processes", "fulfilment.bpmn"), FULFILMENT_BPMN);
  await writeFile(join(dir, "workers", "handlers.ts"), HANDLERS);
  await writeFile(join(dir, "db", "migrations", "001_init.sql"), MIGRATION);
  const manifest = {
    schemaVersion: 1,
    id: "testkit-childproc-fixture",
    name: "Testkit Child-Process Fixture",
    models: { processes: ["processes/*.bpmn"] },
    data: {
      default: "app",
      sources: { app: { driver: "sqlite", url: "file:./db/app.db", migrations: "db/migrations" } },
    },
    workers: [{ taskType: "fulfilment.ship", handler: "workers/handlers.ts" }],
  };
  await writeFile(join(dir, "nano.app.json"), JSON.stringify(manifest, null, 2));
  return dir;
}

/** A single instance's variables from the engine snapshot. */
function instanceVariables(snapshot: Record<string, unknown>, key: string): Record<string, unknown> {
  const raw = snapshot.instances;
  if (!Array.isArray(raw)) return {};
  for (const inst of raw) {
    if (inst && typeof inst === "object" && String(Reflect.get(inst, "key")) === key) {
      const vars = Reflect.get(inst, "variables");
      if (vars && typeof vars === "object" && !Array.isArray(vars)) return { ...vars };
    }
  }
  return {};
}

test("TestApp.mockChildProcess completes the parent with mocked child output; the real child never runs", async () => {
  const dir = await makeFixture();
  const app = await bootTestApp(dir);
  try {
    app.mockChildProcess("fulfilment").completeWith({ shipped: true, tracking: "XYZ" });
    const { processInstanceKey } = await app.engine.createInstance({ processDefinitionId: "parent" });
    await app.settle();
    const snap = app.snapshot();
    // The parent moved past the call activity to the user task (the mock resolved the child).
    assert.deepEqual(snap.activeElementIds, ["review"], "parent continued past the mocked call activity");
    const vars = instanceVariables(snap, processInstanceKey);
    assert.equal(vars.shipped, true, "the mocked child output merged into the parent");
    assert.equal(vars.tracking, "XYZ");
    // The real `fulfilment.ship` handler throws if run — no incident means it never ran.
    const incidents = snap.incidents;
    assert.ok(Array.isArray(incidents) && incidents.length === 0, "the real called process did not run");
  } finally {
    await app.stop();
    await rm(dir, { recursive: true, force: true });
  }
});

test("TestApp.mockChildProcess failWith surfaces an incident on the parent", async () => {
  const dir = await makeFixture();
  const app = await bootTestApp(dir);
  try {
    app.mockChildProcess("fulfilment").failWith({ message: "fulfilment unavailable" });
    const { processInstanceKey } = await app.engine.createInstance({ processDefinitionId: "parent" });
    await app.settle();
    const snap = app.snapshot();
    assert.deepEqual(snap.activeElementIds, ["ca"], "the parent parked on the failed call activity");
    const reasons = Array.isArray(snap.incidents)
      ? snap.incidents.map((i) => (i && typeof i === "object" ? Reflect.get(i, "reason") : undefined))
      : [];
    assert.ok(reasons.includes("fulfilment unavailable"), "failWith raised an incident with its message");
  } finally {
    await app.stop();
    await rm(dir, { recursive: true, force: true });
  }
});
