// e2e coverage for job-worker mocking (epic #296, S1+S2). Drives the in-process WASM
// adapter directly: registers a small BPMN fixture, mocks a task type, and asserts the
// outcome through the engine's observable state (process-instance state + snapshot
// incidents/variables). Red/Green per outcome (AGENTS.md).
//
// Note on observing completion variables: the engine snapshot drops a COMPLETED instance's
// variables, so fixtures that assert a mock's `completeWith` output park the instance on a
// trailing user task (still ACTIVE) after the mocked service task — the merged variables are
// then visible in `snapshot().instances[].variables`.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createWasmEngineClient, type WasmEngineClient } from "./wasm-engine.ts";
import { applyOutcome, type MockOutcome, type OutcomeEngine } from "./worker-mock.ts";

/** A single service task (`work`) between start and end — completes the whole instance. */
const SVC_BPMN = `<?xml version="1.0" encoding="UTF-8"?>
<definitions xmlns="http://www.omg.org/spec/BPMN/20100524/MODEL"
             xmlns:zeebe="http://camunda.org/schema/zeebe/1.0"
             targetNamespace="http://nanobpm/testkit">
  <process id="svc" isExecutable="true">
    <startEvent id="s"/>
    <sequenceFlow id="f1" sourceRef="s" targetRef="work"/>
    <serviceTask id="work">
      <extensionElements><zeebe:taskDefinition type="work"/></extensionElements>
    </serviceTask>
    <sequenceFlow id="f2" sourceRef="work" targetRef="e"/>
    <endEvent id="e"/>
  </process>
</definitions>`;

/** A service task (`work`) then a user task (`review`): the instance parks ACTIVE on `review`
 *  after `work` completes, so the completion variables are observable in the snapshot. */
const WAIT_BPMN = `<?xml version="1.0" encoding="UTF-8"?>
<definitions xmlns="http://www.omg.org/spec/BPMN/20100524/MODEL"
             xmlns:zeebe="http://camunda.org/schema/zeebe/1.0"
             targetNamespace="http://nanobpm/testkit">
  <process id="wait" isExecutable="true">
    <startEvent id="s"/>
    <sequenceFlow id="f1" sourceRef="s" targetRef="work"/>
    <serviceTask id="work">
      <extensionElements><zeebe:taskDefinition type="work"/></extensionElements>
    </serviceTask>
    <sequenceFlow id="f2" sourceRef="work" targetRef="review"/>
    <userTask id="review"><extensionElements><zeebe:userTask/></extensionElements></userTask>
    <sequenceFlow id="f3" sourceRef="review" targetRef="e"/>
    <endEvent id="e"/>
  </process>
</definitions>`;

/** A service task (`work`) with an error boundary catching errorCode BOOM → alternate end. */
const BOUNDARY_BPMN = `<?xml version="1.0" encoding="UTF-8"?>
<definitions xmlns="http://www.omg.org/spec/BPMN/20100524/MODEL"
             xmlns:zeebe="http://camunda.org/schema/zeebe/1.0"
             targetNamespace="http://nanobpm/testkit">
  <process id="boundary" isExecutable="true">
    <startEvent id="s"/>
    <sequenceFlow id="f1" sourceRef="s" targetRef="work"/>
    <serviceTask id="work">
      <extensionElements><zeebe:taskDefinition type="work"/></extensionElements>
    </serviceTask>
    <sequenceFlow id="f2" sourceRef="work" targetRef="okEnd"/>
    <endEvent id="okEnd"/>
    <boundaryEvent id="caught" attachedToRef="work">
      <errorEventDefinition errorRef="boom"/>
    </boundaryEvent>
    <sequenceFlow id="f3" sourceRef="caught" targetRef="errEnd"/>
    <endEvent id="errEnd"/>
  </process>
  <error id="boom" errorCode="BOOM"/>
</definitions>`;

/** Two sequential service tasks (`a` then `b`) then a user task — used to prove per-type
 *  isolation while keeping the instance ACTIVE so its merged variables stay observable. */
const TWO_BPMN = `<?xml version="1.0" encoding="UTF-8"?>
<definitions xmlns="http://www.omg.org/spec/BPMN/20100524/MODEL"
             xmlns:zeebe="http://camunda.org/schema/zeebe/1.0"
             targetNamespace="http://nanobpm/testkit">
  <process id="two" isExecutable="true">
    <startEvent id="s"/>
    <sequenceFlow id="f1" sourceRef="s" targetRef="ta"/>
    <serviceTask id="ta">
      <extensionElements><zeebe:taskDefinition type="a"/></extensionElements>
    </serviceTask>
    <sequenceFlow id="f2" sourceRef="ta" targetRef="tb"/>
    <serviceTask id="tb">
      <extensionElements><zeebe:taskDefinition type="b"/></extensionElements>
    </serviceTask>
    <sequenceFlow id="f3" sourceRef="tb" targetRef="review"/>
    <userTask id="review"><extensionElements><zeebe:userTask/></extensionElements></userTask>
    <sequenceFlow id="f4" sourceRef="review" targetRef="e"/>
    <endEvent id="e"/>
  </process>
</definitions>`;

function res(name: string, content: string): { name: string; content: string; contentType: string }[] {
  return [{ name, content, contentType: "text/xml" }];
}

/** Boot an engine, deploy `bpmn`, run `body`, and always close. */
async function withEngine(
  bpmn: { name: string; xml: string },
  body: (engine: WasmEngineClient) => Promise<void>,
): Promise<void> {
  const engine = await createWasmEngineClient();
  try {
    await engine.deployResources(res(bpmn.name, bpmn.xml));
    await body(engine);
  } finally {
    await engine.close();
  }
}

/** The `incidents` array from a snapshot as `reason` strings. */
function incidentReasons(engine: WasmEngineClient): string[] {
  const raw = engine.snapshot().incidents;
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const inc of raw) {
    if (inc && typeof inc === "object") {
      const reason = Reflect.get(inc, "reason");
      if (typeof reason === "string") out.push(reason);
    }
  }
  return out;
}

/** A single instance's variables from the snapshot. */
function instanceVariables(engine: WasmEngineClient, key: string): Record<string, unknown> {
  const raw = engine.snapshot().instances;
  if (!Array.isArray(raw)) return {};
  for (const inst of raw) {
    if (inst && typeof inst === "object" && String(Reflect.get(inst, "key")) === key) {
      const vars = Reflect.get(inst, "variables");
      if (vars && typeof vars === "object" && !Array.isArray(vars)) return { ...vars };
    }
  }
  return {};
}

test("mock: completeWith completes the job, driving the instance forward with the given variables", async () => {
  await withEngine({ name: "wait.bpmn", xml: WAIT_BPMN }, async (engine) => {
    // No real worker is registered for `work` at all — the mock fully stands in for it.
    engine.mockWorker("work").completeWith({ mocked: true, answer: 42 });
    const { processInstanceKey } = await engine.createInstance({ processDefinitionId: "wait" });
    const [inst] = await engine.searchProcessInstances({ processInstanceKeys: [processInstanceKey] });
    // `work` completed (mock stood in) so the token advanced to the user task — the instance is
    // ACTIVE on `review`, NOT parked on `work` with an incident.
    assert.equal(inst?.state, "ACTIVE", "the mock completed `work`; the instance advanced to the user task");
    const vars = instanceVariables(engine, processInstanceKey);
    assert.equal(vars.mocked, true, "mocked completion variables merged onto the instance");
    assert.equal(vars.answer, 42);
    assert.equal(incidentReasons(engine).length, 0, "a completion raises no incident");
  });
});

test("mock: completeWith drives a single-task process all the way to COMPLETED", async () => {
  await withEngine({ name: "svc.bpmn", xml: SVC_BPMN }, async (engine) => {
    engine.mockWorker("work").completeWith({ done: true });
    const { processInstanceKey } = await engine.createInstance({ processDefinitionId: "svc" });
    const [inst] = await engine.searchProcessInstances({ processInstanceKeys: [processInstanceKey] });
    assert.equal(inst?.state, "COMPLETED", "the mock completed the only task, so the instance finished");
  });
});

test("mock: failWith default (retries 0) parks the instance ACTIVE on an incident", async () => {
  await withEngine({ name: "svc.bpmn", xml: SVC_BPMN }, async (engine) => {
    engine.mockWorker("work").failWith({ message: "mock said no" });
    const { processInstanceKey } = await engine.createInstance({ processDefinitionId: "svc" });
    const [inst] = await engine.searchProcessInstances({ processInstanceKeys: [processInstanceKey] });
    assert.equal(inst?.state, "ACTIVE", "a zero-retry failure must not complete the instance");
    assert.ok(incidentReasons(engine).includes("mock said no"), "the failure raised an incident carrying the message");
  });
});

test("mock: raiseIncident yields an incident visible in the engine snapshot", async () => {
  await withEngine({ name: "svc.bpmn", xml: SVC_BPMN }, async (engine) => {
    engine.mockWorker("work").raiseIncident({ message: "manual incident" });
    const { processInstanceKey } = await engine.createInstance({ processDefinitionId: "svc" });
    const [inst] = await engine.searchProcessInstances({ processInstanceKeys: [processInstanceKey] });
    assert.equal(inst?.state, "ACTIVE");
    assert.ok(incidentReasons(engine).includes("manual incident"), "raiseIncident surfaces an incident with its message");
  });
});

test("mock: throwBpmnError takes the modelled error-boundary flow (instance completes via the boundary)", async () => {
  await withEngine({ name: "boundary.bpmn", xml: BOUNDARY_BPMN }, async (engine) => {
    engine.mockWorker("work").throwBpmnError("BOOM", "mocked boom");
    const { processInstanceKey } = await engine.createInstance({ processDefinitionId: "boundary" });
    const [inst] = await engine.searchProcessInstances({ processInstanceKeys: [processInstanceKey] });
    // The BPMN error was caught by the boundary → COMPLETED (a plain failure would leave it ACTIVE on an incident).
    assert.equal(inst?.state, "COMPLETED", "the mocked BPMN error drove the error boundary, not an incident");
  });
});

test("mock: when(predicate) is first-match-wins in registration order, falling through to the real handler", async () => {
  await withEngine({ name: "wait.bpmn", xml: WAIT_BPMN }, async (engine) => {
    // A real handler stamps who handled the job; the mock only intercepts specific tiers.
    await engine.registerWorker("work", (job) => ({ handledBy: "real", who: job.variables.who }));
    engine
      .mockWorker("work")
      .when((job) => job.variables.tier === "gold").completeWith({ handledBy: "mock", tier: "gold" })
      .when((job) => job.variables.tier === "silver").completeWith({ handledBy: "mock", tier: "silver" });

    const gold = await engine.createInstance({ processDefinitionId: "wait", variables: { tier: "gold" } });
    assert.equal(instanceVariables(engine, gold.processInstanceKey).handledBy, "mock", "gold matched the first clause");
    assert.equal(instanceVariables(engine, gold.processInstanceKey).tier, "gold");

    const silver = await engine.createInstance({ processDefinitionId: "wait", variables: { tier: "silver" } });
    assert.equal(instanceVariables(engine, silver.processInstanceKey).tier, "silver", "silver matched the second clause");

    // A job matching no clause falls through to the real handler.
    const bronze = await engine.createInstance({ processDefinitionId: "wait", variables: { tier: "bronze", who: "b" } });
    const bronzeVars = instanceVariables(engine, bronze.processInstanceKey);
    assert.equal(bronzeVars.handledBy, "real", "an unmatched job ran the real handler");
    assert.equal(bronzeVars.who, "b");
  });
});

test("mock: an unconditional default matches every job (a preceding when(...) can still win)", async () => {
  await withEngine({ name: "wait.bpmn", xml: WAIT_BPMN }, async (engine) => {
    engine
      .mockWorker("work")
      .when((job) => job.variables.special === true).completeWith({ path: "special" })
      .completeWith({ path: "default" });

    const special = await engine.createInstance({ processDefinitionId: "wait", variables: { special: true } });
    assert.equal(instanceVariables(engine, special.processInstanceKey).path, "special");

    const plain = await engine.createInstance({ processDefinitionId: "wait", variables: { special: false } });
    assert.equal(instanceVariables(engine, plain.processInstanceKey).path, "default", "the unconditional default caught the rest");
  });
});

test("mock: a mock on type A leaves un-mocked type B running its real handler", async () => {
  await withEngine({ name: "two.bpmn", xml: TWO_BPMN }, async (engine) => {
    let bRan = false;
    await engine.registerWorker("a", () => {
      throw new Error("real A must NOT run — it is mocked");
    });
    await engine.registerWorker("b", () => {
      bRan = true;
      return { bDone: true };
    });
    engine.mockWorker("a").completeWith({ aMocked: true });

    const { processInstanceKey } = await engine.createInstance({ processDefinitionId: "two" });
    const [inst] = await engine.searchProcessInstances({ processInstanceKeys: [processInstanceKey] });
    assert.equal(inst?.state, "ACTIVE", "A mocked + B real both ran; the instance advanced to the user task");
    assert.equal(bRan, true, "the un-mocked type B executed real code");
    const vars = instanceVariables(engine, processInstanceKey);
    assert.equal(vars.aMocked, true);
    assert.equal(vars.bDone, true);
  });
});

test("mock: reset() removes the mock and restores the real handler", async () => {
  await withEngine({ name: "wait.bpmn", xml: WAIT_BPMN }, async (engine) => {
    let realRuns = 0;
    await engine.registerWorker("work", () => {
      realRuns += 1;
      return { handledBy: "real" };
    });

    const mock = engine.mockWorker("work").completeWith({ handledBy: "mock" });
    const first = await engine.createInstance({ processDefinitionId: "wait" });
    assert.equal(instanceVariables(engine, first.processInstanceKey).handledBy, "mock");
    assert.equal(realRuns, 0, "the real handler was shadowed while mocked");

    mock.reset();
    const second = await engine.createInstance({ processDefinitionId: "wait" });
    assert.equal(instanceVariables(engine, second.processInstanceKey).handledBy, "real", "reset restored real behaviour");
    assert.equal(realRuns, 1, "the real handler ran once after reset");

    // clearWorkerMock is the equivalent removal path.
    engine.mockWorker("work").completeWith({ handledBy: "mock-again" });
    engine.clearWorkerMock("work");
    const third = await engine.createInstance({ processDefinitionId: "wait" });
    assert.equal(instanceVariables(engine, third.processInstanceKey).handledBy, "real", "clearWorkerMock also restores real behaviour");
  });
});

test("mock: the deterministic drain still reaches a fixpoint under a mock (no hang)", async () => {
  await withEngine({ name: "two.bpmn", xml: TWO_BPMN }, async (engine) => {
    // Both task types mocked to complete: the whole process drains to the user task synchronously.
    engine.mockWorker("a").completeWith({ a: 1 });
    engine.mockWorker("b").completeWith({ b: 2 });
    const { processInstanceKey } = await engine.createInstance({ processDefinitionId: "two" });
    // drain() returning (createInstance awaited it) without throwing the "did not quiesce" guard
    // proves the mock path is a fixpoint. A second explicit drain must also be a no-op.
    await engine.drain();
    const vars = instanceVariables(engine, processInstanceKey);
    assert.equal(vars.a, 1, "both mocked tasks drained deterministically");
    assert.equal(vars.b, 2);
  });
});

test("mock: mockWorker(type) is idempotent — repeated calls return the same builder and accumulate clauses", async () => {
  await withEngine({ name: "wait.bpmn", xml: WAIT_BPMN }, async (engine) => {
    const a = engine.mockWorker("work");
    const b = engine.mockWorker("work");
    assert.equal(a, b, "the same builder instance is returned for a type");
    a.when((job) => job.variables.n === 1).completeWith({ clause: "one" });
    b.when((job) => job.variables.n === 2).completeWith({ clause: "two" });
    const one = await engine.createInstance({ processDefinitionId: "wait", variables: { n: 1 } });
    const two = await engine.createInstance({ processDefinitionId: "wait", variables: { n: 2 } });
    assert.equal(instanceVariables(engine, one.processInstanceKey).clause, "one");
    assert.equal(instanceVariables(engine, two.processInstanceKey).clause, "two");
  });
});

test("applyOutcome: an unknown outcome kind is rejected (the S5 exhaustiveness seam is real at runtime too)", () => {
  // The exhaustiveness guard is primarily a COMPILE-time seam (a new engine completion method
  // ⇒ a new MockOutcome variant ⇒ a non-exhaustive switch ⇒ a type error). This runtime probe
  // proves the same guard fails loudly rather than silently falling through, so a malformed
  // outcome that slips past the type system (here fabricated via JSON.parse to dodge the `as`
  // ban) cannot leave a job silently un-resolved. Before the `never` guard the switch simply
  // returned, silently dropping the job.
  const calls: string[] = [];
  const engine: OutcomeEngine = {
    completeJob: () => calls.push("complete"),
    failJob: () => calls.push("fail"),
    throwError: () => calls.push("throw"),
  };
  const bogus: MockOutcome = JSON.parse('{"kind":"__nope__"}');
  assert.throws(() => applyOutcome(engine, "job-1", bogus), /unhandled mock outcome|__nope__/i);
  assert.deepEqual(calls, [], "an unknown outcome must resolve through no engine call");
});

test("mock: a completeWith outcome the engine can't serialize fails the job instead of aborting the drain", async () => {
  await withEngine({ name: "svc.bpmn", xml: SVC_BPMN }, async (engine) => {
    // A BigInt is not JSON-serializable, so `applyOutcome`'s `JSON.stringify(variables)` throws —
    // exactly like the real handler path's `JSON.stringify(out)` would. That throw must be caught
    // and turned into a failJob/incident (mirroring the real path), NOT escape `#runJob` and abort
    // the whole drain. Before the fix the drain threw the raw TypeError out of createInstance.
    engine.mockWorker("work").completeWith({ big: 1n });
    const { processInstanceKey } = await engine.createInstance({ processDefinitionId: "svc" });
    const [inst] = await engine.searchProcessInstances({ processInstanceKeys: [processInstanceKey] });
    assert.equal(inst?.state, "ACTIVE", "an unserializable completion must not complete the instance");
    assert.ok(
      incidentReasons(engine).some((r) => /bigint/i.test(r)),
      "the serialization failure surfaced as an incident carrying the error message",
    );
  });
});
