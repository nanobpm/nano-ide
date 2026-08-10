// A reusable, adapter-agnostic behavioural contract for {@link EngineClient}
// (ADR 0059 test kit, S1 — issue #157). `runEngineClientContract` registers a
// suite of `node:test` cases that exercise an `EngineClient` purely through its
// public surface, so the *same* suite can be run against the in-process WASM
// adapter (`./wasm-engine.ts`) and, in an integration lane, against the live
// `@nanobpm/nano-sdk` adapter. Any adapter that passes agrees on the seam the
// runtime depends on — including that a *cancelled* instance reports
// `TERMINATED` (the state-mapping bug this kit exists to prevent).
//
// The suite tolerates a push (asynchronous) worker adapter by polling terminal
// state with a bounded {@link waitFor}; against the synchronous WASM adapter the
// first poll already succeeds.

import { test } from "node:test";
import assert from "node:assert/strict";
import type { EngineClient, EngineJob } from "@nanobpm/urban/runtime";

/** A single service task `work`, job type `work`. Parks at `work` until a worker
 *  serves it — so it doubles as the cancel fixture when no worker is registered. */
const SERVICE_BPMN = bpmn("svc", `
  <startEvent id="s"/>
  <sequenceFlow id="f1" sourceRef="s" targetRef="work"/>
  <serviceTask id="work">
    <extensionElements><zeebe:taskDefinition type="work"/></extensionElements>
  </serviceTask>
  <sequenceFlow id="f2" sourceRef="work" targetRef="e"/>
  <endEvent id="e"/>`);

/** Two chained service tasks (`one` → `two`): exercises draining across workers
 *  and mid-flight variable carry-over. */
const CHAIN_BPMN = bpmn("chain", `
  <startEvent id="s"/>
  <sequenceFlow id="f1" sourceRef="s" targetRef="t1"/>
  <serviceTask id="t1"><extensionElements><zeebe:taskDefinition type="one"/></extensionElements></serviceTask>
  <sequenceFlow id="f2" sourceRef="t1" targetRef="t2"/>
  <serviceTask id="t2"><extensionElements><zeebe:taskDefinition type="two"/></extensionElements></serviceTask>
  <sequenceFlow id="f3" sourceRef="t2" targetRef="e"/>
  <endEvent id="e"/>`);

/** A single native user task `review`: parks for a human. */
const USER_TASK_BPMN = bpmn("human", `
  <startEvent id="s"/>
  <sequenceFlow id="f1" sourceRef="s" targetRef="review"/>
  <userTask id="review"><extensionElements><zeebe:userTask/></extensionElements></userTask>
  <sequenceFlow id="f2" sourceRef="review" targetRef="e"/>
  <endEvent id="e"/>`);

/**
 * Register the shared `EngineClient` contract as `node:test` cases, prefixed
 * with `label`. `makeEngine` must return a fresh, empty engine each call; the
 * suite closes it after every case.
 */
export function runEngineClientContract(
  label: string,
  makeEngine: () => Promise<EngineClient>,
): void {
  const withEngine = async (run: (e: EngineClient) => Promise<void>) => {
    const engine = await makeEngine();
    try {
      await run(engine);
    } finally {
      await engine.close();
    }
  };

  test(`${label}: a registered worker serves a service task to completion`, async () => {
    await withEngine(async (engine) => {
      await engine.registerWorker("work", () => ({ served: true }));
      await engine.deployResources(res(SERVICE_BPMN));
      const { processInstanceKey } = await engine.createInstance({
        processDefinitionId: "svc",
        awaitCompletion: true,
      });
      assert.ok(processInstanceKey, "expected a process instance key");
      await waitFor(async () =>
        (await engine.searchProcessInstances({ processInstanceKeys: [processInstanceKey] }))[0]
          ?.state === "COMPLETED"
      );
    });
  });

  test(`${label}: a worker receives the instance's input variables`, async () => {
    await withEngine(async (engine) => {
      let seen: EngineJob | undefined;
      await engine.registerWorker("work", (job) => {
        seen = job;
        return {};
      });
      await engine.deployResources(res(SERVICE_BPMN));
      await engine.createInstance({
        processDefinitionId: "svc",
        variables: { n: 41 },
        awaitCompletion: true,
      });
      assert.equal(seen?.jobType, "work");
      assert.equal(seen?.elementId, "work");
      assert.equal(seen?.variables.n, 41);
    });
  });

  test(`${label}: a cancelled instance reports TERMINATED`, async () => {
    await withEngine(async (engine) => {
      // No worker registered → the instance parks at `work`, still ACTIVE.
      await engine.deployResources(res(SERVICE_BPMN));
      const { processInstanceKey } = await engine.createInstance({ processDefinitionId: "svc" });
      const before = await engine.searchProcessInstances({
        processInstanceKeys: [processInstanceKey],
      });
      assert.equal(before[0]?.state, "ACTIVE");

      await engine.cancelInstance({ processInstanceKey });

      await waitFor(async () =>
        (await engine.searchProcessInstances({ processInstanceKeys: [processInstanceKey] }))[0]
          ?.state === "TERMINATED"
      );
      // And it surfaces through the state filter the reconciler actually uses.
      const terminated = await engine.searchProcessInstances({
        processInstanceKeys: [processInstanceKey],
        state: "TERMINATED",
      });
      assert.deepEqual(terminated.map((i) => i.processInstanceKey), [processInstanceKey]);
    });
  });

  test(`${label}: searchProcessInstances filters by key and by state`, async () => {
    await withEngine(async (engine) => {
      await engine.registerWorker("work", () => ({}));
      await engine.deployResources(res(SERVICE_BPMN, USER_TASK_BPMN));

      const done = await engine.createInstance({
        processDefinitionId: "svc",
        awaitCompletion: true,
      });
      const parked = await engine.createInstance({ processDefinitionId: "human" });

      await waitFor(async () =>
        (await engine.searchProcessInstances({ processInstanceKeys: [done.processInstanceKey] }))[0]
          ?.state === "COMPLETED"
      );

      const completed = await engine.searchProcessInstances({ state: "COMPLETED" });
      const completedKeys = completed.map((i) => i.processInstanceKey);
      assert.ok(completedKeys.includes(done.processInstanceKey));
      assert.ok(!completedKeys.includes(parked.processInstanceKey));

      const active = await engine.searchProcessInstances({ state: "ACTIVE" });
      const activeKeys = active.map((i) => i.processInstanceKey);
      assert.ok(activeKeys.includes(parked.processInstanceKey));
      assert.ok(!activeKeys.includes(done.processInstanceKey));

      const byKey = await engine.searchProcessInstances({
        processInstanceKeys: [done.processInstanceKey],
      });
      assert.deepEqual(byKey.map((i) => i.processInstanceKey), [done.processInstanceKey]);
    });
  });

  test(`${label}: chained workers drain to completion`, async () => {
    await withEngine(async (engine) => {
      await engine.registerWorker("one", () => ({ one: true }));
      await engine.registerWorker("two", () => ({ two: true }));
      await engine.deployResources(res(CHAIN_BPMN));
      const { processInstanceKey } = await engine.createInstance({
        processDefinitionId: "chain",
        awaitCompletion: true,
      });
      await waitFor(async () =>
        (await engine.searchProcessInstances({ processInstanceKeys: [processInstanceKey] }))[0]
          ?.state === "COMPLETED"
      );
    });
  });

  test(`${label}: a user task can be found and completed`, async () => {
    await withEngine(async (engine) => {
      await engine.deployResources(res(USER_TASK_BPMN));
      const { processInstanceKey } = await engine.createInstance({ processDefinitionId: "human" });

      const tasks = await waitForValue(async () => {
        const found = await engine.searchUserTasks({ processInstanceKey });
        return found.length > 0 ? found : undefined;
      });
      assert.equal(tasks.length, 1);
      assert.equal(tasks[0].elementId, "review");

      await engine.completeUserTask(tasks[0].userTaskKey);
      await waitFor(async () =>
        (await engine.searchProcessInstances({ processInstanceKeys: [processInstanceKey] }))[0]
          ?.state === "COMPLETED"
      );
    });
  });

  test(`${label}: a failing worker raises an incident, not completion`, async () => {
    await withEngine(async (engine) => {
      await engine.registerWorker("work", () => {
        throw new Error("boom");
      });
      await engine.deployResources(res(SERVICE_BPMN));
      const { processInstanceKey } = await engine.createInstance({ processDefinitionId: "svc" });
      const [inst] = await engine.searchProcessInstances({
        processInstanceKeys: [processInstanceKey],
      });
      assert.equal(inst?.state, "ACTIVE", "a failed job must not complete the instance");
    });
  });
}

/** Wrap BPMN XML content one resource for `deployResources`. */
function res(...xml: string[]): { name: string; content: string; contentType: string }[] {
  return xml.map((content, i) => ({
    name: `fixture-${i}.bpmn`,
    content,
    contentType: "application/bpmn+xml",
  }));
}

/** Build a minimal executable BPMN document with the given process id + body. */
function bpmn(processId: string, body: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<definitions xmlns="http://www.omg.org/spec/BPMN/20100524/MODEL"
             xmlns:zeebe="http://camunda.org/schema/zeebe/1.0"
             targetNamespace="http://nanobpm/testkit">
  <process id="${processId}" isExecutable="true">${body}
  </process>
</definitions>`;
}

/** Poll `predicate` until it is true or the budget is exhausted (then throw). */
async function waitFor(
  predicate: () => Promise<boolean>,
  { timeoutMs = 2_000, intervalMs = 10 } = {},
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await predicate()) return;
    if (Date.now() >= deadline) throw new Error("waitFor: condition not met before timeout");
    await sleep(intervalMs);
  }
}

/** Poll `produce` until it yields a defined value or the budget is exhausted. */
async function waitForValue<T>(
  produce: () => Promise<T | undefined>,
  { timeoutMs = 2_000, intervalMs = 10 } = {},
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await produce();
    if (v !== undefined) return v;
    if (Date.now() >= deadline) throw new Error("waitForValue: no value before timeout");
    await sleep(intervalMs);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
