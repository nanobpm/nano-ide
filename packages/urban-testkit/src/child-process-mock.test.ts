// e2e coverage for child-process / call-activity mocking (epic #296, S3). Drives the in-process
// WASM adapter directly: deploys a parent BPMN with a call activity, mocks the called process, and
// asserts the outcome through the engine's observable state (process-instance state + snapshot
// incidents/variables). Red/Green per outcome (AGENTS.md).
//
// Engine reality (see the module header of `child-process-mock.ts`): the WASM `TestEngine` treats a
// call activity as an immediate PASS-THROUGH — it never instantiates the called process, does not
// wait, and dispatches no job. So "un-mocked" behaviour here is that native pass-through (the parent
// continues past the call activity with no child variables), and the mock's job is to give the call
// activity real, mockable semantics. The fixtures below deploy a real child process too and register
// a worker for its task; a mocked (or un-mocked) call activity never runs that worker, which is how
// we prove the real called process does not execute.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createWasmEngineClient, type WasmEngineClient } from "./wasm-engine.ts";
import { MockChildProcessBuilder, rewriteCallActivities } from "./child-process-mock.ts";

/** Parent: start → callActivity(child) → exclusive gateway on `childDone` → okTask | noTask.
 *  The gateway proves a `completeWith`'s variables are merged BEFORE the parent continues (a
 *  downstream decision sees them). Parks on a user task so the merged variables stay observable. */
const PARENT_GATE = `<?xml version="1.0" encoding="UTF-8"?>
<definitions xmlns="http://www.omg.org/spec/BPMN/20100524/MODEL"
             xmlns:zeebe="http://camunda.org/schema/zeebe/1.0"
             targetNamespace="http://nanobpm/testkit">
  <process id="parent" isExecutable="true">
    <startEvent id="s"/>
    <sequenceFlow id="f1" sourceRef="s" targetRef="ca"/>
    <callActivity id="ca">
      <extensionElements><zeebe:calledElement processId="child" propagateAllChildVariables="true"/></extensionElements>
    </callActivity>
    <sequenceFlow id="f2" sourceRef="ca" targetRef="gw"/>
    <exclusiveGateway id="gw" default="fDef"/>
    <sequenceFlow id="fYes" sourceRef="gw" targetRef="okTask"><conditionExpression>=childDone = true</conditionExpression></sequenceFlow>
    <sequenceFlow id="fDef" sourceRef="gw" targetRef="noTask"/>
    <userTask id="okTask"><extensionElements><zeebe:userTask/></extensionElements></userTask>
    <userTask id="noTask"><extensionElements><zeebe:userTask/></extensionElements></userTask>
  </process>
</definitions>`;

/** Parent: start → callActivity(child) → userTask review. Used for failWith (the parent must park on
 *  the call activity with an incident, never reaching `review`). */
const PARENT_WAIT = `<?xml version="1.0" encoding="UTF-8"?>
<definitions xmlns="http://www.omg.org/spec/BPMN/20100524/MODEL"
             xmlns:zeebe="http://camunda.org/schema/zeebe/1.0"
             targetNamespace="http://nanobpm/testkit">
  <process id="parent" isExecutable="true">
    <startEvent id="s"/>
    <sequenceFlow id="f1" sourceRef="s" targetRef="ca"/>
    <callActivity id="ca">
      <extensionElements><zeebe:calledElement processId="child"/></extensionElements>
    </callActivity>
    <sequenceFlow id="f2" sourceRef="ca" targetRef="review"/>
    <userTask id="review"><extensionElements><zeebe:userTask/></extensionElements></userTask>
    <sequenceFlow id="f3" sourceRef="review" targetRef="e"/>
    <endEvent id="e"/>
  </process>
</definitions>`;

/** Parent with TWO call activities in sequence (childA then childB), then a user task — used to
 *  prove per-process isolation: mocking childA leaves childB untouched. */
const PARENT_TWO = `<?xml version="1.0" encoding="UTF-8"?>
<definitions xmlns="http://www.omg.org/spec/BPMN/20100524/MODEL"
             xmlns:zeebe="http://camunda.org/schema/zeebe/1.0"
             targetNamespace="http://nanobpm/testkit">
  <process id="parent" isExecutable="true">
    <startEvent id="s"/>
    <sequenceFlow id="f1" sourceRef="s" targetRef="caA"/>
    <callActivity id="caA">
      <extensionElements><zeebe:calledElement processId="childA"/></extensionElements>
    </callActivity>
    <sequenceFlow id="f2" sourceRef="caA" targetRef="caB"/>
    <callActivity id="caB">
      <extensionElements><zeebe:calledElement processId="childB"/></extensionElements>
    </callActivity>
    <sequenceFlow id="f3" sourceRef="caB" targetRef="review"/>
    <userTask id="review"><extensionElements><zeebe:userTask/></extensionElements></userTask>
  </process>
</definitions>`;

/** A real child process with a marker service task. Deployed alongside the parent; a worker for its
 *  `childwork` task lets a test assert the real called process never runs (the counter stays 0). */
const CHILD = `<?xml version="1.0" encoding="UTF-8"?>
<definitions xmlns="http://www.omg.org/spec/BPMN/20100524/MODEL"
             xmlns:zeebe="http://camunda.org/schema/zeebe/1.0"
             targetNamespace="http://nanobpm/testkit">
  <process id="child" isExecutable="true">
    <startEvent id="cs"/>
    <sequenceFlow id="cf1" sourceRef="cs" targetRef="cwork"/>
    <serviceTask id="cwork"><extensionElements><zeebe:taskDefinition type="childwork"/></extensionElements></serviceTask>
    <sequenceFlow id="cf2" sourceRef="cwork" targetRef="ce"/>
    <endEvent id="ce"/>
  </process>
</definitions>`;

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

test("child-process: completeWith merges the child's variables into the parent before it continues", async () => {
  await withEngine([{ name: "parent.bpmn", xml: PARENT_GATE }, { name: "child.bpmn", xml: CHILD }], async (engine) => {
    let childRan = 0;
    await engine.registerWorker("childwork", async () => {
      childRan++;
      return {};
    });
    engine.mockChildProcess("child").completeWith({ childDone: true, from: "mock" });
    const { processInstanceKey } = await engine.createInstance({ processDefinitionId: "parent" });
    const [inst] = await engine.searchProcessInstances({ processInstanceKeys: [processInstanceKey] });
    assert.equal(inst?.state, "ACTIVE", "the parent continued past the call activity");
    // The exclusive gateway routed on the MOCKED variable → the token is on `okTask`, proving the
    // child's variables were available downstream (merged before the parent continued).
    assert.deepEqual(engine.snapshot().activeElementIds, ["okTask"], "gateway saw the mocked childDone:true");
    const vars = instanceVariables(engine, processInstanceKey);
    assert.equal(vars.childDone, true, "mocked child variables merged onto the parent");
    assert.equal(vars.from, "mock");
    assert.equal(childRan, 0, "the real called process never ran — the mock stood in for it");
    assert.equal(incidentReasons(engine).length, 0, "a completion raises no incident");
  });
});

test("child-process: failWith (default retries 0) parks the parent on the call activity with an incident", async () => {
  await withEngine([{ name: "parent.bpmn", xml: PARENT_WAIT }, { name: "child.bpmn", xml: CHILD }], async (engine) => {
    engine.mockChildProcess("child").failWith({ message: "child mock rejected" });
    const { processInstanceKey } = await engine.createInstance({ processDefinitionId: "parent" });
    const [inst] = await engine.searchProcessInstances({ processInstanceKeys: [processInstanceKey] });
    assert.equal(inst?.state, "ACTIVE", "a zero-retry failure must not complete the parent");
    assert.deepEqual(engine.snapshot().activeElementIds, ["ca"], "the parent parked ON the call activity, not past it");
    assert.ok(
      incidentReasons(engine).includes("child mock rejected"),
      "the failure raised an incident carrying the message",
    );
  });
});

test("child-process: an un-mocked call activity keeps the engine's native pass-through (no child variables)", async () => {
  await withEngine([{ name: "parent.bpmn", xml: PARENT_GATE }, { name: "child.bpmn", xml: CHILD }], async (engine) => {
    let childRan = 0;
    await engine.registerWorker("childwork", async () => {
      childRan++;
      return {};
    });
    // No mock registered for `child`.
    const { processInstanceKey } = await engine.createInstance({ processDefinitionId: "parent" });
    const [inst] = await engine.searchProcessInstances({ processInstanceKeys: [processInstanceKey] });
    assert.equal(inst?.state, "ACTIVE");
    // With no mocked variables, the gateway falls to its default branch → `noTask`.
    assert.deepEqual(engine.snapshot().activeElementIds, ["noTask"], "no mocked variables → gateway default branch");
    const vars = instanceVariables(engine, processInstanceKey);
    assert.equal(vars.childDone, undefined, "an un-mocked call activity injects no child variables");
    assert.equal(childRan, 0, "the engine never executes the called process for a call activity");
  });
});

test("child-process: mocking process A does not affect process B (isolation)", async () => {
  await withEngine([{ name: "parent.bpmn", xml: PARENT_TWO }], async (engine) => {
    // Mock only childA; childB is left to its native pass-through.
    engine.mockChildProcess("childA").completeWith({ a: 1, tag: "A" });
    const { processInstanceKey } = await engine.createInstance({ processDefinitionId: "parent" });
    const [inst] = await engine.searchProcessInstances({ processInstanceKeys: [processInstanceKey] });
    assert.equal(inst?.state, "ACTIVE");
    assert.deepEqual(engine.snapshot().activeElementIds, ["review"], "both call activities passed, parent reached review");
    const vars = instanceVariables(engine, processInstanceKey);
    assert.equal(vars.a, 1, "childA's mocked variables merged");
    assert.equal(vars.tag, "A", "childB did NOT overwrite childA's tag — it injected nothing");
  });
});

test("child-process: resetting a mock restores the native pass-through", async () => {
  await withEngine([{ name: "parent.bpmn", xml: PARENT_GATE }], async (engine) => {
    const builder = engine.mockChildProcess("child").completeWith({ childDone: true });
    builder.reset();
    const { processInstanceKey } = await engine.createInstance({ processDefinitionId: "parent" });
    assert.deepEqual(engine.snapshot().activeElementIds, ["noTask"], "after reset the call activity injects nothing");
    const vars = instanceVariables(engine, processInstanceKey);
    assert.equal(vars.childDone, undefined, "the mocked variable is gone after reset");
  });
});

test("child-process: clearChildProcessMock also restores native behaviour", async () => {
  await withEngine([{ name: "parent.bpmn", xml: PARENT_GATE }], async (engine) => {
    engine.mockChildProcess("child").completeWith({ childDone: true });
    engine.clearChildProcessMock("child");
    const { processInstanceKey } = await engine.createInstance({ processDefinitionId: "parent" });
    assert.deepEqual(engine.snapshot().activeElementIds, ["noTask"]);
    assert.equal(instanceVariables(engine, processInstanceKey).childDone, undefined);
  });
});

test("child-process: a reset builder is tombstoned — re-arming it throws", async () => {
  await withEngine([{ name: "parent.bpmn", xml: PARENT_GATE }], async (engine) => {
    const builder = engine.mockChildProcess("child");
    builder.reset();
    assert.throws(() => builder.completeWith({ x: 1 }), /reset\(\)/);
    assert.throws(() => builder.failWith(), /reset\(\)/);
  });
});

test("child-process: mockChildProcess is idempotent per id (returns the same builder)", async () => {
  const engine = await createWasmEngineClient();
  try {
    const a = engine.mockChildProcess("child");
    const b = engine.mockChildProcess("child");
    assert.equal(a, b, "repeated calls for the same process id return the same builder");
  } finally {
    await engine.close();
  }
});

test("child-process: last-write-wins — a later outcome replaces the earlier one", async () => {
  await withEngine([{ name: "parent.bpmn", xml: PARENT_GATE }], async (engine) => {
    engine.mockChildProcess("child").completeWith({ childDone: false }).completeWith({ childDone: true });
    const { processInstanceKey } = await engine.createInstance({ processDefinitionId: "parent" });
    assert.deepEqual(engine.snapshot().activeElementIds, ["okTask"], "the last completeWith won");
    assert.equal(instanceVariables(engine, processInstanceKey).childDone, true);
  });
});

test("child-process: failWith is a drain fixpoint — it raises one incident and does not spin", async () => {
  await withEngine([{ name: "parent.bpmn", xml: PARENT_WAIT }], async (engine) => {
    engine.mockChildProcess("child").failWith({ message: "boom" });
    // If failWith re-activated the synthetic call-activity job every pass, drain would throw
    // "did not quiesce". Reaching here (and a single incident) proves the fixpoint holds.
    const { processInstanceKey } = await engine.createInstance({ processDefinitionId: "parent" });
    await engine.drain();
    await engine.drain();
    assert.equal(incidentReasons(engine).filter((r) => r === "boom").length, 1, "exactly one incident, no spin");
    const [inst] = await engine.searchProcessInstances({ processInstanceKeys: [processInstanceKey] });
    assert.equal(inst?.state, "ACTIVE");
    assert.equal(engine.now, 0, "no wall-clock time consumed");
  });
});

test("child-process: determinism — draining again after the parent quiesced changes nothing", async () => {
  await withEngine([{ name: "parent.bpmn", xml: PARENT_GATE }], async (engine) => {
    engine.mockChildProcess("child").completeWith({ childDone: true });
    const { processInstanceKey } = await engine.createInstance({ processDefinitionId: "parent" });
    const before = engine.snapshot().activeElementIds;
    // A second drain must reach the same fixpoint (no timers/real time/randomness are involved).
    await engine.drain();
    await engine.drain();
    assert.deepEqual(engine.snapshot().activeElementIds, before, "the drain is a fixpoint — no extra work");
    assert.deepEqual(before, ["okTask"]);
    assert.equal(engine.now, 0, "no wall-clock time was consumed");
  });
});

// --- rewriteCallActivities unit tests (the deploy-time transform underpinning the seam) ---

test("rewriteCallActivities: rewrites a call activity to a synthetic child-process service task", () => {
  const { xml, calledProcessIds } = rewriteCallActivities(PARENT_WAIT);
  assert.deepEqual(calledProcessIds, ["child"]);
  assert.ok(!xml.includes("callActivity"), "the callActivity element is gone");
  assert.ok(xml.includes('<serviceTask id="ca">'), "it became a serviceTask preserving the id");
  assert.ok(
    xml.includes('type="__urban-testkit:child-process__:child"'),
    "carrying the synthetic child-process job type",
  );
  assert.ok(!xml.includes("calledElement"), "the calledElement extension is gone");
});

test("rewriteCallActivities: leaves models without a call activity untouched (fast path)", () => {
  const plain = `<definitions><process id="p"><startEvent id="s"/></process></definitions>`;
  const { xml, calledProcessIds } = rewriteCallActivities(plain);
  assert.equal(xml, plain, "no call activity → byte-for-byte identical");
  assert.deepEqual(calledProcessIds, []);
});

test("rewriteCallActivities: handles a namespace prefix and multiple/distinct called ids", () => {
  const prefixed = `<bpmn:definitions xmlns:bpmn="x" xmlns:zeebe="z">
    <bpmn:process id="p">
      <bpmn:callActivity id="c1"><bpmn:extensionElements><zeebe:calledElement processId="alpha"/></bpmn:extensionElements></bpmn:callActivity>
      <bpmn:callActivity id="c2"><bpmn:extensionElements><zeebe:calledElement processId="beta"/></bpmn:extensionElements></bpmn:callActivity>
    </bpmn:process>
  </bpmn:definitions>`;
  const { xml, calledProcessIds } = rewriteCallActivities(prefixed);
  assert.deepEqual(calledProcessIds.sort(), ["alpha", "beta"]);
  assert.ok(xml.includes('<bpmn:serviceTask id="c1">'), "prefix preserved on the rewritten tag");
  assert.ok(xml.includes('<bpmn:serviceTask id="c2">'));
  assert.ok(
    xml.includes("<bpmn:extensionElements><zeebe:taskDefinition"),
    "the injected extensionElements also carries the bpmn: prefix (correct namespace)",
  );
  assert.ok(!xml.includes("<extensionElements>"), "no unprefixed extensionElements leaked in");
  assert.ok(!xml.includes("callActivity"));
});

test("rewriteCallActivities: leaves a call activity with no calledElement processId untouched", () => {
  const noProc = `<definitions><process id="p"><callActivity id="c"><extensionElements/></callActivity></process></definitions>`;
  const { xml, calledProcessIds } = rewriteCallActivities(noProc);
  assert.deepEqual(calledProcessIds, [], "nothing to key a mock on");
  assert.ok(xml.includes("callActivity"), "the untouched call activity remains (native pass-through)");
});

test("rewriteCallActivities: handles namespace prefixes containing '.' and '-' (valid NCName chars)", () => {
  // XML NCName prefixes allow '.' and '-', which `\w` excludes — the rewrite must still fire.
  const prefixed = `<b-p.n:definitions xmlns:b-p.n="x" xmlns:zeebe="z">
    <b-p.n:process id="p">
      <b-p.n:callActivity id="c1"><b-p.n:extensionElements><zeebe:calledElement processId="alpha"/></b-p.n:extensionElements></b-p.n:callActivity>
    </b-p.n:process>
  </b-p.n:definitions>`;
  const { xml, calledProcessIds } = rewriteCallActivities(prefixed);
  assert.deepEqual(calledProcessIds, ["alpha"], "the '.'/'-' prefixed calledElement is still detected");
  assert.ok(xml.includes('<b-p.n:serviceTask id="c1">'), "the '.'/'-' prefix is preserved on the rewritten tag");
  assert.ok(
    xml.includes("<b-p.n:extensionElements><zeebe:taskDefinition"),
    "the injected extensionElements carries the '.'/'-' prefix",
  );
  assert.ok(!xml.includes("calledElement"), "the original extensionElements block was stripped");
  assert.ok(!xml.includes("callActivity"));
});

test("MockChildProcessBuilder: resolve() returns undefined until an outcome is set, then the outcome", () => {
  const builder = new MockChildProcessBuilder(() => {});
  assert.equal(builder.hasOutcome, false);
  assert.equal(builder.resolve(), undefined);
  builder.completeWith({ ok: true });
  assert.equal(builder.hasOutcome, true);
  assert.deepEqual(builder.resolve(), { kind: "complete", variables: { ok: true } });
  builder.failWith({ message: "nope" });
  assert.deepEqual(builder.resolve(), { kind: "fail", retries: 0, message: "nope" });
});
