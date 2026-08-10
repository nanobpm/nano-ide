import { test } from "node:test";
import assert from "node:assert/strict";
import { runEngineClientContract } from "./contract.ts";
import {
  createWasmEngineClient,
  wasmStateToProcessInstanceState,
} from "./wasm-engine.ts";
import { BpmnError } from "../runtime/core/host.ts";

// The shared contract, executed against the in-process WASM adapter.
runEngineClientContract("wasm", () => createWasmEngineClient());

// Adapter-specific behaviour beyond the shared contract.

test("wasm: Terminating projects as TERMINATED (REST parity)", () => {
  assert.equal(wasmStateToProcessInstanceState("Terminating"), "TERMINATED");
  assert.equal(wasmStateToProcessInstanceState("TERMINATED"), "TERMINATED");
  assert.equal(wasmStateToProcessInstanceState("Active"), "ACTIVE");
  assert.equal(wasmStateToProcessInstanceState("Completed"), "COMPLETED");
  assert.equal(wasmStateToProcessInstanceState("bogus"), undefined);
  assert.equal(wasmStateToProcessInstanceState(42), undefined);
});

test("wasm: a BpmnError from a worker is routed as a BPMN error, not a failure", async () => {
  const engine = await createWasmEngineClient();
  try {
    // An error-boundary catch on the service task diverts to an alternate end.
    const model = `<?xml version="1.0" encoding="UTF-8"?>
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
    await engine.registerWorker("work", () => {
      throw new BpmnError("BOOM", "modelled");
    });
    await engine.deployResources([
      { name: "boundary.bpmn", content: model, contentType: "application/bpmn+xml" },
    ]);
    const { processInstanceKey } = await engine.createInstance({
      processDefinitionId: "boundary",
      awaitCompletion: true,
    });
    // The BPMN error was caught by the boundary event → the instance completed
    // (a plain failure would have parked it ACTIVE on an incident instead).
    const [inst] = await engine.searchProcessInstances({
      processInstanceKeys: [processInstanceKey],
    });
    assert.equal(inst?.state, "COMPLETED");
  } finally {
    await engine.close();
  }
});

test("wasm: advanceTime fires a timer and drains resulting work", async () => {
  const engine = await createWasmEngineClient();
  try {
    const model = `<?xml version="1.0" encoding="UTF-8"?>
<definitions xmlns="http://www.omg.org/spec/BPMN/20100524/MODEL"
             xmlns:zeebe="http://camunda.org/schema/zeebe/1.0"
             targetNamespace="http://nanobpm/testkit">
  <process id="timed" isExecutable="true">
    <startEvent id="s"/>
    <sequenceFlow id="f1" sourceRef="s" targetRef="wait"/>
    <intermediateCatchEvent id="wait">
      <timerEventDefinition><timeDuration>PT30S</timeDuration></timerEventDefinition>
    </intermediateCatchEvent>
    <sequenceFlow id="f2" sourceRef="wait" targetRef="e"/>
    <endEvent id="e"/>
  </process>
</definitions>`;
    await engine.deployResources([
      { name: "timed.bpmn", content: model, contentType: "application/bpmn+xml" },
    ]);
    const { processInstanceKey } = await engine.createInstance({ processDefinitionId: "timed" });
    const before = await engine.searchProcessInstances({
      processInstanceKeys: [processInstanceKey],
    });
    assert.equal(before[0]?.state, "ACTIVE", "instance should wait on the timer");

    await engine.advanceTime(31_000);

    const after = await engine.searchProcessInstances({
      processInstanceKeys: [processInstanceKey],
    });
    assert.equal(after[0]?.state, "COMPLETED", "advancing past the timer completes the instance");
  } finally {
    await engine.close();
  }
});

test("wasm: unsubscribe stops a worker from serving further jobs", async () => {
  const engine = await createWasmEngineClient();
  try {
    let calls = 0;
    const sub = await engine.registerWorker("work", () => {
      calls++;
      return {};
    });
    await engine.deployResources([
      {
        name: "svc.bpmn",
        content: `<?xml version="1.0" encoding="UTF-8"?>
<definitions xmlns="http://www.omg.org/spec/BPMN/20100524/MODEL"
             xmlns:zeebe="http://camunda.org/schema/zeebe/1.0"
             targetNamespace="http://nanobpm/testkit">
  <process id="svc" isExecutable="true">
    <startEvent id="s"/><sequenceFlow id="f1" sourceRef="s" targetRef="work"/>
    <serviceTask id="work"><extensionElements><zeebe:taskDefinition type="work"/></extensionElements></serviceTask>
    <sequenceFlow id="f2" sourceRef="work" targetRef="e"/><endEvent id="e"/>
  </process>
</definitions>`,
        contentType: "application/bpmn+xml",
      },
    ]);
    await engine.createInstance({ processDefinitionId: "svc", awaitCompletion: true });
    assert.equal(calls, 1);

    await sub.unsubscribe();
    const { processInstanceKey } = await engine.createInstance({ processDefinitionId: "svc" });
    // No worker now → the second instance parks unserved.
    assert.equal(calls, 1);
    const [inst] = await engine.searchProcessInstances({
      processInstanceKeys: [processInstanceKey],
    });
    assert.equal(inst?.state, "ACTIVE");
  } finally {
    await engine.close();
  }
});
