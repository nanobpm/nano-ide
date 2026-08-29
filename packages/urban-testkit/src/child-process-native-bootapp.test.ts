// e2e coverage for NATIVE call-activity execution through a real app boot (issue nanobpm/nano-ide#512).
//
// The testkit no longer rewrites `<bpmn:callActivity>` at deploy time: deployed XML reaches the
// engine unmodified, so an un-mocked call activity executes natively — the engine instantiates the
// called process as a real child instance and the parent parks until the child completes. This
// proves that end-to-end through `bootTestApp` (the deploy path a real Urban app uses), not just
// against the raw engine. (Child→parent variable *propagation* is tracked separately and is NOT
// asserted here — see the NOTE in the first test.)

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bootTestApp } from "./boot-app.ts";

// Parent: start → callActivity(fulfilment) → userTask review. The child is declared with
// `propagateAllChildVariables`, but this test only observes that the native child ran to
// completion and the parent parked past the call activity — it does not assert variable
// propagation (tracked separately; see the NOTE below).
const PARENT_BPMN = `<?xml version="1.0" encoding="UTF-8"?>
<definitions xmlns="http://www.omg.org/spec/BPMN/20100524/MODEL"
             xmlns:zeebe="http://camunda.org/schema/zeebe/1.0"
             targetNamespace="http://nanobpm/testkit">
  <process id="parent" isExecutable="true">
    <startEvent id="s"/>
    <sequenceFlow id="f1" sourceRef="s" targetRef="ca"/>
    <callActivity id="ca">
      <extensionElements><zeebe:calledElement processId="fulfilment" propagateAllChildVariables="true"/></extensionElements>
    </callActivity>
    <sequenceFlow id="f2" sourceRef="ca" targetRef="review"/>
    <userTask id="review"><extensionElements><zeebe:userTask/></extensionElements></userTask>
    <sequenceFlow id="f3" sourceRef="review" targetRef="e"/>
    <endEvent id="e"/>
  </process>
</definitions>`;

// The real called process: a service task backed by a real worker handler. Native execution runs
// this child for real (no mock stands in for it), and it runs to completion before the parent
// continues.
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

// The real handler completes the child's service task — proving the native child actually ran.
const HANDLERS = `export const handlers = {
  "fulfilment.ship": async () => ({ shipped: true, tracking: "XYZ" }),
};`;
const MIGRATION = `CREATE TABLE noop (id INTEGER PRIMARY KEY);`;

async function makeFixture(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "urban-testkit-childproc-native-"));
  await mkdir(join(dir, "processes"), { recursive: true });
  await mkdir(join(dir, "workers"), { recursive: true });
  await mkdir(join(dir, "db", "migrations"), { recursive: true });
  await writeFile(join(dir, "processes", "parent.bpmn"), PARENT_BPMN);
  await writeFile(join(dir, "processes", "fulfilment.bpmn"), FULFILMENT_BPMN);
  await writeFile(join(dir, "workers", "handlers.ts"), HANDLERS);
  await writeFile(join(dir, "db", "migrations", "001_init.sql"), MIGRATION);
  const manifest = {
    schemaVersion: 1,
    id: "testkit-childproc-native-fixture",
    name: "Testkit Native Child-Process Fixture",
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

/** The instance for `processDefinitionId` from the raw engine snapshot (or undefined). */
function instanceFor(snapshot: Record<string, unknown>, processDefinitionId: string): Record<string, unknown> | undefined {
  const raw = snapshot.instances;
  if (!Array.isArray(raw)) return undefined;
  for (const inst of raw) {
    if (inst && typeof inst === "object" && !Array.isArray(inst)) {
      const id = String(Reflect.get(inst, "processId") ?? Reflect.get(inst, "bpmnProcessId"));
      if (id === processDefinitionId) return { ...inst };
    }
  }
  return undefined;
}

test("native call activity: an un-mocked call activity instantiates the deployed child, which runs to completion before the parent continues", async () => {
  const dir = await makeFixture();
  const app = await bootTestApp(dir);
  try {
    const { processInstanceKey } = await app.engine.createInstance({ processDefinitionId: "parent" });
    await app.settle();
    const snap = app.snapshot();
    // The parent moved past the call activity to the user task ONLY because the native child ran to
    // completion and released the parent's token (a rewrite/auto-complete would not run the child).
    assert.deepEqual(snap.activeElementIds, ["review"], "parent parked past the call activity after the child completed");
    // The child was instantiated as its OWN real process instance (native call activity), and it
    // completed — proving the parent parked until the deployed child finished, not a pass-through.
    const child = instanceFor(snap, "fulfilment");
    assert.ok(child, "the called process was instantiated as a child instance");
    assert.equal(String(child.state).toUpperCase(), "COMPLETED", "the native child ran to completion");
    // Both the parent and the child are distinct, queryable process instances.
    const parent = instanceFor(snap, "parent");
    assert.ok(parent, "the parent instance is queryable");
    assert.notEqual(String(parent.key), String(child.key), "parent and child are distinct instances");
    assert.equal(String(parent.key), processInstanceKey, "the created instance is the parent root");
    const incidents = snap.incidents;
    assert.ok(Array.isArray(incidents) && incidents.length === 0, "the native child completed without incident");
    // NOTE: child→parent variable *propagation* (`propagateAllChildVariables` / `propagateAll*`
    // defaults) is tracked separately (Magikcraft/nano-bpm#1057) and is intentionally NOT asserted
    // here — this slice removes the deploy-time rewrite so the native path runs at all.
  } finally {
    await app.stop();
    await rm(dir, { recursive: true, force: true });
  }
});

test("native call activity: a call activity to an UN-deployed child raises a recoverable incident on the parent", async () => {
  // Production-faithful consequence of removing the deploy-time rewrite: if the called process is
  // not deployed to the same engine, the engine raises an incident on the call activity rather than
  // silently auto-completing (the old rewrite's behaviour). Consumers must deploy the child.
  const dir = await mkdtemp(join(tmpdir(), "urban-testkit-childproc-missing-"));
  await mkdir(join(dir, "processes"), { recursive: true });
  await mkdir(join(dir, "db", "migrations"), { recursive: true });
  await writeFile(join(dir, "processes", "parent.bpmn"), PARENT_BPMN);
  await writeFile(join(dir, "db", "migrations", "001_init.sql"), MIGRATION);
  const manifest = {
    schemaVersion: 1,
    id: "testkit-childproc-missing-fixture",
    name: "Testkit Missing Child Fixture",
    models: { processes: ["processes/*.bpmn"] },
    data: {
      default: "app",
      sources: { app: { driver: "sqlite", url: "file:./db/app.db", migrations: "db/migrations" } },
    },
  };
  await writeFile(join(dir, "nano.app.json"), JSON.stringify(manifest, null, 2));
  const app = await bootTestApp(dir);
  try {
    await app.engine.createInstance({ processDefinitionId: "parent" });
    await app.settle();
    const snap = app.snapshot();
    // The parent parked ON the call activity with an incident; it did NOT auto-complete past it.
    assert.deepEqual(snap.activeElementIds, ["ca"], "the parent parked on the call activity, not past it");
    assert.ok(
      Array.isArray(snap.incidents) && snap.incidents.length > 0,
      "an un-deployed called process raises a recoverable incident (production-faithful, not a silent pass-through)",
    );
  } finally {
    await app.stop();
    await rm(dir, { recursive: true, force: true });
  }
});
