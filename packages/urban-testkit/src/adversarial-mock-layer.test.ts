// Adversarial completeness & regression for the mock layer (epic #296, S5).
//
// This suite proves the *merged* mock layer — job-worker mocking (S1+S2, `worker-mock.ts`) and
// child-process / call-activity mocking (S3, `child-process-mock.ts`) — is airtight along the
// axes a future regression is most likely to break silently:
//
//   1. Negative / isolation — a mock on one type/process must not leak onto another, un-mocked
//      types/processes must still run real code, and removing a mock must restore real behaviour.
//   2. Outcome fidelity — each worker outcome must actually surface in observable instance state
//      (completion variables merged, incident raised, BPMN error boundary taken).
//   3. Condition correctness — `when(predicate)` matches only the intended jobs, first-match wins
//      in registration order, and a non-matching job falls through to the next rule / real handler.
//
// Everything is asserted through the engine's *observable* surface (process-instance state +
// snapshot incidents/variables) rather than mock internals, and everything is deterministic (the
// drain reaches a fixpoint under the virtual clock). Runs on Node and Deno.
//
// A separate `mock-completeness-guard.test.ts` proves the mock layer's outcome inventory and
// `when(...)`-matchable fields are DERIVED (a new engine outcome without a builder+test is a red
// build); `adversarial-determinism.test.ts` proves — at runtime and statically — that the mock
// layer introduces no wall-clock/randomness.

import { test } from "node:test";
import assert from "node:assert/strict";
import type { EngineJob } from "@nanobpm/urban/runtime";
import { createWasmEngineClient, type WasmEngineClient } from "./wasm-engine.ts";
import { MockWorkerBuilder, type MockOutcome } from "./worker-mock.ts";

// ---------------------------------------------------------------------------------------------
// Fixtures (mirror the styles the S1/S2 and S3 suites use).
// ---------------------------------------------------------------------------------------------

/** A single service task (`work`) — completes the whole instance when `work` completes. */
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
 *  after `work` completes, so its merged variables stay observable in the snapshot. */
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

/** Three sequential service tasks (`a` → `b` → `c`) then a user task — used to prove per-type
 *  isolation across several types at once while keeping the instance ACTIVE. */
const THREE_BPMN = `<?xml version="1.0" encoding="UTF-8"?>
<definitions xmlns="http://www.omg.org/spec/BPMN/20100524/MODEL"
             xmlns:zeebe="http://camunda.org/schema/zeebe/1.0"
             targetNamespace="http://nanobpm/testkit">
  <process id="three" isExecutable="true">
    <startEvent id="s"/>
    <sequenceFlow id="f1" sourceRef="s" targetRef="ta"/>
    <serviceTask id="ta"><extensionElements><zeebe:taskDefinition type="a"/></extensionElements></serviceTask>
    <sequenceFlow id="f2" sourceRef="ta" targetRef="tb"/>
    <serviceTask id="tb"><extensionElements><zeebe:taskDefinition type="b"/></extensionElements></serviceTask>
    <sequenceFlow id="f3" sourceRef="tb" targetRef="tc"/>
    <serviceTask id="tc"><extensionElements><zeebe:taskDefinition type="c"/></extensionElements></serviceTask>
    <sequenceFlow id="f4" sourceRef="tc" targetRef="review"/>
    <userTask id="review"><extensionElements><zeebe:userTask/></extensionElements></userTask>
  </process>
</definitions>`;

/** Parent with two call activities in sequence (childA → childB) then a user task — for
 *  per-child-process isolation. */
const PARENT_TWO = `<?xml version="1.0" encoding="UTF-8"?>
<definitions xmlns="http://www.omg.org/spec/BPMN/20100524/MODEL"
             xmlns:zeebe="http://camunda.org/schema/zeebe/1.0"
             targetNamespace="http://nanobpm/testkit">
  <process id="parent" isExecutable="true">
    <startEvent id="s"/>
    <sequenceFlow id="f1" sourceRef="s" targetRef="caA"/>
    <callActivity id="caA">
      <extensionElements><zeebe:calledElement processId="childA" propagateAllChildVariables="true"/></extensionElements>
    </callActivity>
    <sequenceFlow id="f2" sourceRef="caA" targetRef="caB"/>
    <callActivity id="caB">
      <extensionElements><zeebe:calledElement processId="childB" propagateAllChildVariables="true"/></extensionElements>
    </callActivity>
    <sequenceFlow id="f3" sourceRef="caB" targetRef="review"/>
    <userTask id="review"><extensionElements><zeebe:userTask/></extensionElements></userTask>
  </process>
</definitions>`;

/** A real child process carrying a marker service task, so a test can prove the real called
 *  process never runs when its call activity is mocked (the worker counter stays 0). */
function childModel(processId: string, taskType: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<definitions xmlns="http://www.omg.org/spec/BPMN/20100524/MODEL"
             xmlns:zeebe="http://camunda.org/schema/zeebe/1.0"
             targetNamespace="http://nanobpm/testkit">
  <process id="${processId}" isExecutable="true">
    <startEvent id="cs"/>
    <sequenceFlow id="cf1" sourceRef="cs" targetRef="cwork"/>
    <serviceTask id="cwork"><extensionElements><zeebe:taskDefinition type="${taskType}"/></extensionElements></serviceTask>
    <sequenceFlow id="cf2" sourceRef="cwork" targetRef="ce"/>
    <endEvent id="ce"/>
  </process>
</definitions>`;
}

// ---------------------------------------------------------------------------------------------
// Helpers.
// ---------------------------------------------------------------------------------------------

function res(...models: { name: string; xml: string }[]): { name: string; content: string; contentType: string }[] {
  return models.map((m) => ({ name: m.name, content: m.xml, contentType: "text/xml" }));
}

/** Boot an engine, deploy `models`, run `body`, and always close. */
async function withEngine(
  models: { name: string; xml: string }[],
  body: (engine: WasmEngineClient) => Promise<void>,
): Promise<void> {
  const engine = await createWasmEngineClient();
  try {
    await engine.deployResources(res(...models));
    await body(engine);
  } finally {
    await engine.close();
  }
}

/** The `reason` strings of a snapshot's incidents. */
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

/** Resolve a `failWith(...)` to its {@link MockOutcome} without a drain — a fast probe of the retry
 *  budget the engine would receive, dodging the non-quiescing positive-retry drive-through. */
function engine_failWithProbe(retries: number | undefined, message: string | undefined): MockOutcome {
  const opts = retries === undefined && message === undefined ? undefined : { retries, message };
  const job: EngineJob = { jobKey: "probe", jobType: "work", variables: {} };
  const outcome = new MockWorkerBuilder(() => {}).failWith(opts).resolve(job);
  assert.ok(outcome !== undefined, "failWith always yields an outcome");
  return outcome;
}

// =============================================================================================
// 1. Negative / isolation.
// =============================================================================================

test("isolation: a mock on type A leaves B and C running real code (multi-type)", async () => {
  await withEngine([{ name: "three.bpmn", xml: THREE_BPMN }], async (engine) => {
    const realRan: string[] = [];
    await engine.registerWorker("a", () => {
      throw new Error("real A must NOT run — it is mocked");
    });
    await engine.registerWorker("b", () => {
      realRan.push("b");
      return { bDone: true };
    });
    await engine.registerWorker("c", () => {
      realRan.push("c");
      return { cDone: true };
    });
    // Only A is mocked.
    engine.mockWorker("a").completeWith({ aMocked: true });

    const { processInstanceKey } = await engine.createInstance({ processDefinitionId: "three" });
    const [inst] = await engine.searchProcessInstances({ processInstanceKeys: [processInstanceKey] });
    assert.equal(inst?.state, "ACTIVE", "A mocked, B and C real — the instance advanced to the user task");
    assert.deepEqual(realRan, ["b", "c"], "the un-mocked types B and C both executed real code, in order");
    const vars = instanceVariables(engine, processInstanceKey);
    assert.equal(vars.aMocked, true, "A's mocked completion merged");
    assert.equal(vars.bDone, true);
    assert.equal(vars.cDone, true);
  });
});

test("isolation: removing one of several mocks restores only that type's real behaviour", async () => {
  await withEngine([{ name: "three.bpmn", xml: THREE_BPMN }], async (engine) => {
    const realRan: string[] = [];
    for (const type of ["a", "b", "c"]) {
      await engine.registerWorker(type, () => {
        realRan.push(type);
        return { [`${type}Real`]: true };
      });
    }
    engine.mockWorker("a").completeWith({ aMocked: true });
    const mockB = engine.mockWorker("b").completeWith({ bMocked: true });
    engine.mockWorker("c").completeWith({ cMocked: true });

    // Remove only B's mock → B resumes real, A and C stay mocked.
    mockB.reset();

    const { processInstanceKey } = await engine.createInstance({ processDefinitionId: "three" });
    assert.deepEqual(realRan, ["b"], "only B's real handler ran after its mock was removed");
    const vars = instanceVariables(engine, processInstanceKey);
    assert.equal(vars.aMocked, true, "A stayed mocked");
    assert.equal(vars.bReal, true, "B ran real code");
    assert.equal(vars.bMocked, undefined, "B's mock no longer applied");
    assert.equal(vars.cMocked, true, "C stayed mocked");
  });
});

test("isolation: mocking child-process X does not affect un-mocked child-process Y", async () => {
  await withEngine(
    [
      { name: "parent.bpmn", xml: PARENT_TWO },
      { name: "childA.bpmn", xml: childModel("childA", "childAwork") },
      { name: "childB.bpmn", xml: childModel("childB", "childBwork") },
    ],
    async (engine) => {
      let childAReal = 0;
      let childBReal = 0;
      await engine.registerWorker("childAwork", () => {
        childAReal += 1;
        return {};
      });
      await engine.registerWorker("childBwork", () => {
        childBReal += 1;
        return { childBRealRan: true };
      });

      // Only childA is mocked; childB keeps its native call-activity pass-through.
      engine.mockChildProcess("childA").completeWith({ fromA: 1 });

      const { processInstanceKey } = await engine.createInstance({ processDefinitionId: "parent" });
      const [inst] = await engine.searchProcessInstances({ processInstanceKeys: [processInstanceKey] });
      assert.equal(inst?.state, "ACTIVE", "both call activities resolved; the parent parked on the user task");
      assert.equal(childAReal, 0, "the mocked child process A never executed its real called process");
      assert.equal(childBReal, 0, "an un-mocked call activity is a native pass-through — it does not run the child either");
      const vars = instanceVariables(engine, processInstanceKey);
      assert.equal(vars.fromA, 1, "only the mocked child A merged variables; B stayed a bare pass-through");
      assert.equal(vars.childBRealRan, undefined, "child B's real called process did not run");
    },
  );
});

test("isolation: a worker mock and a child-process mock keyed the same name never cross-fire", async () => {
  // A worker mock keyed "shared" and a child-process mock keyed "shared" live in separate
  // registries on separate dispatch seams (job dispatch vs. the synthetic call-activity job).
  // They must not intercept each other's dispatch.
  await withEngine(
    [
      { name: "svc.bpmn", xml: SVC_BPMN.replace(/"work"/g, '"shared"') },
    ],
    async (engine) => {
      engine.mockChildProcess("shared").completeWith({ fromChild: true }); // unrelated registry
      engine.mockWorker("shared").completeWith({ fromWorker: true });
      const { processInstanceKey } = await engine.createInstance({ processDefinitionId: "svc" });
      const [inst] = await engine.searchProcessInstances({ processInstanceKeys: [processInstanceKey] });
      assert.equal(inst?.state, "COMPLETED", "the service-task job was serviced by the worker mock");
      // The child-process registry entry never fired (there is no call activity), so no error and
      // the worker mock alone drove the instance to completion.
      assert.equal(incidentReasons(engine).length, 0, "no cross-fire between the two same-named registries");
    },
  );
});

// =============================================================================================
// 2. Outcome fidelity — each outcome surfaces in observable instance state.
// =============================================================================================

test("fidelity: completeWith surfaces the exact merged variables on the instance", async () => {
  await withEngine([{ name: "wait.bpmn", xml: WAIT_BPMN }], async (engine) => {
    engine.mockWorker("work").completeWith({ a: 1, nested: { deep: [true, "x"] }, kept: "yes" });
    const { processInstanceKey } = await engine.createInstance({
      processDefinitionId: "wait",
      variables: { seed: "keep-me" },
    });
    const vars = instanceVariables(engine, processInstanceKey);
    assert.equal(vars.a, 1);
    assert.deepEqual(vars.nested, { deep: [true, "x"] }, "structured completion variables round-trip verbatim");
    assert.equal(vars.kept, "yes");
    assert.equal(vars.seed, "keep-me", "pre-existing instance variables are preserved (merge, not replace)");
    assert.equal(incidentReasons(engine).length, 0);
  });
});

test("fidelity: failWith carries its retry budget on the resolved outcome (retries preserved, message set)", () => {
  // Determinism boundary (documented, not a defect to fix here): a worker `failWith` applies a
  // *fixed* retry budget every time it resolves. When it drives a mock-only type (no advancing real
  // handler), the engine re-activates the failed job with no backoff under the virtual clock and the
  // mock re-applies the same fixed budget, so a POSITIVE-retry failure never reaches a drain
  // fixpoint (the drain's MAX_DRAIN_ITERATIONS guard is the safety net). This mirrors the merged
  // child-process slice, whose `failWith` is deliberately incident-only for exactly this reason.
  // Terminal, deterministically-drivable failures therefore use `retries: 0` (→ incident), asserted
  // in the two tests below. Here we assert the retry budget is faithfully carried on the resolved
  // outcome — fast and drain-free — so the value the engine would receive is correct.
  const b = engine_failWithProbe(2, "retry me");
  assert.equal(b.kind, "fail");
  assert.equal(b.kind === "fail" && b.retries, 2, "the positive retry budget is preserved on the fail outcome");
  assert.equal(b.kind === "fail" && b.message, "retry me", "the message is carried through");
  const dflt = engine_failWithProbe(undefined, undefined);
  assert.equal(dflt.kind === "fail" && dflt.retries, 0, "failWith defaults to a zero-retry (incident) failure");
});

test("fidelity: failWith default (retries 0) raises an incident carrying the message", async () => {
  await withEngine([{ name: "svc.bpmn", xml: SVC_BPMN }], async (engine) => {
    engine.mockWorker("work").failWith({ message: "hard stop" });
    const { processInstanceKey } = await engine.createInstance({ processDefinitionId: "svc" });
    const [inst] = await engine.searchProcessInstances({ processInstanceKeys: [processInstanceKey] });
    assert.equal(inst?.state, "ACTIVE", "a zero-retry failure must not complete the instance");
    assert.ok(incidentReasons(engine).includes("hard stop"), "the incident carries the failWith message");
  });
});

test("fidelity: raiseIncident yields an incident visible in the snapshot", async () => {
  await withEngine([{ name: "svc.bpmn", xml: SVC_BPMN }], async (engine) => {
    engine.mockWorker("work").raiseIncident({ message: "explicit incident" });
    const { processInstanceKey } = await engine.createInstance({ processDefinitionId: "svc" });
    const [inst] = await engine.searchProcessInstances({ processInstanceKeys: [processInstanceKey] });
    assert.equal(inst?.state, "ACTIVE");
    assert.ok(incidentReasons(engine).includes("explicit incident"), "raiseIncident surfaces its message");
  });
});

test("fidelity: throwBpmnError(code) takes the matching error-boundary flow (not an incident)", async () => {
  await withEngine([{ name: "boundary.bpmn", xml: BOUNDARY_BPMN }], async (engine) => {
    engine.mockWorker("work").throwBpmnError("BOOM", "mocked boom");
    const { processInstanceKey } = await engine.createInstance({ processDefinitionId: "boundary" });
    const [inst] = await engine.searchProcessInstances({ processInstanceKeys: [processInstanceKey] });
    assert.equal(inst?.state, "COMPLETED", "the BPMN error was caught by the boundary and drove the instance to completion");
    assert.equal(incidentReasons(engine).length, 0, "a caught BPMN error raises no incident");
  });
});

test("fidelity: throwBpmnError with a NON-matching code raises an incident instead of being caught", async () => {
  await withEngine([{ name: "boundary.bpmn", xml: BOUNDARY_BPMN }], async (engine) => {
    // The boundary only catches BOOM; an unmatched error code is an uncaught BPMN error → incident,
    // NOT a silent completion. This proves throwBpmnError routes by code, not unconditionally.
    engine.mockWorker("work").throwBpmnError("NOPE", "unmatched boom");
    const { processInstanceKey } = await engine.createInstance({ processDefinitionId: "boundary" });
    const [inst] = await engine.searchProcessInstances({ processInstanceKeys: [processInstanceKey] });
    assert.notEqual(inst?.state, "COMPLETED", "an unmatched error code must not be silently caught by the BOOM boundary");
  });
});

// =============================================================================================
// 3. Condition correctness.
// =============================================================================================

test("conditions: first-match wins over three tiers, in registration order", async () => {
  await withEngine([{ name: "wait.bpmn", xml: WAIT_BPMN }], async (engine) => {
    engine
      .mockWorker("work")
      .when((job) => job.variables.tier === "gold").completeWith({ picked: "gold" })
      .when((job) => job.variables.tier === "silver").completeWith({ picked: "silver" })
      .when((job) => job.variables.tier === "bronze").completeWith({ picked: "bronze" });

    for (const tier of ["gold", "silver", "bronze"]) {
      const { processInstanceKey } = await engine.createInstance({
        processDefinitionId: "wait",
        variables: { tier },
      });
      assert.equal(instanceVariables(engine, processInstanceKey).picked, tier, `${tier} matched its own clause`);
    }
  });
});

test("conditions: an earlier clause shadows a later one that would also match", async () => {
  await withEngine([{ name: "wait.bpmn", xml: WAIT_BPMN }], async (engine) => {
    // Both clauses match a vip gold job; the FIRST registered must win.
    engine
      .mockWorker("work")
      .when((job) => job.variables.vip === true).completeWith({ by: "vip-clause" })
      .when((job) => job.variables.tier === "gold").completeWith({ by: "gold-clause" });

    const { processInstanceKey } = await engine.createInstance({
      processDefinitionId: "wait",
      variables: { vip: true, tier: "gold" },
    });
    assert.equal(instanceVariables(engine, processInstanceKey).by, "vip-clause", "the earlier matching clause wins");
  });
});

test("conditions: a job matching no clause falls through to the real handler", async () => {
  await withEngine([{ name: "wait.bpmn", xml: WAIT_BPMN }], async (engine) => {
    let realRan = false;
    await engine.registerWorker("work", (job) => {
      realRan = true;
      return { by: "real", echo: job.variables.echo };
    });
    engine.mockWorker("work").when((job) => job.variables.tier === "gold").completeWith({ by: "mock" });

    const { processInstanceKey } = await engine.createInstance({
      processDefinitionId: "wait",
      variables: { tier: "bronze", echo: 7 },
    });
    const vars = instanceVariables(engine, processInstanceKey);
    assert.equal(realRan, true, "an unmatched job fell through to the real handler");
    assert.equal(vars.by, "real");
    assert.equal(vars.echo, 7);
  });
});

test("conditions: a when(...) clause can fall through to a later unconditional default", async () => {
  await withEngine([{ name: "wait.bpmn", xml: WAIT_BPMN }], async (engine) => {
    engine
      .mockWorker("work")
      .when((job) => job.variables.special === true).completeWith({ path: "special" })
      .completeWith({ path: "default" });

    const special = await engine.createInstance({ processDefinitionId: "wait", variables: { special: true } });
    assert.equal(instanceVariables(engine, special.processInstanceKey).path, "special");
    const plain = await engine.createInstance({ processDefinitionId: "wait", variables: { special: false } });
    assert.equal(instanceVariables(engine, plain.processInstanceKey).path, "default", "the default caught the rest");
  });
});

// The following four tests exercise a `when(...)` predicate over EACH matchable `EngineJob` field
// (jobType, variables, elementId, processInstanceKey, jobKey). `mock-completeness-guard.test.ts`
// scans these predicates and FAILS if any EngineJob field is not reachable by a tested predicate —
// so adding a new matchable field to EngineJob forces a predicate + test here.

test("conditions: predicate over job.jobType and job.variables selects the right job", async () => {
  await withEngine([{ name: "wait.bpmn", xml: WAIT_BPMN }], async (engine) => {
    engine
      .mockWorker("work")
      .when((job) => job.jobType === "work" && job.variables.pick === true).completeWith({ matched: true });
    const hit = await engine.createInstance({ processDefinitionId: "wait", variables: { pick: true } });
    assert.equal(instanceVariables(engine, hit.processInstanceKey).matched, true, "jobType+variables predicate matched");

    let realRan = false;
    await engine.registerWorker("work", () => {
      realRan = true;
      return { matched: false };
    });
    const miss = await engine.createInstance({ processDefinitionId: "wait", variables: { pick: false } });
    assert.equal(realRan, true, "a job whose variables don't match fell through to the real handler");
    assert.equal(instanceVariables(engine, miss.processInstanceKey).matched, false);
  });
});

test("conditions: predicate over job.elementId selects by the BPMN element", async () => {
  await withEngine([{ name: "wait.bpmn", xml: WAIT_BPMN }], async (engine) => {
    // `work` is the serviceTask element id; matching on it proves elementId is populated & matchable.
    engine.mockWorker("work").when((job) => job.elementId === "work").completeWith({ byElement: true });
    const { processInstanceKey } = await engine.createInstance({ processDefinitionId: "wait" });
    assert.equal(instanceVariables(engine, processInstanceKey).byElement, true, "elementId predicate matched the serviceTask");
  });
});

test("conditions: predicate over job.processInstanceKey and job.jobKey sees real, non-empty keys", async () => {
  await withEngine([{ name: "wait.bpmn", xml: WAIT_BPMN }], async (engine) => {
    const seen: { pik: string | undefined; jk: string }[] = [];
    engine
      .mockWorker("work")
      .when((job) => {
        seen.push({ pik: job.processInstanceKey, jk: job.jobKey });
        return job.processInstanceKey !== undefined && job.jobKey.length > 0;
      })
      .completeWith({ keyed: true });
    const { processInstanceKey } = await engine.createInstance({ processDefinitionId: "wait" });
    assert.equal(instanceVariables(engine, processInstanceKey).keyed, true, "the key predicate matched");
    assert.equal(seen.length >= 1, true, "the predicate was evaluated");
    assert.equal(seen[0]?.jk.length ? true : false, true, "jobKey is a non-empty string on the dispatched job");
    assert.equal(seen[0]?.pik, processInstanceKey, "processInstanceKey on the job is the parent instance key");
  });
});
