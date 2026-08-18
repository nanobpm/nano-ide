// Red/Green coverage for `assertThatInstance` (instance-assert slice).
//
// Every matcher is proven twice: it PASSES on the positive case and THROWS an
// `AssertionError` on the negative case (a matcher that cannot fail is worthless).
// A real app is booted via `bootTestApp`; instances are driven through the engine
// to ACTIVE / COMPLETED / TERMINATED and to a job-no-retries incident. Everything
// is deterministic — no wall-clock, no polling — and runs under both `node --test`
// and Deno.

import { test } from "node:test";
import assert from "node:assert/strict";
import { AssertionError } from "node:assert";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bootTestApp, type TestApp } from "../boot-app.ts";
import { assertThatInstance } from "./instance.ts";
import { byKey, byProcessId } from "./selectors.ts";

// A single-service-task process. Deployed per-test through the engine so each
// case owns an isolated snapshot (the completed-element stats are aggregate).
function serviceProcess(id: string, taskType: string, retries = "3"): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<definitions xmlns="http://www.omg.org/spec/BPMN/20100524/MODEL"
             xmlns:zeebe="http://camunda.org/schema/zeebe/1.0"
             targetNamespace="http://nanobpm/testkit">
  <process id="${id}" isExecutable="true">
    <startEvent id="s"/>
    <sequenceFlow id="f1" sourceRef="s" targetRef="work"/>
    <serviceTask id="work">
      <extensionElements><zeebe:taskDefinition type="${taskType}" retries="${retries}"/></extensionElements>
    </serviceTask>
    <sequenceFlow id="f2" sourceRef="work" targetRef="e"/>
    <endEvent id="e"/>
  </process>
</definitions>`;
}

// A minimal but complete app on disk: bootTestApp requires a mounted data layer,
// so the manifest declares a trivial SQLite source. Processes are deployed at
// runtime via `app.engine`, so the manifest needs no process/worker of its own.
const NOOP_MIGRATION = "CREATE TABLE _boot (id INTEGER PRIMARY KEY);";

async function makeFixture(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "urban-testkit-instance-"));
  await mkdir(join(dir, "db", "migrations"), { recursive: true });
  await writeFile(join(dir, "db", "migrations", "001_init.sql"), NOOP_MIGRATION);
  const manifest = {
    schemaVersion: 1,
    id: "testkit-instance-fixture",
    name: "Testkit Instance Fixture",
    data: {
      default: "app",
      sources: { app: { driver: "sqlite", url: "file:./db/app.db", migrations: "db/migrations" } },
    },
  };
  await writeFile(join(dir, "nano.app.json"), JSON.stringify(manifest, null, 2));
  return dir;
}

async function withApp(fn: (app: TestApp) => Promise<void>): Promise<void> {
  const dir = await makeFixture();
  const app = await bootTestApp(dir);
  try {
    await fn(app);
  } finally {
    await app.stop();
    await rm(dir, { recursive: true, force: true });
  }
}

/** Assert `fn` throws a `node:assert` `AssertionError` whose message contains
 *  every fragment in `contains` (proves the message NAMES the actual state). */
function expectFailure(fn: () => unknown, contains: string[]): void {
  let thrown: unknown;
  try {
    fn();
  } catch (err) {
    thrown = err;
  }
  assert.ok(thrown instanceof AssertionError, "matcher should throw an AssertionError on the negative case");
  for (const fragment of contains) {
    assert.ok(
      thrown.message.includes(fragment),
      `failure message should mention ${JSON.stringify(fragment)} — got:\n${thrown.message}`,
    );
  }
}

// --- State matchers: one per ProcessInstanceState member (ACTIVE/COMPLETED/TERMINATED) ---

test("isActive passes for an ACTIVE instance and fails otherwise", async () => {
  await withApp(async (app) => {
    await app.engine.deployResources([
      { name: "act.bpmn", content: serviceProcess("act", "act.work"), contentType: "application/bpmn+xml" },
    ]);
    // No worker registered → the job parks the instance ACTIVE at `work`.
    const { processInstanceKey } = await app.engine.createInstance({ processDefinitionId: "act" });

    assertThatInstance(app, processInstanceKey).isActive();
    expectFailure(() => assertThatInstance(app, processInstanceKey).hasCompleted(), [
      "COMPLETED",
      "ACTIVE",
    ]);
  });
});

test("hasCompleted passes for a COMPLETED instance and fails otherwise", async () => {
  await withApp(async (app) => {
    await app.engine.deployResources([
      { name: "cmp.bpmn", content: serviceProcess("cmp", "cmp.work"), contentType: "application/bpmn+xml" },
    ]);
    await app.engine.registerWorker("cmp.work", () => ({ ok: true }));
    const { processInstanceKey } = await app.engine.createInstance({
      processDefinitionId: "cmp",
      awaitCompletion: true,
    });

    assertThatInstance(app, processInstanceKey).hasCompleted();
    expectFailure(() => assertThatInstance(app, processInstanceKey).isTerminated(), [
      "TERMINATED",
      "COMPLETED",
    ]);
  });
});

test("isTerminated passes for a cancelled instance and fails otherwise", async () => {
  await withApp(async (app) => {
    await app.engine.deployResources([
      { name: "trm.bpmn", content: serviceProcess("trm", "trm.work"), contentType: "application/bpmn+xml" },
    ]);
    const { processInstanceKey } = await app.engine.createInstance({ processDefinitionId: "trm" });
    await app.engine.cancelInstance({ processInstanceKey });

    assertThatInstance(app, processInstanceKey).isTerminated();
    expectFailure(() => assertThatInstance(app, processInstanceKey).isActive(), [
      "ACTIVE",
      "TERMINATED",
    ]);
  });
});

// --- Element matchers: {active, completed} scope ---

test("hasActiveElement / hasActiveElements pass for live tokens and fail otherwise", async () => {
  await withApp(async (app) => {
    await app.engine.deployResources([
      { name: "el.bpmn", content: serviceProcess("el", "el.work"), contentType: "application/bpmn+xml" },
    ]);
    const { processInstanceKey } = await app.engine.createInstance({ processDefinitionId: "el" });

    assertThatInstance(app, processInstanceKey).hasActiveElement("work").hasActiveElements("work");
    expectFailure(() => assertThatInstance(app, processInstanceKey).hasActiveElement("ghost"), [
      "ghost",
      "work",
    ]);
    expectFailure(() => assertThatInstance(app, processInstanceKey).hasActiveElements("work", "ghost"), [
      "ghost",
    ]);
  });
});

test("hasCompletedElements passes for completed elements and fails otherwise", async () => {
  await withApp(async (app) => {
    await app.engine.deployResources([
      { name: "ce.bpmn", content: serviceProcess("ce", "ce.work"), contentType: "application/bpmn+xml" },
    ]);
    await app.engine.registerWorker("ce.work", () => ({ ok: true }));
    const { processInstanceKey } = await app.engine.createInstance({
      processDefinitionId: "ce",
      awaitCompletion: true,
    });

    // s, work and e all completed on the way to the end event.
    assertThatInstance(app, processInstanceKey).hasCompletedElements("s", "work", "e");
    expectFailure(() => assertThatInstance(app, processInstanceKey).hasCompletedElements("s", "ghost"), [
      "ghost",
    ]);
  });
});

test("hasCompletedElements fails fast when the snapshot holds more than one instance", async () => {
  await withApp(async (app) => {
    // Two DISTINCT processes so both instances coexist in the snapshot: one
    // COMPLETED (its elements land in the aggregate `elementStats`) and one left
    // ACTIVE. Because completion counts are snapshot-global, the matcher cannot
    // attribute a completed element to a single instance here — it must refuse
    // rather than silently borrow another instance's completions.
    await app.engine.deployResources([
      { name: "m1.bpmn", content: serviceProcess("m1", "m1.work"), contentType: "application/bpmn+xml" },
      { name: "m2.bpmn", content: serviceProcess("m2", "m2.work"), contentType: "application/bpmn+xml" },
    ]);
    await app.engine.registerWorker("m1.work", () => ({ ok: true }));
    const { processInstanceKey: doneKey } = await app.engine.createInstance({
      processDefinitionId: "m1",
      awaitCompletion: true,
    });
    // No worker for m2 → this instance parks ACTIVE, so two instances coexist.
    await app.engine.createInstance({ processDefinitionId: "m2" });

    // Even asking about an element the resolved instance genuinely completed
    // ("s") must throw, because the verdict would not be per-instance honest.
    expectFailure(() => assertThatInstance(app, doneKey).hasCompletedElements("s"), [
      "more than one instance",
      "unsound",
    ]);
  });
});

test("hasCompletedElements refuses when the resolved instance has vanished from the snapshot", async () => {
  await withApp(async (app) => {
    // A single COMPLETED instance: its elements land in the aggregate
    // `elementStats`, and it is the snapshot's sole instance, so a normal
    // `hasCompletedElements` verdict would be sound.
    await app.engine.deployResources([
      { name: "vn.bpmn", content: serviceProcess("vn", "vn.work"), contentType: "application/bpmn+xml" },
    ]);
    await app.engine.registerWorker("vn.work", () => ({ ok: true }));
    const { processInstanceKey } = await app.engine.createInstance({
      processDefinitionId: "vn",
      awaitCompletion: true,
    });

    // Resolve the assertion against the real (correct) snapshot, THEN simulate the
    // target instance vanishing while a lone UNRELATED instance remains — the exact
    // shape the `instanceCount > 1` guard does NOT cover (count is 1, but it is the
    // wrong instance). Reading snapshot-global `elementStats` here would borrow the
    // vanished instance's completions and return an unsound verdict; the matcher must
    // instead refuse because the resolved instance is no longer present.
    const real = app.snapshot();
    const doctored: Record<string, unknown> = {
      ...real,
      instances: [{ key: "OTHER", state: "Active", processId: "vn" }],
    };
    let vanished = false;
    const doctoredApp: TestApp = { ...app, snapshot: () => (vanished ? doctored : real) };

    const subject = assertThatInstance(doctoredApp, processInstanceKey);
    vanished = true;
    expectFailure(() => subject.hasCompletedElements("s"), [processInstanceKey, "no longer present"]);
  });
});

// --- Variable matchers ---

test("hasVariable / hasVariables / hasNoVariable pass and fail as specified", async () => {
  await withApp(async (app) => {
    await app.engine.deployResources([
      { name: "vr.bpmn", content: serviceProcess("vr", "vr.work"), contentType: "application/bpmn+xml" },
    ]);
    // Parked ACTIVE (no worker) so variables are retained in the snapshot.
    const { processInstanceKey } = await app.engine.createInstance({
      processDefinitionId: "vr",
      variables: { who: "world", count: 3, nested: { a: 1, b: [2, 3] } },
    });
    const inst = () => assertThatInstance(app, processInstanceKey);

    // hasVariable — deep equality.
    inst().hasVariable("who", "world").hasVariable("nested", { a: 1, b: [2, 3] });
    expectFailure(() => inst().hasVariable("who", "mars"), ['"world"', '"mars"']);
    expectFailure(() => inst().hasVariable("missing", 1), ["missing"]);

    // hasVariables — deep subset (extra vars, e.g. _urban lineage, ignored).
    inst().hasVariables({ who: "world", count: 3 });
    expectFailure(() => inst().hasVariables({ who: "world", count: 99 }), ["count"]);

    // hasNoVariable.
    inst().hasNoVariable("absent");
    expectFailure(() => inst().hasNoVariable("who"), ["who", '"world"']);
  });
});

// --- Instance-level incident matchers ---

test("hasIncident / hasNoIncident pass and fail, and hasIncident narrows by selector", async () => {
  await withApp(async (app) => {
    // Incident instance: worker throws with retries=1 → job-no-retries incident on `work`.
    await app.engine.deployResources([
      { name: "inc.bpmn", content: serviceProcess("inc", "inc.work", "1"), contentType: "application/bpmn+xml" },
    ]);
    await app.engine.registerWorker("inc.work", () => {
      throw new Error("kaboom");
    });
    const { processInstanceKey: incKey } = await app.engine.createInstance({ processDefinitionId: "inc" });
    await app.engine.drain();

    // Healthy instance: parks ACTIVE with no incident.
    await app.engine.deployResources([
      { name: "ok.bpmn", content: serviceProcess("ok", "ok.work"), contentType: "application/bpmn+xml" },
    ]);
    const { processInstanceKey: okKey } = await app.engine.createInstance({ processDefinitionId: "ok" });

    // hasIncident (unfiltered + narrowed by element id and by error message).
    assertThatInstance(app, incKey)
      .hasIncident()
      .hasIncident({ elementId: "work" })
      .hasIncident({ errorMessage: "kaboom" })
      .hasIncident({ elementId: "work", errorMessage: "kaboom" });
    expectFailure(() => assertThatInstance(app, okKey).hasIncident(), ["to have an incident", "it has no incidents"]);
    // A selector that matches no incident on an instance that HAS one still fails, naming the actual incident.
    expectFailure(() => assertThatInstance(app, incKey).hasIncident({ elementId: "s" }), ["kaboom", "work"]);

    // hasNoIncident.
    assertThatInstance(app, okKey).hasNoIncident();
    expectFailure(() => assertThatInstance(app, incKey).hasNoIncident(), ["kaboom", "work"]);
  });
});

// --- Selector forms all resolve through the shared resolver / convenience ---

test("assertThatInstance resolves by key, byKey(...), byProcessId(...), and the single-ACTIVE default", async () => {
  await withApp(async (app) => {
    await app.engine.deployResources([
      { name: "sel.bpmn", content: serviceProcess("order", "order.work"), contentType: "application/bpmn+xml" },
    ]);
    const { processInstanceKey } = await app.engine.createInstance({ processDefinitionId: "order" });

    assertThatInstance(app, processInstanceKey).isActive(); // bare string key
    assertThatInstance(app, byKey(processInstanceKey)).isActive(); // byKey selector
    assertThatInstance(app, byProcessId("order")).isActive(); // byProcessId selector
    assertThatInstance(app).isActive(); // single-ACTIVE convenience

    // Unresolvable selectors throw an intent-revealing AssertionError.
    expectFailure(() => assertThatInstance(app, byProcessId("nope")), ["nope"]);
    expectFailure(() => assertThatInstance(app, "does-not-exist"), ["does-not-exist"]);
  });
});

// --- Chainability across matcher families ---

test("matchers chain across state, elements, variables and incidents", async () => {
  await withApp(async (app) => {
    await app.engine.deployResources([
      { name: "ch.bpmn", content: serviceProcess("ch", "ch.work"), contentType: "application/bpmn+xml" },
    ]);
    const { processInstanceKey } = await app.engine.createInstance({
      processDefinitionId: "ch",
      variables: { who: "world" },
    });

    const returned = assertThatInstance(app, processInstanceKey)
      .isActive()
      .hasActiveElement("work")
      .hasVariable("who", "world")
      .hasVariables({ who: "world" })
      .hasNoVariable("absent")
      .hasNoIncident();
    assert.equal(typeof returned.isActive, "function", "each matcher returns the fluent object");
  });
});
