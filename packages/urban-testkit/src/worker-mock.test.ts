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
import type { EngineJob } from "@nanobpm/urban/runtime";
import { createWasmEngineClient, type WasmEngineClient } from "./wasm-engine.ts";
import {
  applyOutcome,
  MockWorkerBuilder,
  type MockOutcome,
  type OutcomeEngine,
} from "./worker-mock.ts";

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

test("mock+coverage: a mock-only type whose clauses don't match is NOT recorded as exercised (no fabricated coverage)", async () => {
  await withEngine({ name: "wait.bpmn", xml: WAIT_BPMN }, async (engine) => {
    // A mock-only type (`work` has a mock but no registered real worker) whose sole clause never
    // matches: `resolve()` returns undefined, so NOTHING runs for the dispatched job — it is left
    // locked. The coverage observer must therefore NOT be told the type was exercised; otherwise a
    // job that no mock and no handler serviced would fabricate coverage and hide a genuine gap.
    const seen: { jobType: string; mocked: boolean }[] = [];
    engine.observeJobs((jobType, mocked) => seen.push({ jobType, mocked }));
    engine.mockWorker("work").when(() => false).completeWith({ never: true });
    await engine.createInstance({ processDefinitionId: "wait" });
    assert.deepEqual(
      seen,
      [],
      "an unsatisfied mock-only dispatch (no matching clause, no real handler) must not count as exercised",
    );
  });
});

test("mock: failWith clamps retries to a finite, non-negative integer (negative, NaN and fractional inputs)", () => {
  const job: EngineJob = { jobKey: "k", jobType: "work", variables: {} };
  const retriesFor = (retries: number): number => {
    const outcome = new MockWorkerBuilder(() => {}).failWith({ retries }).resolve(job);
    assert.ok(outcome !== undefined && outcome.kind === "fail", "failWith yields a fail outcome");
    return outcome.retries;
  };
  assert.equal(retriesFor(-3), 0, "a negative retry count clamps to 0");
  assert.equal(retriesFor(Number.NaN), 0, "NaN clamps to 0");
  assert.equal(retriesFor(Number.POSITIVE_INFINITY), 0, "a non-finite retry count clamps to 0");
  assert.equal(retriesFor(2.7), 2, "a fractional retry count truncates to an integer");
  assert.equal(retriesFor(4), 4, "a valid non-negative integer is preserved");
});

test("mock: a second consecutive when(...) with no intervening outcome fails fast", () => {
  const armed = new MockWorkerBuilder(() => {});
  assert.throws(
    () => armed.when(() => true).when(() => false),
    /when\(\)/i,
    "overwriting an already-armed predicate silently is a footgun — the second when() must throw",
  );
  // A when() consumed by an outcome re-arms cleanly for the next clause.
  const chained = new MockWorkerBuilder(() => {});
  assert.doesNotThrow(
    () =>
      chained
        .when(() => true)
        .completeWith({ ok: 1 })
        .when(() => false)
        .completeWith({ ok: 2 }),
    "when()->outcome->when()->outcome is the supported chaining shape",
  );
});

test("mock: a reset() builder is tombstoned — re-arming a removed builder fails fast", () => {
  const b = new MockWorkerBuilder(() => {}).completeWith({ ok: 1 });
  assert.equal(b.hasClauses, true, "the builder is armed before reset");
  b.reset();
  assert.equal(b.hasClauses, false, "reset drops every clause");
  // A removed builder must not be silently re-armed: clauses added after reset never affect
  // dispatch (it is deregistered), so mutating it is a footgun that must fail fast.
  assert.throws(
    () => b.completeWith({ ok: 2 }),
    /reset/i,
    "adding an outcome to a reset() builder must throw, not silently accumulate a dead clause",
  );
  assert.throws(
    () => b.when(() => true),
    /reset/i,
    "arming a predicate on a reset() builder must throw",
  );
  assert.equal(b.hasClauses, false, "a rejected mutation leaves the builder inert");
  // reset() is idempotent — a second call on an already-removed builder is a no-op.
  assert.doesNotThrow(() => b.reset(), "reset() is idempotent on an already-removed builder");
});

test("mock: clearWorkerMock clears a still-held builder's state, not just the registry entry", async () => {
  await withEngine({ name: "wait.bpmn", xml: WAIT_BPMN }, async (engine) => {
    const mock = engine.mockWorker("work").completeWith({ handledBy: "mock" });
    assert.equal(mock.hasClauses, true, "the builder is armed while mocked");
    engine.clearWorkerMock("work");
    assert.equal(
      mock.hasClauses,
      false,
      "clearWorkerMock must also clear a caller-held builder's clauses (equivalent to reset())",
    );
  });
});
