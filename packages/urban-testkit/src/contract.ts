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

  test(`${label}: fetchVariables limits the variables surfaced to a worker`, async () => {
    await withEngine(async (engine) => {
      let seen: EngineJob | undefined;
      await engine.registerWorker(
        "work",
        (job) => {
          seen = job;
          return {};
        },
        { fetchVariables: ["keep"] },
      );
      await engine.deployResources(res(SERVICE_BPMN));
      await engine.createInstance({
        processDefinitionId: "svc",
        variables: { keep: 1, drop: 2 },
        awaitCompletion: true,
      });
      assert.deepEqual(seen?.variables, { keep: 1 });
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

      // openUserTasks is the safe accessor: while the task is open it reports the same task
      // as an unfiltered search, but it pins state=CREATED so a later completion can't leak.
      // The state-filtered search can lag the unfiltered one on an eventually consistent
      // adapter, so poll rather than assuming it surfaces immediately.
      const openBefore = await waitForValue(async () => {
        const found = await engine.openUserTasks({ processInstanceKey });
        return found.length > 0 ? found : undefined;
      });
      assert.equal(openBefore.length, 1, "openUserTasks surfaces the open task");
      assert.equal(openBefore[0].userTaskKey, tasks[0].userTaskKey);

      await engine.completeUserTask(tasks[0].userTaskKey);
      // Once answered, openUserTasks must never surface it as still-actionable (the footgun a
      // bare searchUserTasks leaves open). Poll to tolerate an eventually consistent adapter.
      await waitFor(async () =>
        (await engine.openUserTasks({ processInstanceKey })).length === 0
      );
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

  test(`${label}: searchElementInstances surfaces the active element a parked instance reached`, async () => {
    await withEngine(async (engine) => {
      // No worker registered → the token parks *at* the `work` service task, so it is the
      // furthest element reached — an active non-user-task element a user-task search can't see.
      await engine.deployResources(res(SERVICE_BPMN));
      const { processInstanceKey } = await engine.createInstance({ processDefinitionId: "svc" });

      const els = await waitForValue(async () => {
        const found = await engine.searchElementInstances({ processInstanceKey });
        return found.some((e) => e.elementId === "work") ? found : undefined;
      });
      const work = els.find((e) => e.elementId === "work");
      assert.ok(work, "expected the parked service-task element instance");
      assert.equal(work?.processInstanceKey, processInstanceKey);
      assert.equal(work?.state, "ACTIVE");
      assert.ok(work?.elementInstanceKey, "element instance carries its own key");

      // getElementInstance round-trips that key; a blank/unknown key resolves to null (no throw).
      const byKey = await engine.getElementInstance(work?.elementInstanceKey ?? "");
      assert.equal(byKey?.elementInstanceKey, work?.elementInstanceKey);
      assert.equal(byKey?.elementId, "work");
      assert.equal(await engine.getElementInstance("   "), null);

      // The elementId selector narrows the search.
      const filtered = await engine.searchElementInstances({ processInstanceKey, elementId: "work" });
      assert.deepEqual(filtered.map((e) => e.elementId), ["work"]);
      // A lifecycle state the read model can't serve here yields nothing, never a wrong row.
      const completed = await engine.searchElementInstances({ processInstanceKey, elementId: "work", state: "COMPLETED" });
      assert.deepEqual(completed, []);
    });
  });

  test(`${label}: searchElementInstanceWaitStates surfaces a JOB park (not only user tasks)`, async () => {
    await withEngine(async (engine) => {
      // No worker → the `work` service task parks as a JOB wait state — the job/message parks a
      // user-task search cannot surface, which is the whole point of the wait-states query.
      await engine.deployResources(res(SERVICE_BPMN));
      const { processInstanceKey } = await engine.createInstance({ processDefinitionId: "svc" });

      const waits = await waitForValue(async () => {
        const found = await engine.searchElementInstanceWaitStates({ processInstanceKey });
        return found.length > 0 ? found : undefined;
      });
      const job = waits.find((w) => w.waitStateType === "JOB");
      assert.ok(job, "expected a JOB wait state for the parked service task");
      assert.equal(job?.elementId, "work");
      assert.equal(job?.processInstanceKey, processInstanceKey);
      // The element-instance key resolves to the same one searchElementInstances reports.
      const [byElement] = await engine.searchElementInstances({ processInstanceKey, elementId: "work" });
      assert.equal(job?.elementInstanceKey, byElement?.elementInstanceKey);
      if (job?.waitStateType === "JOB") {
        assert.equal(job.jobType, "work");
      }
      // The waitStateType selector narrows: this model has no MESSAGE park.
      const messages = await engine.searchElementInstanceWaitStates({ processInstanceKey, waitStateType: "MESSAGE" });
      assert.deepEqual(messages, []);
    });
  });

  test(`${label}: a USER_TASK wait-state filter is rejected (deployed floor is JOB|MESSAGE)`, async () => {
    await withEngine(async (engine) => {
      // A native user task parks for a human. It is discoverable — but through the user-task
      // read channel (`searchUserTasks`/`openUserTasks`), NOT the wait-state read model.
      await engine.deployResources(res(USER_TASK_BPMN));
      const { processInstanceKey } = await engine.createInstance({ processDefinitionId: "human" });

      const tasks = await waitForValue(async () => {
        const found = await engine.openUserTasks({ processInstanceKey });
        return found.length > 0 ? found : undefined;
      });
      assert.equal(tasks.length, 1, "the user task is read via the user-task channel");
      assert.equal(tasks[0]?.elementId, "review");

      // The deployed gateway's wait-state read model implements only JOB|MESSAGE, so a
      // `waitStateType: "USER_TASK"` filter is rejected (HTTP 422 against a live gateway). This
      // leg runs against the WASM adapter *and* the live SDK adapter, so an app authoring this
      // filter cannot ship green in emulation while a real engine rejects it — the exact
      // parity gap this contract exists to prevent (issue nanobpm/nano-ide#497).
      await assert.rejects(
        engine.searchElementInstanceWaitStates({ processInstanceKey, waitStateType: "USER_TASK" }),
        (err: unknown) => {
          assert.ok(err instanceof Error, "expected an Error");
          assert.match(err.message, /USER_TASK/);
          return true;
        },
        "a USER_TASK wait-state filter must be rejected, not silently emulated",
      );

      // And an unfiltered wait-state search does not surface the user task as a park — the
      // emulation reports only the floor kinds a live engine would (here: none).
      const waits = await engine.searchElementInstanceWaitStates({ processInstanceKey });
      assert.deepEqual(
        waits.filter((w) => w.waitStateType === "USER_TASK"),
        [],
        "a user task must not appear as a USER_TASK wait state",
      );
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
  { timeoutMs = 10_000, intervalMs = 10 } = {},
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
  { timeoutMs = 10_000, intervalMs = 10 } = {},
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
