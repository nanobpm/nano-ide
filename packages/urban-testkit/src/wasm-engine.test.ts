import { test } from "node:test";
import assert from "node:assert/strict";
import { runEngineClientContract } from "./contract.ts";
import {
  createWasmEngineClient,
  parseForm,
  presentKey,
  presentString,
  searchRows,
  wasmStateToProcessInstanceState,
} from "./wasm-engine.ts";
import { BpmnError, readLineage } from "@nanobpm/urban/runtime";

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

// Guards the untyped read-model JSON boundary defect class. `searchUserTasks` /
// `searchProcessInstances` annotate their `JSON.parse`d body with a derived DTO, but that is a
// shape *claim*, not a runtime guarantee — a malformed/changed engine response (a non-object body,
// a non-array `items`, or `null`/non-object rows) must not throw downstream. Both methods extract
// through `searchRows`, so testing it once secures the whole surface. Runtime-invalid fixtures are
// built via `JSON.parse` (which returns `any`), never an `as` cast.
test("searchRows: drops a non-object body, non-array items, and non-object rows (untyped JSON defence)", () => {
  // A non-object body — engine returned `null`, a primitive, or an array — yields no rows.
  assert.deepEqual(searchRows(JSON.parse("null")), []);
  assert.deepEqual(searchRows(JSON.parse("42")), []);
  assert.deepEqual(searchRows(JSON.parse('"nope"')), []);
  assert.deepEqual(searchRows(JSON.parse("[]")), []);
  // An object body whose `items` is missing or not an array yields no rows.
  assert.deepEqual(searchRows(JSON.parse("{}")), []);
  assert.deepEqual(searchRows(JSON.parse('{"items":null}')), []);
  assert.deepEqual(searchRows(JSON.parse('{"items":"x"}')), []);
  assert.deepEqual(searchRows(JSON.parse('{"items":{}}')), []);
  // Non-object rows (`null`, primitives, arrays) are filtered out; object rows survive.
  assert.deepEqual(
    searchRows(JSON.parse('{"items":[null,1,"s",[],{"userTaskKey":"7"}]}')),
    [{ userTaskKey: "7" }],
  );
});

// Guards the same untyped read-model JSON boundary defect class for the `getForm` read path.
// `getFormByKey` returns a JSON string annotated with the `FormResult` DTO — a shape *claim*, not a
// runtime guarantee — so `getForm` extracts through `parseForm`, which must treat a non-object body
// (`null`, a primitive, or crucially an *array*, which `typeof === "object"` would have let through)
// and a missing/invalid schema as "no such form" (`null`) rather than throwing. Runtime-invalid
// fixtures are built via `JSON.parse` (which returns `any`), never an `as` cast.
test("parseForm: rejects a non-object body (incl. arrays) and an invalid schema (untyped JSON defence)", () => {
  // A non-object body — `null`, a primitive, or an array — is "no such form".
  assert.equal(parseForm(JSON.parse("null")), null);
  assert.equal(parseForm(JSON.parse("42")), null);
  assert.equal(parseForm(JSON.parse('"nope"')), null);
  assert.equal(parseForm(JSON.parse("[]")), null);
  // An object body with a missing or non-parseable schema is absent.
  assert.equal(parseForm(JSON.parse("{}")), null);
  assert.equal(parseForm(JSON.parse('{"schema":42}')), null);
  assert.equal(parseForm(JSON.parse('{"schema":"not json"}')), null);
  // A valid object schema (or a JSON-string schema) yields the typed form; non-string identifiers
  // and a non-number version are dropped rather than coerced.
  assert.deepEqual(
    parseForm(JSON.parse('{"schema":{"type":"default"},"formKey":7,"formId":{},"version":"x"}')),
    { formKey: "7", schema: { type: "default" } },
  );
  assert.deepEqual(
    parseForm(JSON.parse('{"schema":"{\\"type\\":\\"default\\"}","formId":"f1","version":3}')),
    { formId: "f1", version: 3, schema: { type: "default" } },
  );
});

// Guards the form-identifier coercion defect class (matches urban's shared form contract): a
// read-model row's `formKey`/`externalFormReference`/`formId` must be presence-checked by *type*,
// so a non-string value (e.g. a nested object) is treated as absent rather than coerced by
// `String(...)` into a truthy `"[object Object]"` identifier that would leak onto the result.
test("wasm: presentKey accepts only string/number, never coercing other types", () => {
  assert.equal(presentKey("k1"), "k1");
  assert.equal(presentKey("  k2  "), "k2", "trims like the shared presence rule");
  assert.equal(presentKey(2251799813685250), "2251799813685250", "numeric key stringified");
  assert.equal(presentKey("   "), undefined, "whitespace-only is absent");
  assert.equal(presentKey(""), undefined);
  assert.equal(presentKey(undefined), undefined);
  assert.equal(presentKey(null), undefined);
  assert.equal(presentKey({}), undefined, "an object never coerces to \"[object Object]\"");
  assert.equal(presentKey({ nested: 1 }), undefined);
  assert.equal(presentKey([1, 2]), undefined, "an array never coerces to a truthy id");
  assert.equal(presentKey(true), undefined);
});

test("wasm: presentString accepts only strings, never coercing other types", () => {
  assert.equal(presentString("ref-1"), "ref-1");
  assert.equal(presentString("  ref-2  "), "ref-2", "trims like the shared presence rule");
  assert.equal(presentString("   "), undefined, "whitespace-only is absent");
  assert.equal(presentString(""), undefined);
  assert.equal(presentString(undefined), undefined);
  assert.equal(presentString(null), undefined);
  assert.equal(presentString(42), undefined, "a number is absent (string-only identifier)");
  assert.equal(presentString({}), undefined, "an object never coerces to \"[object Object]\"");
  assert.equal(presentString([1]), undefined);
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

test("wasm: deployResources accepts forms (not executed) and reports every resource as deployed", async () => {
  const engine = await createWasmEngineClient();
  try {
    const model = `<?xml version="1.0" encoding="UTF-8"?>
<definitions xmlns="http://www.omg.org/spec/BPMN/20100524/MODEL"
             targetNamespace="http://nanobpm/testkit">
  <process id="withform" isExecutable="true">
    <startEvent id="s"/>
    <sequenceFlow id="f" sourceRef="s" targetRef="e"/>
    <endEvent id="e"/>
  </process>
</definitions>`;
    // The runtime's deployModels sends processes AND forms here. A `.form` is JSON, not a process:
    // it must not be fed to the BPMN parser (which would throw "no <process> element found"). It is
    // read back through the engine's real read model, not a JS shadow store — but, matching
    // SdkEngineClient, it still counts as deployed, so the reported count is the total number of
    // resources accepted, not just the BPMN.
    const { deployed } = await engine.deployResources([
      { name: "withform.bpmn", content: model, contentType: "text/xml" },
      {
        name: "greeting.form",
        content: JSON.stringify({ components: [{ type: "textfield", key: "who" }] }),
        contentType: "application/json",
      },
    ]);
    assert.equal(deployed, 2, "the deployment accepts every resource (BPMN + form), matching SdkEngineClient");
    // The BPMN really deployed — an instance runs to completion.
    const { processInstanceKey } = await engine.createInstance({
      processDefinitionId: "withform",
    });
    const rows = await engine.searchProcessInstances({
      processInstanceKeys: [processInstanceKey],
    });
    assert.equal(rows[0]?.state, "COMPLETED", "the process deployed alongside the form still runs");
  } finally {
    await engine.close();
  }
});

test("wasm: getForm reads through the engine's read channel (getFormByKey), with no JS shadow store", async () => {
  const engine = await createWasmEngineClient();
  try {
    // The shadow form store is gone: `getForm` now delegates to the read model's
    // `getFormByKey` (`GET /forms/{formKey}`). A form the read model has not indexed resolves to
    // null — there is no JS twin left to satisfy the lookup off-channel. (The read model's form
    // *write* path lands with Magikcraft/nano-bpm#815; this asserts the read delegation itself.)
    await engine.deployResources([
      { name: "greeting.form", content: JSON.stringify({ id: "greeting", type: "default" }), contentType: "application/json" },
    ]);
    assert.equal(await engine.getForm({ formId: "greeting" }), null, "no shadow store answers off-channel");
    assert.equal(await engine.getForm({ formKey: "2251799813685250" }), null, "an unknown form key resolves to null via the read channel");

    // Drift guard: identifier normalization must still match SdkEngineClient — an empty or
    // whitespace-only `formKey` is treated as absent and falls through to `formId` (rather than
    // short-circuiting), and both missing identifiers resolve to null without hitting the engine.
    assert.equal(await engine.getForm({ formKey: "   ", formId: "greeting" }), null, "blank formKey falls through to formId");
    assert.equal(await engine.getForm({}), null, "no identifier resolves to null");
  } finally {
    await engine.close();
  }
});

test("wasm: user-task and process-instance reads come from the read channel (no shadow write)", async () => {
  const engine = await createWasmEngineClient();
  try {
    // A process that parks on a single native user task, carrying an instance variable.
    const model = `<?xml version="1.0" encoding="UTF-8"?>
<definitions xmlns="http://www.omg.org/spec/BPMN/20100524/MODEL"
             xmlns:zeebe="http://camunda.org/schema/zeebe/1.0"
             targetNamespace="http://nanobpm/testkit">
  <process id="human" isExecutable="true">
    <startEvent id="s"/>
    <sequenceFlow id="f1" sourceRef="s" targetRef="review"/>
    <userTask id="review"><extensionElements><zeebe:userTask/></extensionElements></userTask>
    <sequenceFlow id="f2" sourceRef="review" targetRef="e"/>
    <endEvent id="e"/>
  </process>
</definitions>`;
    await engine.deployResources([
      { name: "human.bpmn", content: model, contentType: "text/xml" },
    ]);
    const { processInstanceKey } = await engine.createInstance({
      processDefinitionId: "human",
      variables: { who: "world" },
    });

    // The task is visible through the REST read channel (`POST /user-tasks/search`) — no shadow
    // store was written; the adapter no longer scrapes the primary-state snapshot for this.
    const open = await engine.searchUserTasks({ processInstanceKey, state: "CREATED" });
    assert.equal(open.length, 1, "the open task is served by the read model");
    assert.equal(open[0].elementId, "review");

    // The instance is visible through the REST read channel (`POST /process-instances/search`).
    const [inst] = await engine.searchProcessInstances({ processInstanceKeys: [processInstanceKey] });
    assert.equal(inst?.state, "ACTIVE", "the active instance is served by the read model");

    // Completing the task advances the read model: the instance completes and the task leaves the
    // open set — the read channel reflects the mutation with no shadow bookkeeping.
    await engine.completeUserTask(open[0].userTaskKey);
    assert.equal((await engine.openUserTasks({ processInstanceKey })).length, 0, "the completed task leaves the open set");
    const [after] = await engine.searchProcessInstances({ processInstanceKeys: [processInstanceKey] });
    assert.equal(after?.state, "COMPLETED", "the read model reflects completion");
  } finally {
    await engine.close();
  }
});

test("wasm: searchUserTasks honors the optional state filter (not hardcoded to CREATED)", async () => {
  const engine = await createWasmEngineClient();
  try {
    // A process that parks on a single native user task.
    const model = `<?xml version="1.0" encoding="UTF-8"?>
<definitions xmlns="http://www.omg.org/spec/BPMN/20100524/MODEL"
             xmlns:zeebe="http://camunda.org/schema/zeebe/1.0"
             targetNamespace="http://nanobpm/testkit">
  <process id="human" isExecutable="true">
    <startEvent id="s"/>
    <sequenceFlow id="f1" sourceRef="s" targetRef="review"/>
    <userTask id="review"><extensionElements><zeebe:userTask/></extensionElements></userTask>
    <sequenceFlow id="f2" sourceRef="review" targetRef="e"/>
    <endEvent id="e"/>
  </process>
</definitions>`;
    await engine.deployResources([
      { name: "human.bpmn", content: model, contentType: "text/xml" },
    ]);
    const { processInstanceKey } = await engine.createInstance({ processDefinitionId: "human" });

    // With no state filter the engine returns the task in whatever state it is (here, open),
    // matching SdkEngineClient — the surface, not the adapter, decides to constrain to CREATED.
    const unfiltered = await engine.searchUserTasks({ processInstanceKey });
    assert.equal(unfiltered.length, 1, "an unfiltered search returns the open task");

    // The filter actually discriminates: CREATED matches the open task; COMPLETED does not.
    const open = await engine.searchUserTasks({ processInstanceKey, state: "CREATED" });
    assert.equal(open.length, 1, "state: CREATED returns the open task");
    const done = await engine.searchUserTasks({ processInstanceKey, state: "COMPLETED" });
    assert.equal(done.length, 0, "state: COMPLETED excludes the still-open task (state is applied, not ignored)");
  } finally {
    await engine.close();
  }
});

test("wasm: openUserTasks returns only open (CREATED) tasks, excluding completed", async () => {
  const engine = await createWasmEngineClient();
  try {
    // A process that parks on a single native user task.
    const model = `<?xml version="1.0" encoding="UTF-8"?>
<definitions xmlns="http://www.omg.org/spec/BPMN/20100524/MODEL"
             xmlns:zeebe="http://camunda.org/schema/zeebe/1.0"
             targetNamespace="http://nanobpm/testkit">
  <process id="human" isExecutable="true">
    <startEvent id="s"/>
    <sequenceFlow id="f1" sourceRef="s" targetRef="review"/>
    <userTask id="review"><extensionElements><zeebe:userTask/></extensionElements></userTask>
    <sequenceFlow id="f2" sourceRef="review" targetRef="e"/>
    <endEvent id="e"/>
  </process>
</definitions>`;
    await engine.deployResources([
      { name: "human.bpmn", content: model, contentType: "text/xml" },
    ]);
    const { processInstanceKey } = await engine.createInstance({ processDefinitionId: "human" });

    // While the task is open, openUserTasks surfaces it — exactly as searchUserTasks({ state: "CREATED" }).
    const open = await engine.openUserTasks({ processInstanceKey });
    assert.equal(open.length, 1, "openUserTasks returns the open task");
    assert.equal(open[0].elementId, "review");

    // Answer the task. openUserTasks must now exclude it (the footgun searchUserTasks leaves open):
    // a bare searchUserTasks with no state filter would still report the just-completed task.
    await engine.completeUserTask(open[0].userTaskKey);
    const stillOpen = await engine.openUserTasks({ processInstanceKey });
    assert.equal(stillOpen.length, 0, "openUserTasks never surfaces a completed task as actionable");
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

test("wasm: concurrent create() calls share one init and yield independent engines", async () => {
  // Guards the single-flight boot: two constructions racing the shared boot
  // promise must both succeed (a plain boolean flag could double-init) and be
  // isolated engines.
  const [a, b] = await Promise.all([createWasmEngineClient(), createWasmEngineClient()]);
  try {
    assert.notEqual(a, b);
    const svc = {
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
    };
    // Only `a` gets an instance — `b` must not observe it (separate engines).
    await a.deployResources([svc]);
    const { processInstanceKey } = await a.createInstance({ processDefinitionId: "svc" });
    const inA = await a.searchProcessInstances({ processInstanceKeys: [processInstanceKey] });
    const inB = await b.searchProcessInstances({ processInstanceKeys: [processInstanceKey] });
    assert.equal(inA[0]?.state, "ACTIVE");
    assert.equal(inB.length, 0);
  } finally {
    await a.close();
    await b.close();
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

test("wasm: observeJobs sees each dispatched job type and its unsubscribe detaches the observer", async () => {
  const engine = await createWasmEngineClient();
  try {
    await engine.registerWorker("work", () => ({}));
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

    // The observer fires for the dispatched job type (this is what the coverage gate records on).
    const seen: string[] = [];
    const unobserve = engine.observeJobs((jobType) => seen.push(jobType));
    await engine.createInstance({ processDefinitionId: "svc", awaitCompletion: true });
    assert.deepEqual(seen, ["work"]);

    // Its returned unsubscribe detaches the single-slot observer (the mechanism bootTestApp uses
    // on stop() to bound the coverage recorder's lifetime): a further dispatch records nothing.
    unobserve();
    await engine.createInstance({ processDefinitionId: "svc", awaitCompletion: true });
    assert.deepEqual(seen, ["work"], "no further job type recorded after unsubscribe");
  } finally {
    await engine.close();
  }
});

test("wasm: a throwing observer is isolated — the job still completes, no incident", async () => {
  const engine = await createWasmEngineClient();
  try {
    let calls = 0;
    await engine.registerWorker("work", () => {
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

    // A misbehaving observer must not be able to affect engine/job semantics: it is a passive
    // spectator, so its throw is swallowed and the handler still runs and completes the job.
    engine.observeJobs(() => {
      throw new Error("observer blew up");
    });
    const { processInstanceKey } = await engine.createInstance({
      processDefinitionId: "svc",
      awaitCompletion: true,
    });
    assert.equal(calls, 1, "the handler still ran despite the throwing observer");
    const [inst] = await engine.searchProcessInstances({
      processInstanceKeys: [processInstanceKey],
    });
    assert.equal(inst?.state, "COMPLETED", "the job completed — no failure/incident from the observer");
  } finally {
    await engine.close();
  }
});

const LINEAGE_PROBE_MODEL = `<?xml version="1.0" encoding="UTF-8"?>
<definitions xmlns="http://www.omg.org/spec/BPMN/20100524/MODEL"
             xmlns:zeebe="http://camunda.org/schema/zeebe/1.0"
             targetNamespace="http://nanobpm/testkit">
  <process id="lineageprobe" isExecutable="true">
    <startEvent id="s"/>
    <sequenceFlow id="f1" sourceRef="s" targetRef="probe"/>
    <serviceTask id="probe">
      <extensionElements><zeebe:taskDefinition type="probe"/></extensionElements>
    </serviceTask>
    <sequenceFlow id="f2" sourceRef="probe" targetRef="e"/>
    <endEvent id="e"/>
  </process>
</definitions>`;

test("wasm: createInstance auto-threads the _urban.lineage envelope, observable in-harness (issue #254)", async () => {
  const engine = await createWasmEngineClient();
  try {
    let seen: Record<string, unknown> | undefined;
    await engine.registerWorker("probe", (job) => {
      seen = job.variables;
      return {};
    });
    await engine.deployResources([
      { name: "lineageprobe.bpmn", content: LINEAGE_PROBE_MODEL, contentType: "application/bpmn+xml" },
    ]);
    // A genuine top-level request (no ambient job context) mints a fresh root, threaded onto the
    // instance variables — the worker sees it on its job, straight off the engine.
    await engine.createInstance({ processDefinitionId: "lineageprobe", variables: { payload: 42 } });
    const env = readLineage(seen);
    assert.ok(env, "the instance carries an _urban.lineage envelope");
    assert.notEqual(env?.rootRequestKey, "");
    assert.equal(env?.causedByInstanceKey, undefined, "a fresh top-level root has no cause");
    assert.equal(seen?.payload, 42, "caller variables are preserved alongside the envelope");
  } finally {
    await engine.close();
  }
});

test("wasm: an explicit caller-supplied lineage envelope is preserved (override wins)", async () => {
  const engine = await createWasmEngineClient();
  try {
    let seen: Record<string, unknown> | undefined;
    await engine.registerWorker("probe", (job) => {
      seen = job.variables;
      return {};
    });
    await engine.deployResources([
      { name: "lineageprobe.bpmn", content: LINEAGE_PROBE_MODEL, contentType: "application/bpmn+xml" },
    ]);
    await engine.createInstance({
      processDefinitionId: "lineageprobe",
      variables: { _urban: { lineage: { rootRequestKey: "explicit-root", causedByInstanceKey: "up" } } },
    });
    assert.deepEqual(readLineage(seen), { rootRequestKey: "explicit-root", causedByInstanceKey: "up" });
  } finally {
    await engine.close();
  }
});

// Regression (PR #409 review): `drain()` must reach a fixpoint at the current virtual instant even
// when a previously-dispatched, still-in-flight handler settles *during* a later drain iteration's
// `#quiesce()` (rather than during the pass that dispatched it) and its `completeJob` enqueues fresh
// engine work. A single `drain()` used to return as soon as an iteration activated nothing new
// (`activatedAny === false`), so that just-enqueued follow-on job was left undrained until a later
// `settle()`/`drain()`. Here work1's handler is deliberately slow (spans past the pass that
// dispatched it), so work1 completes in a later pass; the drain must still go on to serve work2 and
// complete the instance in the same `createInstance` call.
test("wasm: drain reaches a fixpoint when a slow handler completes mid-quiesce and enqueues follow-on work", async () => {
  const engine = await createWasmEngineClient();
  const realSetTimeout = globalThis.setTimeout;
  const macrotask = () => new Promise<void>((r) => realSetTimeout(r, 0));
  try {
    let work2Ran = 0;
    // Slow enough to survive the quiesce of the pass that dispatched it (one macrotask), then settle
    // during the *next* pass's quiesce — the pass in which `activatedAny` is false. Its completion
    // enqueues the work2 job, which the drain must still pick up before returning.
    await engine.registerWorker("work1", async () => {
      await macrotask();
      await macrotask();
      return {};
    });
    await engine.registerWorker("work2", () => {
      work2Ran++;
      return {};
    });
    await engine.deployResources([
      {
        name: "chain.bpmn",
        content: `<?xml version="1.0" encoding="UTF-8"?>
<definitions xmlns="http://www.omg.org/spec/BPMN/20100524/MODEL"
             xmlns:zeebe="http://camunda.org/schema/zeebe/1.0"
             targetNamespace="http://nanobpm/testkit">
  <process id="chain" isExecutable="true">
    <startEvent id="s"/><sequenceFlow id="f1" sourceRef="s" targetRef="w1"/>
    <serviceTask id="w1"><extensionElements><zeebe:taskDefinition type="work1"/></extensionElements></serviceTask>
    <sequenceFlow id="f2" sourceRef="w1" targetRef="w2"/>
    <serviceTask id="w2"><extensionElements><zeebe:taskDefinition type="work2"/></extensionElements></serviceTask>
    <sequenceFlow id="f3" sourceRef="w2" targetRef="e"/><endEvent id="e"/>
  </process>
</definitions>`,
        contentType: "application/bpmn+xml",
      },
    ]);

    // A single createInstance → one drain(): both tasks must be served and the instance completed,
    // with no extra settle() needed to pick up the follow-on job work1's completion enqueued.
    const { processInstanceKey } = await engine.createInstance({ processDefinitionId: "chain" });
    assert.equal(work2Ran, 1, "the follow-on worker must run within the same drain, not be stranded");
    const [inst] = await engine.searchProcessInstances({
      processInstanceKeys: [processInstanceKey],
    });
    assert.equal(inst?.state, "COMPLETED", "the instance must complete once drain reaches its fixpoint");
  } finally {
    await engine.close();
  }
});

// Regression (PR #409 review, suppressed advisory wasm-engine.ts:717): fire-and-forget dispatch lets
// a handler stay in-flight past the drain that dispatched it (here parked on a gate the test
// controls). If its engine-completion mapping then throws *after* that drain returned, the failure is
// captured in #inflightError with no later drain/#quiesce to rethrow it — close() used to free the
// engine and silently swallow it. close() must flush and surface that late worker failure fail-loud.
test("wasm: close() surfaces a worker failure captured after the dispatching drain returned", async () => {
  const engine = await createWasmEngineClient();
  const realSetTimeout = globalThis.setTimeout;
  const macrotask = () => new Promise<void>((r) => realSetTimeout(r, 0));
  let releaseGate = () => {};
  const gate = new Promise<void>((r) => {
    releaseGate = r;
  });
  await engine.registerWorker("late", async () => {
    await gate; // park past the drain that dispatches this handler
    // Throw a value whose String()/message coercion itself throws, so the engine-completion mapping
    // (#failFromError) rethrows and the tracked handler promise rejects — the "engine completion call
    // itself" failure the advisory describes, now landing after drain() has already returned.
    throw {
      [Symbol.toPrimitive]() {
        throw new Error("late-completion-boom");
      },
    };
  });
  await engine.deployResources([
    {
      name: "late.bpmn",
      content: `<?xml version="1.0" encoding="UTF-8"?>
<definitions xmlns="http://www.omg.org/spec/BPMN/20100524/MODEL"
             xmlns:zeebe="http://camunda.org/schema/zeebe/1.0"
             targetNamespace="http://nanobpm/testkit">
  <process id="late" isExecutable="true">
    <startEvent id="s"/><sequenceFlow id="f" sourceRef="s" targetRef="t"/>
    <serviceTask id="t"><extensionElements><zeebe:taskDefinition type="late"/></extensionElements></serviceTask>
    <sequenceFlow id="f2" sourceRef="t" targetRef="e"/><endEvent id="e"/>
  </process>
</definitions>`,
      contentType: "application/bpmn+xml",
    },
  ]);

  // createInstance drains; the handler parks on `gate`, so the drain returns with it in-flight.
  await engine.createInstance({ processDefinitionId: "late" });
  // Release the parked handler and let its rejection settle into #inflightError — all *after* the
  // drain that dispatched it returned, with no further drain to rethrow it.
  releaseGate();
  await macrotask();
  await macrotask();

  await assert.rejects(
    engine.close(),
    /late-completion-boom/,
    "close() must surface the late in-flight worker failure, not swallow it at teardown",
  );
});

// Regression (issue #446): the WasmEngineClient use-after-free. A fire-and-forget worker handler
// that parks on *real-time* async work (the reproduction was a readiness probe spawning a
// subprocess) is NOT observed by close()'s macrotask fixpoint — `#quiesce()` sees the in-flight
// count hold steady while the handler is parked on a wall-clock timer, declares quiescence, and
// returns with the handler still pending. close() then freed the engine underneath it; when the
// handler resumed it called `completeJob` on the released wasm handle — the opaque
// "null pointer passed to rust" fault. close() must instead await every in-flight handler to full
// settlement (not just a macrotask fixpoint) before `free()`, closing the use-after-free
// categorically. This test parks a handler on a real-timer promise that outlives the macrotask
// fixpoint, then asserts close() waited for it to finish before returning.
test("wasm: close() awaits a real-time in-flight handler to settlement before free() (no use-after-free)", async () => {
  const engine = await createWasmEngineClient();
  let closed = false;
  // Hoisted above the try so the finally can release the gate (unwedging a handler parked on it)
  // even if an assertion inside the try throws before the normal release path runs.
  let releaseGate = () => {};
  try {
    const realSetTimeout = globalThis.setTimeout;
    // A deferred gate the handler parks on, plus a `started` handshake so the precondition below is
    // a deterministic signal rather than a wall-clock race: an earlier version gated the precondition
    // on a 25 ms real timer, which a paused/overloaded CI event loop could let fire before
    // `createInstance()` finished its macrotask yields, flipping `handlerFinished` early and failing
    // this test even though `close()` was correct. `#quiesce()`'s macrotask fixpoint cannot observe
    // the gate (it is released only by explicit code, i.e. real-time async work), so the drain returns
    // with the handler still in-flight — exactly the issue #446 condition close() must handle.
    const gate = new Promise<void>((r) => {
      releaseGate = r;
    });
    let signalStarted = () => {};
    const started = new Promise<void>((r) => {
      signalStarted = r;
    });
    let handlerFinished = false;
    await engine.registerWorker("slow-realtime", async () => {
      signalStarted();
      await gate;
      handlerFinished = true;
      return {};
    });
    await engine.deployResources([
      {
        name: "slow-realtime.bpmn",
        content: `<?xml version="1.0" encoding="UTF-8"?>
<definitions xmlns="http://www.omg.org/spec/BPMN/20100524/MODEL"
             xmlns:bpmndi="http://www.omg.org/spec/BPMN/20100524/DI"
             xmlns:dc="http://www.omg.org/spec/DD/20100524/DC"
             xmlns:di="http://www.omg.org/spec/DD/20100524/DI"
             xmlns:zeebe="http://camunda.org/schema/zeebe/1.0"
             targetNamespace="http://nanobpm/testkit">
  <process id="slow-realtime" isExecutable="true">
    <startEvent id="s"/><sequenceFlow id="f" sourceRef="s" targetRef="t"/>
    <serviceTask id="t"><extensionElements><zeebe:taskDefinition type="slow-realtime"/></extensionElements></serviceTask>
    <sequenceFlow id="f2" sourceRef="t" targetRef="e"/><endEvent id="e"/>
  </process>
  <bpmndi:BPMNDiagram id="diagram">
    <bpmndi:BPMNPlane id="plane" bpmnElement="slow-realtime">
      <bpmndi:BPMNShape id="s_di" bpmnElement="s"><dc:Bounds x="150" y="100" width="36" height="36"/></bpmndi:BPMNShape>
      <bpmndi:BPMNShape id="t_di" bpmnElement="t"><dc:Bounds x="240" y="78" width="100" height="80"/></bpmndi:BPMNShape>
      <bpmndi:BPMNShape id="e_di" bpmnElement="e"><dc:Bounds x="400" y="100" width="36" height="36"/></bpmndi:BPMNShape>
      <bpmndi:BPMNEdge id="f_di" bpmnElement="f"><di:waypoint x="186" y="118"/><di:waypoint x="240" y="118"/></bpmndi:BPMNEdge>
      <bpmndi:BPMNEdge id="f2_di" bpmnElement="f2"><di:waypoint x="340" y="118"/><di:waypoint x="400" y="118"/></bpmndi:BPMNEdge>
    </bpmndi:BPMNPlane>
  </bpmndi:BPMNDiagram>
</definitions>`,
        contentType: "application/bpmn+xml",
      },
    ]);

    // createInstance drains; the handler signals `started` then parks on the gate, so the drain
    // returns with it in-flight (its `completeJob` has NOT run yet).
    await engine.createInstance({ processDefinitionId: "slow-realtime" });
    await started; // deterministic handshake: the handler is now parked in-flight
    assert.equal(handlerFinished, false, "the handler must still be parked on its gate here");

    // Start close() while the handler is parked in-flight. close() must await the handler's *actual*
    // promise (real-time async work the macrotask fixpoint cannot see), so it cannot return until the
    // gate is released. Prove that deterministically — no wall-clock timer, so a paused/overloaded
    // event loop cannot race the release ahead of the assertion: yield real macrotasks so close()
    // reaches (and stays blocked on) its settlement await, then assert close() is still pending and
    // the handler still parked *before* releasing the gate.
    const closing = engine.close();
    let closeSettled = false;
    void closing.then(() => {
      closeSettled = true;
    });
    // Two real-macrotask yields guarantee close() has reached its `#settleInflight()` await (a
    // microtask hop past the synchronous engine.close() call) without depending on any elapsed time.
    await new Promise<void>((resolve) => realSetTimeout(resolve, 0));
    await new Promise<void>((resolve) => realSetTimeout(resolve, 0));
    assert.equal(handlerFinished, false, "close() must not resume the handler before it settles");
    assert.equal(closeSettled, false, "close() must still be awaiting the in-flight handler");

    // Release the gate: the handler now settles, and only then may close() free the engine and return.
    releaseGate();
    await closing;
    closed = true;
    assert.ok(
      handlerFinished,
      "close() must await the in-flight real-time handler to settlement before free()",
    );
  } finally {
    // The engine allocates native WASM memory. Release the gate first so any handler still parked on
    // it unblocks — otherwise a failing assertion above would wedge this close() on the unresolved
    // gate forever (close() awaits the parked handler's real promise). releaseGate() is idempotent,
    // so releasing an already-released gate is a no-op. Then close (idempotently) so a failure does
    // not also leak the native engine into the rest of the run.
    releaseGate();
    if (!closed) await engine.close();
  }
});

// Regression (issue #446 follow-up, wasm-engine.ts:785): the virtual-timer sibling of the real-time
// use-after-free above. A handler parked on the testkit's VIRTUAL `app.wait()` clock sits on a timer
// no `advanceTime` fires during teardown, so it holds `#inflight` steady exactly like the real-time
// park — but unlike real-time work it will NEVER settle on its own. close()'s `#settleInflight()`
// therefore awaited a promise that could not resolve and hung until the test-runner timeout. close()
// now aborts `shutdownSignal` BEFORE settling, so a virtual-clock park is cancelled: its `app.wait()`
// rejects, the handler unwinds (its throw maps to `failJob` on the still-live engine), `#inflight`
// drains, and close() completes. Real-time work ignores the signal and is still awaited (test above).
test("wasm: close() cancels a handler parked on a virtual-clock wait instead of hanging (#446 follow-up)", async () => {
  const engine = await createWasmEngineClient();
  const realSetTimeout = globalThis.setTimeout;
  let handlerSettled = false;
  // Stand in for a worker parked on `app.wait()`: a promise ONLY the shutdown abort can settle —
  // never a macrotask, never real time. That is exactly how the testkit scheduler backs `app.wait()`
  // (a virtual timer), so it reproduces the close() hang without booting a whole app. Without the
  // shutdown abort this promise never settles and close() below would hang forever.
  await engine.registerWorker("virtual-wait", async () => {
    try {
      await new Promise<void>((_resolve, reject) => {
        const signal = engine.shutdownSignal;
        if (signal.aborted) {
          reject(new Error("shutdown"));
          return;
        }
        signal.addEventListener("abort", () => reject(new Error("shutdown")), { once: true });
      });
    } finally {
      handlerSettled = true;
    }
  });
  await engine.deployResources([
    {
      name: "virtual-wait.bpmn",
      content: `<?xml version="1.0" encoding="UTF-8"?>
<definitions xmlns="http://www.omg.org/spec/BPMN/20100524/MODEL"
             xmlns:bpmndi="http://www.omg.org/spec/BPMN/20100524/DI"
             xmlns:dc="http://www.omg.org/spec/DD/20100524/DC"
             xmlns:di="http://www.omg.org/spec/DD/20100524/DI"
             xmlns:zeebe="http://camunda.org/schema/zeebe/1.0"
             targetNamespace="http://nanobpm/testkit">
  <process id="virtual-wait" isExecutable="true">
    <startEvent id="s"/><sequenceFlow id="f" sourceRef="s" targetRef="t"/>
    <serviceTask id="t"><extensionElements><zeebe:taskDefinition type="virtual-wait"/></extensionElements></serviceTask>
    <sequenceFlow id="f2" sourceRef="t" targetRef="e"/><endEvent id="e"/>
  </process>
  <bpmndi:BPMNDiagram id="diagram">
    <bpmndi:BPMNPlane id="plane" bpmnElement="virtual-wait">
      <bpmndi:BPMNShape id="s_di" bpmnElement="s"><dc:Bounds x="150" y="100" width="36" height="36"/></bpmndi:BPMNShape>
      <bpmndi:BPMNShape id="t_di" bpmnElement="t"><dc:Bounds x="240" y="78" width="100" height="80"/></bpmndi:BPMNShape>
      <bpmndi:BPMNShape id="e_di" bpmnElement="e"><dc:Bounds x="400" y="100" width="36" height="36"/></bpmndi:BPMNShape>
      <bpmndi:BPMNEdge id="f_di" bpmnElement="f"><di:waypoint x="186" y="118"/><di:waypoint x="240" y="118"/></bpmndi:BPMNEdge>
      <bpmndi:BPMNEdge id="f2_di" bpmnElement="f2"><di:waypoint x="340" y="118"/><di:waypoint x="400" y="118"/></bpmndi:BPMNEdge>
    </bpmndi:BPMNPlane>
  </bpmndi:BPMNDiagram>
</definitions>`,
      contentType: "application/bpmn+xml",
    },
  ]);

  // createInstance drains; the handler parks on the "virtual wait", so the drain returns with it
  // in-flight (its completion has NOT run).
  await engine.createInstance({ processDefinitionId: "virtual-wait" });
  assert.equal(handlerSettled, false, "the handler must still be parked on its virtual wait here");

  // close() must abort shutdownSignal, cancelling the park, so it completes deterministically within
  // a few real macrotasks (abort → wait rejects → handler unwinds → failJob → #inflight empties → free).
  // No wall-clock waiting: a hang would leave closeSettled false and fail fast (rather than deadlock).
  const closing = engine.close();
  let closeSettled = false;
  void closing.then(() => {
    closeSettled = true;
  });
  for (let i = 0; i < 5; i++) {
    await new Promise<void>((resolve) => realSetTimeout(resolve, 0));
  }
  assert.ok(handlerSettled, "shutdown must cancel the virtual-clock park (not leave it hanging)");
  assert.ok(closeSettled, "close() must complete once the virtual park is cancelled, not hang on it");
  await closing;
});
