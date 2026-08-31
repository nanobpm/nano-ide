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

// Behavioural parity for the three engine-truth READ methods added by nanobpm/nano-ide#526/#527/#528
// (`searchVariables`, `searchJobs`, `getProcessDefinitionXml`). The surface guard above already
// fails if an adapter lags one; these cases pin the *behaviour contract* both adapters must satisfy,
// driven purely through the public `EngineClient` seam. The scenario is the "is it actually stuck?"
// read path: an instance is created but its `work` worker is NEVER registered, so the job parks
// CREATED-and-queued (no `worker` leased). An operator then reads the parked token's variables, sees
// the queued job (whose `jobKey` feeds `updateJobRetries`), and fetches the deployed BPMN by the key
// the instance carries — each a read, no mutation.
test("EngineClient seam: searchVariables / searchJobs / getProcessDefinitionXml read a parked instance", async () => {
  const engine = await createWasmEngineClient();
  try {
    await engine.deployResources([
      { name: "incident_repair.bpmn", content: SERVICE_TASK_BPMN, contentType: "text/xml" },
    ]);

    // Deliberately DO NOT register the `work` worker: the job parks CREATED (queued, unleased).
    const { processInstanceKey } = await engine.createInstance({
      processDefinitionId: "incident_repair",
      variables: { alpha: "one", beta: 2 },
    });

    // searchVariables — the seeded process variables are readable, each with its serialized-JSON
    // `value`, and scoped to the process instance.
    const vars = await engine.searchVariables({ processInstanceKey });
    const alpha = vars.find((v) => v.name === "alpha");
    const beta = vars.find((v) => v.name === "beta");
    assert.ok(alpha !== undefined, "alpha variable is returned");
    assert.equal(alpha.value, '"one"', "a string value arrives JSON-encoded");
    assert.equal(alpha.scopeKey, processInstanceKey);
    assert.equal(alpha.processInstanceKey, processInstanceKey);
    assert.ok(alpha.variableKey.length > 0, "each variable carries its own variableKey");
    assert.equal(alpha.isTruncated, false);
    assert.ok(beta !== undefined, "beta variable is returned");
    assert.equal(beta.value, "2", "a numeric value arrives JSON-encoded");
    // Filtering: by name it narrows to that one variable; a foreign instance returns none.
    const byName = await engine.searchVariables({ processInstanceKey, name: "alpha" });
    assert.deepEqual(
      byName.map((v) => v.name),
      ["alpha"],
      "name filter returns exactly the matching variable",
    );
    assert.deepEqual(await engine.searchVariables({ processInstanceKey: "does-not-exist" }), []);

    // searchJobs — the parked `work` job is CREATED-and-queued: a `worker` is NOT set (nothing has
    // leased it), which is the leased-vs-queued signal. Its `jobKey` is the handle `updateJobRetries`
    // takes with no incident detour.
    const jobs = await engine.searchJobs({ processInstanceKey });
    assert.equal(jobs.length, 1, "the parked service-task job is returned");
    const job = jobs[0];
    assert.equal(job.type, "work");
    assert.equal(job.state, "CREATED", "a parked job reports the REST/v2 CREATED spelling");
    assert.equal(job.elementId, "work");
    assert.equal(job.processInstanceKey, processInstanceKey);
    assert.ok(job.jobKey.length > 0, "the job carries the jobKey retry_job consumes");
    assert.equal(job.worker, undefined, "a queued (unleased) job has NO worker set");
    // Filtering: a matching state returns it; a non-matching state or a "leased by X" worker filter
    // excludes the queued job — the same selector contract both adapters honour.
    assert.equal((await engine.searchJobs({ processInstanceKey, state: "CREATED" })).length, 1);
    assert.equal((await engine.searchJobs({ processInstanceKey, state: "COMPLETED" })).length, 0);
    assert.equal((await engine.searchJobs({ processInstanceKey, type: "work" })).length, 1);
    assert.equal((await engine.searchJobs({ processInstanceKey, type: "other" })).length, 0);
    assert.equal(
      (await engine.searchJobs({ processInstanceKey, worker: "some-agent" })).length,
      0,
      "an unleased job cannot match a leased-by-worker filter",
    );
    // End-to-end: the jobKey searchJobs surfaced is the exact handle updateJobRetries accepts —
    // no engine-API detour and no incident required (this job is not behind one).
    await engine.updateJobRetries({ jobKey: job.jobKey, retries: 5 });

    // getProcessDefinitionXml — the instance carries its processDefinitionKey (via
    // searchProcessInstances), which fetches the deployed BPMN XML; an unknown/blank key is absent.
    const [instance] = await engine.searchProcessInstances({
      processInstanceKeys: [processInstanceKey],
    });
    assert.ok(instance !== undefined, "the instance is found");
    assert.ok(
      instance.processDefinitionKey !== undefined && instance.processDefinitionKey.length > 0,
      "the instance carries its processDefinitionKey (instance → key → deployed XML)",
    );
    const xml = await engine.getProcessDefinitionXml(instance.processDefinitionKey);
    assert.ok(typeof xml === "string" && xml.includes("incident_repair"), "deployed BPMN is returned");
    assert.equal(
      await engine.getProcessDefinitionXml("does-not-exist"),
      null,
      "an unknown processDefinitionKey is typed-absent (null)",
    );
    assert.equal(
      await engine.getProcessDefinitionXml("   "),
      null,
      "a blank processDefinitionKey is typed-absent (null)",
    );
  } finally {
    await engine.close();
  }
});

// Behavioural parity for the parent/root process-instance linkage the typed seam now carries
// (nanobpm/nano-ide#532). The engine (`@nanobpm/engine-wasm` ≥ 0.8.6) exposes a native-child's
// parent/root keys on both `searchProcessInstances` and `searchUserTasks`, but before this slice the
// typed `EngineClient` seam dropped them — so the reduced-capability read path (`pollUserTasks` and
// other reconcile/affordance surfaces) had NO in-repo way to correlate a deep native descendant
// (e.g. a human-escalation grandchild) back to its parent/root subject without a raw-REST channel.
//
// This drives a REAL three-level native call-activity hierarchy through the public seam
// (grand-parent → child → grandchild-with-a-user-task) and proves the correlation end-to-end
// through the typed accessors alone: the grandchild's open user task carries its owning
// `processInstanceKey` and the hierarchy `rootProcessInstanceKey`; `searchProcessInstances`'
// parent/root selectors select the descendants; and the grandchild snapshot carries the immediate
// `parentProcessInstanceKey` — so a caller maps user-task → owning instance → parent subject with no
// raw-REST fallback and no weakened expectations. The scenario is engine-driven, so it would pass
// against the live `SdkEngineClient` too. (Before the seam fix these keys were `undefined`, so every
// linkage assertion below was red — the dropped-linkage gap this slice closes.)

/** A native call-activity link to `processId`, flowing on to `next`. */
function callActivity(id: string, processId: string, next: string): string {
  return `<bpmn:callActivity id="${id}">` +
    `<bpmn:extensionElements><zeebe:calledElement processId="${processId}"/></bpmn:extensionElements>` +
    `<bpmn:incoming>in_${id}</bpmn:incoming><bpmn:outgoing>out_${id}</bpmn:outgoing>` +
    `</bpmn:callActivity><bpmn:sequenceFlow id="out_${id}" sourceRef="${id}" targetRef="${next}"/>`;
}

// Grand-parent: start → callActivity(child) → end.
const GRANDPARENT_BPMN = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"
  xmlns:zeebe="http://camunda.org/schema/zeebe/1.0" id="defs_gp" targetNamespace="http://nanobpm.io/conformance">
  <bpmn:process id="gp_lineage" isExecutable="true">
    <bpmn:startEvent id="gs"><bpmn:outgoing>in_gca</bpmn:outgoing></bpmn:startEvent>
    <bpmn:sequenceFlow id="in_gca" sourceRef="gs" targetRef="gca"/>
    ${callActivity("gca", "child_lineage", "ge")}
    <bpmn:endEvent id="ge"><bpmn:incoming>out_gca</bpmn:incoming></bpmn:endEvent>
  </bpmn:process>
</bpmn:definitions>`;

// Child: start → callActivity(grandchild) → end.
const CHILD_BPMN = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"
  xmlns:zeebe="http://camunda.org/schema/zeebe/1.0" id="defs_child" targetNamespace="http://nanobpm.io/conformance">
  <bpmn:process id="child_lineage" isExecutable="true">
    <bpmn:startEvent id="cs"><bpmn:outgoing>in_cca</bpmn:outgoing></bpmn:startEvent>
    <bpmn:sequenceFlow id="in_cca" sourceRef="cs" targetRef="cca"/>
    ${callActivity("cca", "grandchild_lineage", "ce")}
    <bpmn:endEvent id="ce"><bpmn:incoming>out_cca</bpmn:incoming></bpmn:endEvent>
  </bpmn:process>
</bpmn:definitions>`;

// Grandchild: start → userTask(escalation) → end. The user task parks (no worker needed), standing
// in for a human-escalation task owned by a deep native descendant.
const GRANDCHILD_BPMN = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"
  xmlns:zeebe="http://camunda.org/schema/zeebe/1.0" id="defs_gc" targetNamespace="http://nanobpm.io/conformance">
  <bpmn:process id="grandchild_lineage" isExecutable="true">
    <bpmn:startEvent id="gcs"><bpmn:outgoing>in_esc</bpmn:outgoing></bpmn:startEvent>
    <bpmn:sequenceFlow id="in_esc" sourceRef="gcs" targetRef="escalation"/>
    <bpmn:userTask id="escalation">
      <bpmn:extensionElements><zeebe:userTask/></bpmn:extensionElements>
      <bpmn:incoming>in_esc</bpmn:incoming><bpmn:outgoing>out_esc</bpmn:outgoing>
    </bpmn:userTask>
    <bpmn:sequenceFlow id="out_esc" sourceRef="escalation" targetRef="gce"/>
    <bpmn:endEvent id="gce"><bpmn:incoming>out_esc</bpmn:incoming></bpmn:endEvent>
  </bpmn:process>
</bpmn:definitions>`;

test("EngineClient seam: parent/root linkage correlates a native-child user task to its parent/root subject", async () => {
  const engine = await createWasmEngineClient();
  try {
    await engine.deployResources([
      { name: "gp_lineage.bpmn", content: GRANDPARENT_BPMN, contentType: "text/xml" },
      { name: "child_lineage.bpmn", content: CHILD_BPMN, contentType: "text/xml" },
      { name: "grandchild_lineage.bpmn", content: GRANDCHILD_BPMN, contentType: "text/xml" },
    ]);

    // Start the top-level (root) instance. The native call activities instantiate the child and
    // grandchild as real child instances; the grandchild parks on its user task.
    const { processInstanceKey: rootKey } = await engine.createInstance({
      processDefinitionId: "gp_lineage",
    });

    // The reduced path reaches for OPEN user tasks. There is exactly one — the grandchild's
    // escalation task — and through the typed seam it now carries its owning `processInstanceKey`
    // and the hierarchy `rootProcessInstanceKey`, so it correlates straight back to the root subject
    // with NO raw-REST fallback.
    const openTasks = await engine.openUserTasks();
    assert.equal(openTasks.length, 1, "exactly the grandchild escalation task is open");
    const task = openTasks[0];
    assert.equal(task.elementId, "escalation");
    assert.ok(
      task.processInstanceKey !== undefined && task.processInstanceKey.length > 0,
      "the user task carries its owning (grandchild) process-instance key",
    );
    assert.equal(
      task.rootProcessInstanceKey,
      rootKey,
      "the user task's rootProcessInstanceKey correlates to the root subject through the seam",
    );
    const grandchildKey = task.processInstanceKey;
    assert.notEqual(grandchildKey, rootKey, "the grandchild is a distinct instance from the root");

    // Root-scoped selector: every instance in the hierarchy (root + child + grandchild) is
    // selectable by the root key through the typed filter.
    const underRoot = await engine.searchProcessInstances({ rootProcessInstanceKey: rootKey });
    const underRootKeys = new Set(underRoot.map((i) => i.processInstanceKey));
    assert.equal(underRoot.length, 3, "root selector returns the whole native hierarchy");
    assert.ok(underRootKeys.has(rootKey) && underRootKeys.has(grandchildKey));
    for (const inst of underRoot) {
      assert.equal(inst.rootProcessInstanceKey, rootKey, "each instance reports the shared root");
    }

    // user-task → owning instance → immediate parent: resolve the grandchild's snapshot through the
    // seam and read its parentProcessInstanceKey — the immediate (child) subject that spawned it.
    const [grandchild] = await engine.searchProcessInstances({
      processInstanceKeys: [grandchildKey],
    });
    assert.ok(grandchild !== undefined, "the grandchild instance is resolvable by its own key");
    assert.equal(grandchild.rootProcessInstanceKey, rootKey);
    const childKey = grandchild.parentProcessInstanceKey;
    assert.ok(
      childKey !== undefined && childKey !== rootKey && childKey !== grandchildKey,
      "the grandchild carries a distinct immediate parentProcessInstanceKey (the child instance)",
    );

    // Parent-scoped selector: the grandchild is exactly the set of the child's native children.
    const childrenOfChild = await engine.searchProcessInstances({
      parentProcessInstanceKey: childKey,
    });
    assert.deepEqual(
      childrenOfChild.map((i) => i.processInstanceKey),
      [grandchildKey],
      "the parent selector returns exactly the child's native descendant (the grandchild)",
    );

    // The root instance is the top of the hierarchy: no parent, root === itself.
    const [root] = await engine.searchProcessInstances({ processInstanceKeys: [rootKey] });
    assert.equal(root.parentProcessInstanceKey, undefined, "the root instance has no parent");
    assert.equal(root.rootProcessInstanceKey, rootKey, "the root instance's root is itself");

    // Defect-class guard (No Drift Surfaces): a blank/whitespace-only parent/root selector must be
    // normalized away (treated as *absent* → matches everything) rather than compared literally
    // against normalized row keys — which would treat the padded selector as a present key that
    // matches nothing and silently filter out every row. This mirrors `SdkEngineClient`, which
    // drops such a selector via `presentEngineKey` before sending it server-side.
    const blankParentInstances = await engine.searchProcessInstances({
      parentProcessInstanceKey: "   ",
    });
    assert.equal(
      blankParentInstances.length,
      underRoot.length,
      "a whitespace-only parentProcessInstanceKey selector is dropped, not matched-against literally",
    );
    const blankRootInstances = await engine.searchProcessInstances({ rootProcessInstanceKey: "  " });
    assert.equal(
      blankRootInstances.length,
      underRoot.length,
      "a whitespace-only rootProcessInstanceKey selector is dropped, not matched-against literally",
    );
    const allTasks = await engine.searchUserTasks({});
    const blankRootTasks = await engine.searchUserTasks({ rootProcessInstanceKey: "   " });
    assert.equal(
      blankRootTasks.length,
      allTasks.length,
      "a whitespace-only user-task root selector is dropped, not matched-against literally",
    );
    const blankParentTasks = await engine.searchUserTasks({ parentProcessInstanceKey: " " });
    assert.equal(
      blankParentTasks.length,
      allTasks.length,
      "a whitespace-only user-task parent selector is dropped, not matched-against literally",
    );
    const blankPiKeyTasks = await engine.searchUserTasks({ processInstanceKey: "  " });
    assert.equal(
      blankPiKeyTasks.length,
      allTasks.length,
      "a whitespace-only user-task processInstanceKey selector is dropped, not matched-against literally",
    );
  } finally {
    await engine.close();
  }
});
