// Conformance guard (issue #341): the WASM test double must implement the *entire*
// `EngineClient` surface, not merely the methods some behavioural test happens to
// exercise. urban grew `getForm`, then `openUserTasks`, on `EngineClient` after this kit
// was first published; a `WasmEngineClient` compiled/published against the older urban
// silently lacked them, so any consumer whose reconciler/poller reached for the new
// accessor hit `TypeError: engine.<method> is not a function` under the fake and had to
// hand-polyfill it in its harness (nanobpm/nano-workforce#309 / #312). A purely
// structural `implements EngineClient` check cannot catch that: it only binds the fake to
// whatever urban version *it* compiled against.
//
// `ENGINE_CLIENT_METHODS` is urban's single runtime source of truth for the interface's
// surface, compile-time-pinned to `keyof EngineClient`. Iterating it here turns the next
// such seam-lag into a red test in *this* repo's CI — the categorical fix for the whole
// "fake lags the SDK" class, not just the one method that bit us this time.

import { test } from "node:test";
import assert from "node:assert/strict";
import { ENGINE_CLIENT_METHODS, type EngineJob } from "@nanobpm/urban/runtime";
import { createWasmEngineClient } from "./wasm-engine.ts";

test("WasmEngineClient implements the full EngineClient method surface", async () => {
  const engine = await createWasmEngineClient();
  try {
    const missing = ENGINE_CLIENT_METHODS.filter((method) => typeof engine[method] !== "function");
    assert.deepEqual(
      missing,
      [],
      `WasmEngineClient is missing EngineClient method(s) [${missing.join(", ")}] — the SDK grew ` +
        "a method the test double lags behind (issue #341). Implement it on WasmEngineClient, " +
        "deriving from an existing method where possible so the two cannot drift.",
    );
  } finally {
    // Guard cleanup: `close` may itself be one of the missing methods this test
    // exists to detect. Calling it unconditionally would throw
    // `TypeError: engine.close is not a function` and mask the actionable
    // assertion above that lists exactly which methods are missing.
    if (typeof engine.close === "function") {
      await engine.close();
    }
  }
});

// Behavioural parity for the seam methods Slice 2 added (nanobpm/nano-ide#488): incident
// reads (`searchIncidents`), the two mutating repair operations (`updateJobRetries` /
// `resolveIncident`) and `setVariables`. The surface guard above already fails if an adapter
// lags a method; these cases additionally pin the *behaviour contract* both adapters must
// satisfy — driven purely through the public `EngineClient` seam (so the same scenario would
// pass against the live `SdkEngineClient` too), exercised here against the in-process WASM
// double. The scenario is one end-to-end incident-repair loop, the exact flow Slice 3's
// mutation debugging tools drive: a worker fails → an incident is raised → an operator reads
// the incident, injects the missing variable, bumps the job's retries, and resolves the
// incident → the re-activated job now succeeds and the instance completes.

/** A single service task (`work`) between a start and end event, with the DI a human-facing
 *  model requires. The `work` job parks until a registered worker serves it. */
const SERVICE_TASK_BPMN = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"
  xmlns:bpmndi="http://www.omg.org/spec/BPMN/20100524/DI"
  xmlns:dc="http://www.omg.org/spec/DD/20100524/DC"
  xmlns:zeebe="http://camunda.org/schema/zeebe/1.0"
  id="defs_incident" targetNamespace="http://nanobpm.io/conformance">
  <bpmn:process id="incident_repair" isExecutable="true">
    <bpmn:startEvent id="start"><bpmn:outgoing>f1</bpmn:outgoing></bpmn:startEvent>
    <bpmn:sequenceFlow id="f1" sourceRef="start" targetRef="work"/>
    <bpmn:serviceTask id="work">
      <bpmn:extensionElements><zeebe:taskDefinition type="work"/></bpmn:extensionElements>
      <bpmn:incoming>f1</bpmn:incoming><bpmn:outgoing>f2</bpmn:outgoing>
    </bpmn:serviceTask>
    <bpmn:sequenceFlow id="f2" sourceRef="work" targetRef="end"/>
    <bpmn:endEvent id="end"><bpmn:incoming>f2</bpmn:incoming></bpmn:endEvent>
  </bpmn:process>
  <bpmndi:BPMNDiagram id="diagram">
    <bpmndi:BPMNPlane id="plane" bpmnElement="incident_repair">
      <bpmndi:BPMNShape id="start_di" bpmnElement="start"><dc:Bounds x="0" y="0" width="36" height="36"/></bpmndi:BPMNShape>
      <bpmndi:BPMNShape id="work_di" bpmnElement="work"><dc:Bounds x="100" y="-22" width="100" height="80"/></bpmndi:BPMNShape>
      <bpmndi:BPMNShape id="end_di" bpmnElement="end"><dc:Bounds x="300" y="0" width="36" height="36"/></bpmndi:BPMNShape>
    </bpmndi:BPMNPlane>
  </bpmndi:BPMNDiagram>
</bpmn:definitions>`;

test("EngineClient seam: searchIncidents / setVariables / updateJobRetries / resolveIncident drive an incident-repair loop", async () => {
  const engine = await createWasmEngineClient();
  try {
    await engine.deployResources([
      { name: "incident_repair.bpmn", content: SERVICE_TASK_BPMN, contentType: "text/xml" },
    ]);

    // The `work` worker: it captures the job key on first sight, then fails (a plain, non-BPMN
    // throw) until the instance carries `fixed: true`. So the first run fails with the variable
    // absent — driving the job out of retries and raising an incident — and a later run, after
    // `setVariables` has injected `fixed: true`, completes. Capturing the job key from the
    // `EngineJob` mirrors how a real consumer (or Slice 3's tool) learns the key to retry.
    let capturedJobKey: string | undefined;
    await engine.registerWorker("work", (job: EngineJob) => {
      capturedJobKey = job.jobKey;
      if (job.variables?.fixed === true) return {};
      throw new Error("work not yet fixed");
    });

    const { processInstanceKey } = await engine.createInstance({
      processDefinitionId: "incident_repair",
    });

    // The failed job (out of retries) has raised exactly one incident on this instance.
    const raised = await engine.searchIncidents();
    assert.equal(raised.length, 1, "one incident should be raised for the failed job");
    const incident = raised[0];
    assert.equal(incident.processInstanceKey, processInstanceKey);
    assert.ok(incident.incidentKey.length > 0, "incident carries a resolvable incidentKey");
    assert.equal(incident.state, "ACTIVE", "an open incident reports ACTIVE");
    assert.equal(incident.elementId, "work");
    assert.ok(
      typeof incident.errorMessage === "string" && incident.errorMessage.length > 0,
      "incident carries the failure's error message",
    );
    assert.ok(capturedJobKey !== undefined, "the worker saw the job key before failing");

    // Filtering: by the owning instance it is returned; by a foreign instance or a
    // non-matching state it is not — the same selector contract both adapters honour.
    assert.equal((await engine.searchIncidents({ processInstanceKey })).length, 1);
    assert.equal(
      (await engine.searchIncidents({ processInstanceKey: "does-not-exist" })).length,
      0,
    );
    assert.equal((await engine.searchIncidents({ state: "RESOLVED" })).length, 0);

    // Repair: inject the variable the worker needs, restore the job's retries, then resolve the
    // incident. Resolving returns the job to the activatable pool; the adapter drains it, the
    // worker re-runs — now seeing `fixed: true` — and completes, so the instance finishes.
    await engine.setVariables({ scopeKey: processInstanceKey, variables: { fixed: true } });
    await engine.updateJobRetries({ jobKey: capturedJobKey, retries: 3 });
    await engine.resolveIncident({ incidentKey: incident.incidentKey });

    // The incident is cleared and the instance ran to completion — proving `setVariables`
    // actually mutated the scope (otherwise the re-run would have failed again).
    assert.deepEqual(await engine.searchIncidents(), []);
    const instances = await engine.searchProcessInstances({
      processInstanceKeys: [processInstanceKey],
    });
    assert.equal(instances.length, 1);
    assert.equal(instances[0].state, "COMPLETED");
  } finally {
    await engine.close();
  }
});
