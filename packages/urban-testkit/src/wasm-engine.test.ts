import { test } from "node:test";
import assert from "node:assert/strict";
import { runEngineClientContract } from "./contract.ts";
import {
  createWasmEngineClient,
  deriveElementInstances,
  deriveWaitStates,
  parseForm,
  presentKey,
  presentString,
  requireKey,
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

// `requireKey` guards the mutating seam ops (resolveIncident/updateJobRetries/setVariables): a
// required key must be present and is normalized under the shared trim rule, or it throws fast —
// matching `SdkEngineClient`'s `requireEngineKey` so the two adapters can't drift.
test("wasm: requireKey trims a present key and throws on a blank/absent one", () => {
  assert.equal(requireKey("k1", "incidentKey"), "k1");
  assert.equal(requireKey("  k2  ", "incidentKey"), "k2", "trims like the shared presence rule");
  assert.equal(requireKey(2251799813685250, "jobKey"), "2251799813685250", "numeric key stringified");
  assert.throws(() => requireKey("   ", "incidentKey"), /incidentKey must be a non-empty key/);
  assert.throws(() => requireKey("", "scopeKey"), /scopeKey must be a non-empty key/);
  assert.throws(() => requireKey(undefined, "jobKey"), /jobKey must be a non-empty key/);
});

// The mutating incident-repair seam ops must fail fast on a caller-side bug rather than forward a
// garbage identifier / invalid retry count into the WASM engine and surface an opaque error —
// parity with `SdkEngineClient` (No Drift Surfaces). These guards are input validation, so they
// reject before touching the live engine (no deploy/instance needed).
test("wasm: mutating seam ops reject blank keys and invalid retry counts before hitting the engine", async () => {
  const engine = await createWasmEngineClient();
  try {
    await assert.rejects(
      () => engine.resolveIncident({ incidentKey: "   " }),
      /incidentKey must be a non-empty key/,
    );
    await assert.rejects(
      () => engine.setVariables({ scopeKey: "", variables: { x: 1 } }),
      /scopeKey must be a non-empty key/,
    );
    await assert.rejects(
      () => engine.updateJobRetries({ jobKey: " ", retries: 3 }),
      /jobKey must be a non-empty key/,
    );
    // A blank key is caught before the retry-count check, so exercise `retries` with a valid key.
    for (const retries of [Number.NaN, 1.5, -1]) {
      await assert.rejects(
        () => engine.updateJobRetries({ jobKey: "1", retries }),
        /retries must be a non-negative integer/,
        `retries=${retries} must be rejected`,
      );
    }
  } finally {
    await engine.close();
  }
});

// The `searchIncidents` `processInstanceKey` selector is normalized under the shared trim rule, so
// a padded key (`" <key> "`) still matches the owning instance and a whitespace-only selector is
// treated as absent (returns all) rather than silently filtering everything out — matching
// `SdkEngineClient`'s request-selector normalization.
test("wasm: searchIncidents normalizes the processInstanceKey selector (padded matches, blank is absent)", async () => {
  const model = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"
  xmlns:zeebe="http://camunda.org/schema/zeebe/1.0"
  id="defs_sel" targetNamespace="http://nanobpm.io/testkit">
  <bpmn:process id="sel_incident" isExecutable="true">
    <bpmn:startEvent id="start"><bpmn:outgoing>f1</bpmn:outgoing></bpmn:startEvent>
    <bpmn:sequenceFlow id="f1" sourceRef="start" targetRef="work"/>
    <bpmn:serviceTask id="work">
      <bpmn:extensionElements><zeebe:taskDefinition type="work"/></bpmn:extensionElements>
      <bpmn:incoming>f1</bpmn:incoming><bpmn:outgoing>f2</bpmn:outgoing>
    </bpmn:serviceTask>
    <bpmn:sequenceFlow id="f2" sourceRef="work" targetRef="end"/>
    <bpmn:endEvent id="end"><bpmn:incoming>f2</bpmn:incoming></bpmn:endEvent>
  </bpmn:process>
</bpmn:definitions>`;
  const engine = await createWasmEngineClient();
  try {
    await engine.registerWorker("work", () => {
      throw new Error("always fails → incident");
    });
    await engine.deployResources([
      { name: "sel_incident.bpmn", content: model, contentType: "text/xml" },
    ]);
    const { processInstanceKey } = await engine.createInstance({
      processDefinitionId: "sel_incident",
    });
    assert.equal((await engine.searchIncidents()).length, 1, "one incident raised");

    // Exact key matches; a padded copy of that same key still matches (selector is trimmed).
    assert.equal((await engine.searchIncidents({ processInstanceKey })).length, 1);
    assert.equal(
      (await engine.searchIncidents({ processInstanceKey: `  ${processInstanceKey}  ` })).length,
      1,
      "a padded selector is trimmed and still matches the owning instance",
    );
    // A whitespace-only selector is treated as absent (not an impossible filter) → returns all.
    assert.equal(
      (await engine.searchIncidents({ processInstanceKey: "   " })).length,
      1,
      "a blank selector is absent, not a filter that matches nothing",
    );
    // A genuinely different key still filters everything out.
    assert.equal(
      (await engine.searchIncidents({ processInstanceKey: "does-not-exist" })).length,
      0,
    );
  } finally {
    await engine.close();
  }
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
             xmlns:bpmndi="http://www.omg.org/spec/BPMN/20100524/DI"
             xmlns:dc="http://www.omg.org/spec/DD/20100524/DC"
             xmlns:di="http://www.omg.org/spec/DD/20100524/DI"
             xmlns:zeebe="http://camunda.org/schema/zeebe/1.0"
             targetNamespace="http://nanobpm/testkit">
  <process id="late" isExecutable="true">
    <startEvent id="s"/><sequenceFlow id="f" sourceRef="s" targetRef="t"/>
    <serviceTask id="t"><extensionElements><zeebe:taskDefinition type="late"/></extensionElements></serviceTask>
    <sequenceFlow id="f2" sourceRef="t" targetRef="e"/><endEvent id="e"/>
  </process>
  <bpmndi:BPMNDiagram id="diagram">
    <bpmndi:BPMNPlane id="plane" bpmnElement="late">
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
  let closed = false;
  // Test-controlled safety release for the park below. If an assertion fails before close()
  // completes, the finally awaits the memoized close() — which, when the shutdown path under test
  // is broken (never aborts shutdownSignal), would be the never-settling promise and wedge the whole
  // suite until the runner timeout. Aborting this in cleanup force-unparks the handler so that close
  // resolves and the real assertion failure surfaces fast.
  const release = new AbortController();
  try {
    // Stand in for a worker parked on `app.wait()`: a promise ONLY the shutdown abort can settle —
    // never a macrotask, never real time. That is exactly how the testkit scheduler backs `app.wait()`
    // (a virtual timer), so it reproduces the close() hang without booting a whole app. Without the
    // shutdown abort this promise never settles and close() below would hang forever.
    await engine.registerWorker("virtual-wait", async () => {
      try {
        await new Promise<void>((_resolve, reject) => {
          const signal = engine.shutdownSignal;
          const onAbort = () => reject(new Error("shutdown"));
          if (signal.aborted) {
            reject(new Error("shutdown"));
            return;
          }
          signal.addEventListener("abort", onAbort, { once: true });
          release.signal.addEventListener("abort", onAbort, { once: true });
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
    closed = true;
  } finally {
    // The engine allocates native WASM memory. If an assertion above throws before close() completes,
    // release it so the failing case does not leak the native handle into the rest of the suite.
    // Force-unpark the handler first (test-controlled release): should the shutdown path under test be
    // broken and close() therefore never settle, this ensures the memoized close() below still resolves
    // and the assertion failure fails fast instead of wedging the suite on a never-settling wait.
    // close() is idempotent (memoized shutdown run), so closing an already-closed engine is a no-op.
    release.abort();
    if (!closed) await engine.close();
  }
});

// Regression (PR #447 review, wasm-engine.ts:580 — facet 4): a worker handler can itself call
// `await engine.close()` (workers reach the engine through `AppApi`). The handler's OWN tracked
// promise is in `#inflight` while it awaits close(), but that promise can only settle once close()
// returns — so a `#settleInflight()` that waits on the whole `#inflight` set dead-awaits itself:
// close() waits for the handler, the handler waits for close(). It never hits the iteration cap
// (the promise is merely pending, not re-creating work), it just hangs. close() now excludes the
// caller's own tracked promise from its settlement wait, so a handler-initiated close() drains its
// PEERS but not itself, and the companion `#freed` guard in `#runJob` stops the resumed handler
// from completing its job on the freed engine (the issue #446 use-after-free). Deterministic: a
// regression leaves `closeReturned` false and fails fast on the assertions below — it does not hang.
test("wasm: a handler that calls engine.close() does not dead-await itself (#447 review, facet 4)", async () => {
  const engine = await createWasmEngineClient();
  const realSetTimeout = globalThis.setTimeout;
  let closeReturned = false;
  let handlerReturned = false;
  let closed = false;
  try {
    // The handler self-initiates teardown: it awaits close() (as a real worker would when it reaches
    // the engine via AppApi), then falls through to its normal return — the exact re-entrant path
    // Copilot flagged. Before the fix `await engine.close()` never resolves, so neither flag flips.
    await engine.registerWorker("self-close", async () => {
      // Yield one real macrotask FIRST so this handler is fully registered in `#inflight` (the
      // fire-and-forget `#track` completes only after the synchronous dispatch returns) before it
      // self-initiates teardown. Only then does `await engine.close()` exercise the re-entrant path:
      // the handler's own tracked promise is in the set `#settleInflight()` would otherwise wait on.
      await new Promise<void>((resolve) => realSetTimeout(resolve, 0));
      await engine.close();
      closeReturned = true;
      handlerReturned = true;
      return {};
    });
    await engine.deployResources([
      {
        name: "self-close.bpmn",
        content: `<?xml version="1.0" encoding="UTF-8"?>
<definitions xmlns="http://www.omg.org/spec/BPMN/20100524/MODEL"
             xmlns:bpmndi="http://www.omg.org/spec/BPMN/20100524/DI"
             xmlns:dc="http://www.omg.org/spec/DD/20100524/DC"
             xmlns:di="http://www.omg.org/spec/DD/20100524/DI"
             xmlns:zeebe="http://camunda.org/schema/zeebe/1.0"
             targetNamespace="http://nanobpm/testkit">
  <process id="self-close" isExecutable="true">
    <startEvent id="s"/><sequenceFlow id="f" sourceRef="s" targetRef="t"/>
    <serviceTask id="t"><extensionElements><zeebe:taskDefinition type="self-close"/></extensionElements></serviceTask>
    <sequenceFlow id="f2" sourceRef="t" targetRef="e"/><endEvent id="e"/>
  </process>
  <bpmndi:BPMNDiagram id="diagram">
    <bpmndi:BPMNPlane id="plane" bpmnElement="self-close">
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

    // createInstance drains, which dispatches the handler; the handler calls close() from that
    // in-flight context. Yield a few real macrotasks so the (now non-deadlocking) close() and the
    // handler resumption both complete deterministically without any wall-clock waiting.
    await engine.createInstance({ processDefinitionId: "self-close" });
    for (let i = 0; i < 5; i++) {
      await new Promise<void>((resolve) => realSetTimeout(resolve, 0));
    }
    closed = true;
    assert.ok(closeReturned, "a handler-initiated close() must resolve, not dead-await its own promise");
    assert.ok(
      handlerReturned,
      "the handler must resume after its self-initiated close() (and not crash completing on the freed engine)",
    );
    // The memoized close() run is settled — a later external close() is a no-op, proving the engine
    // was cleanly freed exactly once (no double-free, no hang).
    await engine.close();
  } finally {
    // If an assertion above threw before the self-close ran, close idempotently so a failure does not
    // leak the native WASM handle into the rest of the suite. close() is memoized, so this is a no-op
    // once the handler already closed it.
    if (!closed) await engine.close();
  }
});

// Regression (PR #447 review, suppressed advisory wasm-engine.ts:571 — facet 4, two-handler
// variant): TWO handlers can each `await engine.close()` while both are in-flight. The first is the
// initiator (`#doClose` runs in ITS context); the second re-enters the memoized run and just awaits
// `#closeRun`. A single "exclude the caller's own promise" rule only drops the initiator, so
// `#settleInflight()` — running in the initiator's context — still waits on the SECOND handler's
// tracked promise, which can only settle after close() returns: a two-party deadlock the one-handler
// regression above cannot catch. close() now records EVERY handler that enters it as a close-awaiter
// and `#settleInflight()` excludes all of them, waking a mid-await pass when a peer parks on close().
// Deterministic: a regression leaves the flags false and fails fast on the assertions — it does not
// hang. Both handlers therefore drain their genuine peers but never each other.
test("wasm: two handlers can both call engine.close() without dead-awaiting each other (#447 review, facet 4)", async () => {
  const engine = await createWasmEngineClient();
  const realSetTimeout = globalThis.setTimeout;
  const macrotask = () => new Promise<void>((r) => realSetTimeout(r, 0));
  let release!: () => void;
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  let w1Returned = false;
  let w2Returned = false;
  let closed = false;
  const model = (id: string, type: string) => ({
    name: `${id}.bpmn`,
    content: `<?xml version="1.0" encoding="UTF-8"?>
<definitions xmlns="http://www.omg.org/spec/BPMN/20100524/MODEL"
             xmlns:bpmndi="http://www.omg.org/spec/BPMN/20100524/DI"
             xmlns:dc="http://www.omg.org/spec/DD/20100524/DC"
             xmlns:di="http://www.omg.org/spec/DD/20100524/DI"
             xmlns:zeebe="http://camunda.org/schema/zeebe/1.0"
             targetNamespace="http://nanobpm/testkit">
  <process id="${id}" isExecutable="true">
    <startEvent id="s"/><sequenceFlow id="f" sourceRef="s" targetRef="t"/>
    <serviceTask id="t"><extensionElements><zeebe:taskDefinition type="${type}"/></extensionElements></serviceTask>
    <sequenceFlow id="f2" sourceRef="t" targetRef="e"/><endEvent id="e"/>
  </process>
  <bpmndi:BPMNDiagram id="diagram">
    <bpmndi:BPMNPlane id="plane" bpmnElement="${id}">
      <bpmndi:BPMNShape id="s_di" bpmnElement="s"><dc:Bounds x="150" y="100" width="36" height="36"/></bpmndi:BPMNShape>
      <bpmndi:BPMNShape id="t_di" bpmnElement="t"><dc:Bounds x="240" y="78" width="100" height="80"/></bpmndi:BPMNShape>
      <bpmndi:BPMNShape id="e_di" bpmnElement="e"><dc:Bounds x="400" y="100" width="36" height="36"/></bpmndi:BPMNShape>
      <bpmndi:BPMNEdge id="f_di" bpmnElement="f"><di:waypoint x="186" y="118"/><di:waypoint x="240" y="118"/></bpmndi:BPMNEdge>
      <bpmndi:BPMNEdge id="f2_di" bpmnElement="f2"><di:waypoint x="340" y="118"/><di:waypoint x="400" y="118"/></bpmndi:BPMNEdge>
    </bpmndi:BPMNPlane>
  </bpmndi:BPMNDiagram>
</definitions>`,
    contentType: "application/bpmn+xml",
  });
  try {
    // Both handlers park on a shared barrier FIRST so both are fully tracked in `#inflight` (with
    // `store.own` published), then each self-initiates teardown. Whichever resumes first is the
    // close() initiator; the other re-enters the memoized run — the exact two-party path.
    await engine.registerWorker("close-1", async () => {
      await barrier;
      await engine.close();
      w1Returned = true;
      return {};
    });
    await engine.registerWorker("close-2", async () => {
      await barrier;
      await engine.close();
      w2Returned = true;
      return {};
    });
    await engine.deployResources([model("p1", "close-1"), model("p2", "close-2")]);
    // One drain each: the handler parks on the barrier, so drain quiesces and returns with it in
    // flight. After both are parked, release the barrier so both call close() in the same flush.
    await engine.createInstance({ processDefinitionId: "p1" });
    await engine.createInstance({ processDefinitionId: "p2" });
    release();
    // Yield a few real macrotasks so both close() calls and both handler resumptions settle
    // deterministically. A regression deadlocks here (neither flag flips) and fails fast below.
    for (let i = 0; i < 10; i++) await macrotask();
    closed = true;
    assert.ok(w1Returned, "the initiating handler's close() must resolve, not dead-await a peer");
    assert.ok(w2Returned, "the peer handler that re-entered close() must resolve, not deadlock");
    // The single memoized run is settled: an external close() is now a no-op over the freed engine.
    await engine.close();
  } finally {
    if (!closed) {
      release();
      await engine.close();
    }
  }
});

// Regression (PR #447 review, wasm-engine.ts:920 handler-context thread): the `AsyncLocalStorage`
// handler context must scope to the ACTUAL worker-handler invocation, not the whole `#runJob`.
// `#runJob` runs dispatch-time callbacks — the `observeJobs` coverage observer (and mock predicates)
// — BEFORE `worker.handler` starts. If those ran under the handler context, an observer that
// re-enters `close()` would read the still-parked handler's tracked promise as `store.own`, record
// it as a close-awaiter, and `#settleInflight()` would exclude it and free the engine WHILE the real
// handler is still parked on real async work — the #446 use-after-free. A dispatch observer is not
// the handler, so its `close()` is an EXTERNAL close that must await the parked handler in full.
// Deterministic: the observer's `close()` must not resolve while the handler is parked; a regression
// resolves it early and fails fast on the `!closeResolved` assertion rather than hanging.
test("wasm: a dispatch-time observer re-entering close() awaits the parked handler, not frees under it (#447 review)", async () => {
  const engine = await createWasmEngineClient();
  const realSetTimeout = globalThis.setTimeout;
  const macrotask = () => new Promise<void>((r) => realSetTimeout(r, 0));
  let release!: () => void;
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  let handlerFinished = false;
  let closeResolved = false;
  let closeP: Promise<void> | undefined;
  let closed = false;
  const model = {
    name: "observer-close.bpmn",
    content: `<?xml version="1.0" encoding="UTF-8"?>
<definitions xmlns="http://www.omg.org/spec/BPMN/20100524/MODEL"
             xmlns:bpmndi="http://www.omg.org/spec/BPMN/20100524/DI"
             xmlns:dc="http://www.omg.org/spec/DD/20100524/DC"
             xmlns:di="http://www.omg.org/spec/DD/20100524/DI"
             xmlns:zeebe="http://camunda.org/schema/zeebe/1.0"
             targetNamespace="http://nanobpm/testkit">
  <process id="observer-close" isExecutable="true">
    <startEvent id="s"/><sequenceFlow id="f" sourceRef="s" targetRef="t"/>
    <serviceTask id="t"><extensionElements><zeebe:taskDefinition type="observed"/></extensionElements></serviceTask>
    <sequenceFlow id="f2" sourceRef="t" targetRef="e"/><endEvent id="e"/>
  </process>
  <bpmndi:BPMNDiagram id="diagram">
    <bpmndi:BPMNPlane id="plane" bpmnElement="observer-close">
      <bpmndi:BPMNShape id="s_di" bpmnElement="s"><dc:Bounds x="150" y="100" width="36" height="36"/></bpmndi:BPMNShape>
      <bpmndi:BPMNShape id="t_di" bpmnElement="t"><dc:Bounds x="240" y="78" width="100" height="80"/></bpmndi:BPMNShape>
      <bpmndi:BPMNShape id="e_di" bpmnElement="e"><dc:Bounds x="400" y="100" width="36" height="36"/></bpmndi:BPMNShape>
      <bpmndi:BPMNEdge id="f_di" bpmnElement="f"><di:waypoint x="186" y="118"/><di:waypoint x="240" y="118"/></bpmndi:BPMNEdge>
      <bpmndi:BPMNEdge id="f2_di" bpmnElement="f2"><di:waypoint x="340" y="118"/><di:waypoint x="400" y="118"/></bpmndi:BPMNEdge>
    </bpmndi:BPMNPlane>
  </bpmndi:BPMNDiagram>
</definitions>`,
    contentType: "application/bpmn+xml",
  };
  try {
    // The real handler parks on a real-time barrier, holding `#inflight` steady. It is a genuine
    // in-flight handler close() MUST await before freeing the engine.
    await engine.registerWorker("observed", async () => {
      await barrier;
      handlerFinished = true;
      return {};
    });
    // The observer runs at dispatch — BEFORE `worker.handler` — and re-enters close() fire-and-forget.
    // It is not the handler, so its close() is external and must await the parked handler.
    engine.observeJobs(() => {
      closeP ??= engine.close().then(() => {
        closeResolved = true;
      });
    });
    await engine.deployResources([model]);
    await engine.createInstance({ processDefinitionId: "observer-close" });
    // Let dispatch, the observer's close(), and `#settleInflight()` run while the handler stays
    // parked on the (unreleased) barrier. A regression frees the engine here and resolves close().
    for (let i = 0; i < 5; i++) await macrotask();
    assert.ok(
      !closeResolved,
      "an observer-initiated close() must NOT resolve while the real handler it dispatched is still parked",
    );
    assert.ok(!handlerFinished, "the handler is still parked on the barrier");
    // Release the handler: it completes on the still-live engine, then close() drains it and frees.
    release();
    for (let i = 0; i < 5; i++) await macrotask();
    await closeP;
    closed = true;
    assert.ok(handlerFinished, "the parked handler must complete before the engine is freed");
    assert.ok(closeResolved, "close() resolves once the awaited handler has settled");
    await engine.close();
  } finally {
    if (!closed) {
      release();
      await engine.close();
    }
  }
});

// Regression (PR #447 review, wasm-engine.ts:1075 — self-close use-after-free, categorical): the
// `#freed` guard in `#runJob` only silences a resumed self-closing handler's own final `completeJob`.
// A handler that self-closes and then keeps using `AppApi.engine` — `publishMessage`, `createInstance`,
// a read, … — would still drive the freed WASM handle (the opaque "null pointer passed to rust" #446
// use-after-free). Every public EngineClient op now reaches the engine through `#liveEngine`, which
// throws a clear error once freed. This tests that surface directly at the client boundary (a resumed
// handler's throw is swallowed by `#runJob`, so exercising it via the public API is the observable
// path): after close(), every operation must reject/throw with a "used after close()" error rather
// than crash on the released handle. Deterministic — no wall-clock, no in-flight handlers.
test("wasm: engine operations fault cleanly after close() instead of driving a freed handle (#447 review)", async () => {
  const engine = await createWasmEngineClient();
  await engine.close();
  const usedAfterClose = /used after close\(\)/;
  await assert.rejects(
    () => engine.createInstance({ processDefinitionId: "nope" }),
    usedAfterClose,
    "createInstance after close() must reject cleanly, not fault the freed handle",
  );
  await assert.rejects(
    () => engine.publishMessage({ name: "m" }),
    usedAfterClose,
    "publishMessage after close() must reject cleanly",
  );
  await assert.rejects(
    () => engine.cancelInstance({ processInstanceKey: "1" }),
    usedAfterClose,
    "cancelInstance after close() must reject cleanly",
  );
  await assert.rejects(
    () => engine.completeUserTask("1"),
    usedAfterClose,
    "completeUserTask after close() must reject cleanly",
  );
  await assert.rejects(
    () => engine.searchUserTasks(),
    usedAfterClose,
    "searchUserTasks after close() must reject cleanly",
  );
  await assert.rejects(
    () => engine.searchProcessInstances(),
    usedAfterClose,
    "searchProcessInstances after close() must reject cleanly",
  );
  await assert.rejects(
    () => engine.getForm({ formKey: "1" }),
    usedAfterClose,
    "getForm after close() must reject cleanly (its live-engine resolve is outside the malformed-key catch)",
  );
  await assert.rejects(
    () => engine.registerWorker("nope", async () => ({})),
    usedAfterClose,
    "registerWorker after close() must reject cleanly, not resolve with a subscription on a freed engine",
  );
  await assert.rejects(
    () =>
      engine.deployResources([
        { name: "x.bpmn", content: "<definitions/>", contentType: "application/bpmn+xml" },
      ]),
    usedAfterClose,
    "deployResources of an executable model after close() must reject cleanly",
  );
  assert.throws(() => engine.snapshot(), usedAfterClose, "snapshot after close() must throw cleanly");
  assert.throws(() => engine.now, usedAfterClose, "now after close() must throw cleanly");
});

// Regression (PR #447 review, suppressed wasm-engine.ts:835 — batch teardown ordering + suppressed
// wasm-engine.test.ts:949 — synchronous self-close). A single drain pass can activate SEVERAL jobs in
// one `activateJobs` batch (here: a parallel gateway forks to two service tasks of the same type). If
// the FIRST job's handler self-closes SYNCHRONOUSLY — calling `await engine.close()` as its first act,
// so close()'s synchronous head flips `#closing` before the handler yields — the drain loop must NOT
// keep dispatching the remaining jobs in that batch: `#settleInflight()` has already snapshotted
// `#inflight` seeing only the excluded self-closer, so a later-dispatched peer would be left in-flight
// when `free()` runs (a #446 use-after-free). This also exercises the `#track` publish-before-run
// ordering: a synchronous self-close only works if the handler's own tracked promise is already in
// `#inflight` (as `store.own`) before `run()` executes. Deterministic: without the batch guard the
// second job is dispatched (`peerDispatched` flips) and fails the assertion; with it, it never is.
test("wasm: a synchronous self-close stops dispatching the rest of its drain batch (#447 review, facet 835)", async () => {
  const engine = await createWasmEngineClient();
  const realSetTimeout = globalThis.setTimeout;
  let dispatches = 0;
  let peerDispatched = false;
  let closeReturned = false;
  let closed = false;
  try {
    // Both forked service tasks share this type, so one `activateJobs("fan", …)` returns both jobs and
    // the drain dispatches them back-to-back in one synchronous pass. The FIRST dispatch self-closes
    // synchronously (its first statement is `await engine.close()`); a SECOND dispatch — which must not
    // happen once close() has begun — records that it leaked through.
    await engine.registerWorker("fan", async () => {
      dispatches += 1;
      if (dispatches === 1) {
        await engine.close();
        closeReturned = true;
        return {};
      }
      peerDispatched = true;
      return {};
    }, { maxParallelJobs: 10 });
    await engine.deployResources([
      {
        name: "fan.bpmn",
        content: `<?xml version="1.0" encoding="UTF-8"?>
<definitions xmlns="http://www.omg.org/spec/BPMN/20100524/MODEL"
             xmlns:bpmndi="http://www.omg.org/spec/BPMN/20100524/DI"
             xmlns:dc="http://www.omg.org/spec/DD/20100524/DC"
             xmlns:di="http://www.omg.org/spec/DD/20100524/DI"
             xmlns:zeebe="http://camunda.org/schema/zeebe/1.0"
             targetNamespace="http://nanobpm/testkit">
  <process id="fan" isExecutable="true">
    <startEvent id="s"/>
    <sequenceFlow id="f0" sourceRef="s" targetRef="g"/>
    <parallelGateway id="g"/>
    <sequenceFlow id="fa" sourceRef="g" targetRef="ta"/>
    <sequenceFlow id="fb" sourceRef="g" targetRef="tb"/>
    <serviceTask id="ta"><extensionElements><zeebe:taskDefinition type="fan"/></extensionElements></serviceTask>
    <serviceTask id="tb"><extensionElements><zeebe:taskDefinition type="fan"/></extensionElements></serviceTask>
    <sequenceFlow id="fa2" sourceRef="ta" targetRef="e"/>
    <sequenceFlow id="fb2" sourceRef="tb" targetRef="e"/>
    <endEvent id="e"/>
  </process>
  <bpmndi:BPMNDiagram id="diagram">
    <bpmndi:BPMNPlane id="plane" bpmnElement="fan">
      <bpmndi:BPMNShape id="s_di" bpmnElement="s"><dc:Bounds x="150" y="100" width="36" height="36"/></bpmndi:BPMNShape>
      <bpmndi:BPMNShape id="g_di" bpmnElement="g"><dc:Bounds x="240" y="95" width="50" height="50"/></bpmndi:BPMNShape>
      <bpmndi:BPMNShape id="ta_di" bpmnElement="ta"><dc:Bounds x="340" y="40" width="100" height="80"/></bpmndi:BPMNShape>
      <bpmndi:BPMNShape id="tb_di" bpmnElement="tb"><dc:Bounds x="340" y="150" width="100" height="80"/></bpmndi:BPMNShape>
      <bpmndi:BPMNShape id="e_di" bpmnElement="e"><dc:Bounds x="500" y="100" width="36" height="36"/></bpmndi:BPMNShape>
      <bpmndi:BPMNEdge id="f0_di" bpmnElement="f0"><di:waypoint x="186" y="118"/><di:waypoint x="240" y="120"/></bpmndi:BPMNEdge>
      <bpmndi:BPMNEdge id="fa_di" bpmnElement="fa"><di:waypoint x="290" y="120"/><di:waypoint x="340" y="80"/></bpmndi:BPMNEdge>
      <bpmndi:BPMNEdge id="fb_di" bpmnElement="fb"><di:waypoint x="290" y="120"/><di:waypoint x="340" y="190"/></bpmndi:BPMNEdge>
      <bpmndi:BPMNEdge id="fa2_di" bpmnElement="fa2"><di:waypoint x="440" y="80"/><di:waypoint x="500" y="118"/></bpmndi:BPMNEdge>
      <bpmndi:BPMNEdge id="fb2_di" bpmnElement="fb2"><di:waypoint x="440" y="190"/><di:waypoint x="500" y="118"/></bpmndi:BPMNEdge>
    </bpmndi:BPMNPlane>
  </bpmndi:BPMNDiagram>
</definitions>`,
        contentType: "application/bpmn+xml",
      },
    ]);
    await engine.createInstance({ processDefinitionId: "fan" });
    for (let i = 0; i < 5; i++) {
      await new Promise<void>((resolve) => realSetTimeout(resolve, 0));
    }
    closed = true;
    assert.ok(closeReturned, "the synchronously self-closing handler's close() must resolve");
    assert.ok(
      !peerDispatched,
      "once a handler self-closed mid-batch, no further job in that batch may be dispatched onto the closing engine",
    );
    // Clean single free(): a later external close() is a memoized no-op.
    await engine.close();
  } finally {
    if (!closed) await engine.close();
  }
});

// Regression (PR #447 review, wasm-engine.ts:554): close() is idempotent. The shutdown run is
// memoized, so two concurrent close() calls (or a second after the first resolves) await the SAME
// run instead of each reaching `#engine.free()` — freeing the same WASM handle twice throws in
// wbindgen ("null pointer passed to rust"). Both concurrent calls, and a later sequential one, must
// resolve to that single free().
test("wasm: close() is idempotent and never double-frees the WASM handle (#447 review)", async () => {
  const engine = await createWasmEngineClient();
  const [a, b] = await Promise.allSettled([engine.close(), engine.close()]);
  assert.equal(a.status, "fulfilled", "first close() must succeed");
  assert.equal(
    b.status,
    "fulfilled",
    `a concurrent second close() must not double-free${b.status === "rejected" ? `: ${b.reason}` : ""}`,
  );
  // A later, sequential close() awaits the same memoized (successful) run — also a no-op.
  await engine.close();
});
// Regression (PR #447 review, wasm-engine.ts:535): the `#closeRun` memo must survive a rejection that
// happens *after* `#engine.free()`. `#doClose()` frees the handle and THEN calls `#throwInflightError()`,
// which throws when a tracked handler captured a late completion error (the scenario above). If close()
// cleared the memo on that post-free rejection, a second close() would re-enter `#doClose()` and
// `free()` the already-freed handle a second time — the "null pointer passed to rust" double-free the
// idempotence was meant to prevent. A second close() must instead await the SAME memoized (rejected)
// run and surface the same error, never re-free.
test("wasm: close() stays memoized after free() so a post-free failure never double-frees (#447 review)", async () => {
  const engine = await createWasmEngineClient();
  const realSetTimeout = globalThis.setTimeout;
  const macrotask = () => new Promise<void>((r) => realSetTimeout(r, 0));
  let releaseGate = () => {};
  const gate = new Promise<void>((r) => {
    releaseGate = r;
  });
  await engine.registerWorker("late", async () => {
    await gate;
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
             xmlns:bpmndi="http://www.omg.org/spec/BPMN/20100524/DI"
             xmlns:dc="http://www.omg.org/spec/DD/20100524/DC"
             xmlns:di="http://www.omg.org/spec/DD/20100524/DI"
             xmlns:zeebe="http://camunda.org/schema/zeebe/1.0"
             targetNamespace="http://nanobpm/testkit">
  <process id="late" isExecutable="true">
    <startEvent id="s"/><sequenceFlow id="f" sourceRef="s" targetRef="t"/>
    <serviceTask id="t"><extensionElements><zeebe:taskDefinition type="late"/></extensionElements></serviceTask>
    <sequenceFlow id="f2" sourceRef="t" targetRef="e"/><endEvent id="e"/>
  </process>
  <bpmndi:BPMNDiagram id="diagram">
    <bpmndi:BPMNPlane id="plane" bpmnElement="late">
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

  let settled = false;
  try {
    await engine.createInstance({ processDefinitionId: "late" });
    releaseGate();
    await macrotask();
    await macrotask();

    // First close() frees the engine, then surfaces the late in-flight failure (rejects *after* free()).
    await assert.rejects(engine.close(), /late-completion-boom/, "first close() surfaces the late failure");
    // Second close() must await the same memoized run and reject with the same error — NOT re-run
    // `#doClose()` and re-`free()` the handle (which would reject with wbindgen's "null pointer passed to
    // rust" double-free fault instead).
    await assert.rejects(engine.close(), (err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      assert.match(message, /late-completion-boom/, "second close() must surface the memoized error");
      assert.doesNotMatch(message, /null pointer passed to rust/, "second close() must not double-free");
      return true;
    });
    settled = true;
  } finally {
    // The engine allocates native WASM memory. Release the gate so a parked handler unwinds, then — only
    // if an assertion above threw before the close() assertions freed the handle — run a fallback close()
    // to release it, so a failing case does not leak the native handle into the rest of the suite.
    // Swallow its result: close() is memoized and (in this scenario) rejects with the late failure, and
    // cleanup must never mask the real assertion error. On the success path free() already ran, so this
    // is skipped entirely.
    releaseGate();
    if (!settled) await engine.close().catch(() => {});
  }
});

// Regression (PR #447 review, wasm-engine.ts:559): `close()` publishes its memoized shutdown run BEFORE
// invoking `#doClose()`. `#doClose()` synchronously aborts `#shutdown`, and `shutdownSignal` is PUBLIC,
// so an abort listener can call `close()` again DURING that dispatch. The old `this.#closeRun ??=
// this.#doClose()` evaluated `#doClose()` (aborting, dispatching the listener) BEFORE `??=` stored the
// promise, so the re-entrant call saw an unset memo, started a SECOND `#doClose()`, and both reached
// `free()` — the wbindgen "null pointer passed to rust" double-free. The re-entrant close() must instead
// observe the in-progress run and await it.
test("wasm: a shutdownSignal abort listener that re-enters close() must not double-free (#447 review)", async () => {
  const engine = await createWasmEngineClient();
  let reentrant: Promise<void> | undefined;
  engine.shutdownSignal.addEventListener("abort", () => {
    reentrant = engine.close();
  });
  await assert.doesNotReject(
    engine.close(),
    "close() must not double-free when re-entered from a synchronous shutdownSignal abort listener",
  );
  await assert.doesNotReject(
    reentrant ?? Promise.reject(new Error("the abort listener never re-entered close()")),
    "the re-entrant close() must await the same memoized run, not start a second teardown that re-frees",
  );
});

// The snapshot-derivation helpers behind `searchElementInstances` /
// `searchElementInstanceWaitStates` are pure functions over an untyped `JSON.parse`d snapshot,
// so a malformed/changed snapshot (a non-array collection, `null`/non-object rows, a keyless
// element, a park whose element is no longer active) must drop the bad row rather than throw or
// leak a garbage key. Unit-tested directly with crafted snapshots; the shared contract covers the
// live end-to-end path against a real engine.
test("deriveElementInstances: maps active elements, applies selectors, drops malformed rows", () => {
  const snapshot = JSON.parse(JSON.stringify({
    instances: [
      {
        key: "3",
        activeElements: [
          { elementId: "work", key: "5" },
          { elementId: "gw", key: "6" },
          { elementId: "keyless" }, // no key → dropped
          { key: "7" }, // no elementId → dropped
          "not-an-object", // non-object row → dropped
        ],
      },
      { key: "4", activeElements: [{ elementId: "other", key: "8" }] },
      { activeElements: [{ elementId: "orphan", key: "9" }] }, // no instance key → dropped
    ],
  }));

  assert.deepEqual(deriveElementInstances(snapshot), [
    { elementInstanceKey: "5", processInstanceKey: "3", elementId: "work", state: "ACTIVE" },
    { elementInstanceKey: "6", processInstanceKey: "3", elementId: "gw", state: "ACTIVE" },
    { elementInstanceKey: "8", processInstanceKey: "4", elementId: "other", state: "ACTIVE" },
  ]);
  // Selectors narrow, and a non-ACTIVE state the snapshot can't serve yields nothing.
  assert.deepEqual(
    deriveElementInstances(snapshot, { processInstanceKey: "3", elementId: "work" }),
    [{ elementInstanceKey: "5", processInstanceKey: "3", elementId: "work", state: "ACTIVE" }],
  );
  assert.deepEqual(deriveElementInstances(snapshot, { state: "COMPLETED" }), []);
});

test("deriveWaitStates: synthesizes the deployed floor (JOB|MESSAGE|USER_TASK), dropping out-of-floor parks", () => {
  const snapshot = JSON.parse(JSON.stringify({
    instances: [{
      key: "3",
      activeElements: [
        { elementId: "svc", key: "5" },
        { elementId: "catch", key: "6" },
        { elementId: "review", key: "7" },
        { elementId: "tmr", key: "8" },
        { elementId: "sig", key: "9" },
      ],
    }],
    jobs: [
      { elementId: "svc", instanceKey: "3", jobType: "work", key: "50" },
      { elementId: "gone", instanceKey: "3", jobType: "x", key: "51" }, // element not active → dropped
    ],
    messageSubscriptions: [{ elementId: "catch", instanceKey: "3", messageName: "Go", correlationKey: "K1", key: "60" }],
    // USER_TASK parks are on the floor since Magikcraft/nano-bpm#1042 shipped them, so an OPEN
    // (`Created`) task IS synthesized; a retained COMPLETED task must NOT be (the park is removed
    // on completion). TIMER/SIGNAL parks are present in the snapshot but remain outside the floor
    // (the 8.10 follow-on), so `deriveWaitStates` must NOT synthesize them — the emulation cannot
    // report a park a live engine would omit (issue nanobpm/nano-ide#498, #497).
    timers: [{ elementId: "tmr", instanceKey: "3", key: "70" }],
    signalSubscriptions: [{ elementId: "sig", instanceKey: "3", signalName: "Sig", key: "80" }],
    userTasks: [
      { elementId: "review", instanceKey: "3", elementInstanceKey: "7", key: "90", state: "Created" },
      { elementId: "done", instanceKey: "3", elementInstanceKey: "99", key: "91", state: "Completed" }, // closed → no park
    ],
  }));

  const all = deriveWaitStates(snapshot);
  assert.deepEqual(all, [
    { elementInstanceKey: "5", processInstanceKey: "3", elementId: "svc", waitStateType: "JOB", jobType: "work", jobKey: "50" },
    { elementInstanceKey: "6", processInstanceKey: "3", elementId: "catch", waitStateType: "MESSAGE", messageName: "Go", correlationKey: "K1" },
    { elementInstanceKey: "7", processInstanceKey: "3", elementId: "review", waitStateType: "USER_TASK", userTaskKey: "90" },
  ]);
  // Selectors narrow by kind and by element (within the floor).
  assert.deepEqual(deriveWaitStates(snapshot, { waitStateType: "JOB" }).map((w) => w.elementId), ["svc"]);
  assert.deepEqual(deriveWaitStates(snapshot, { elementId: "catch" }).map((w) => w.waitStateType), ["MESSAGE"]);
  // A USER_TASK filter is now served (on the floor), narrowing to the user-task park.
  assert.deepEqual(
    deriveWaitStates(snapshot, { waitStateType: "USER_TASK" }),
    [{ elementInstanceKey: "7", processInstanceKey: "3", elementId: "review", waitStateType: "USER_TASK", userTaskKey: "90" }],
  );
  // A `waitStateType` filter still outside the floor is rejected exactly as the gateway 422s
  // it, rather than silently emulated — so an app authoring it cannot ship green.
  assert.throws(
    () => deriveWaitStates(snapshot, { waitStateType: "TIMER" }),
    /unsupported waitStateType/,
  );
  assert.throws(
    () => deriveWaitStates(snapshot, { waitStateType: "SIGNAL" }),
    /SIGNAL/,
  );
});

test("deriveWaitStates: a multi-instance elementId is an ambiguous park join and is dropped, not mis-keyed", () => {
  const snapshot = JSON.parse(JSON.stringify({
    instances: [{
      key: "3",
      activeElements: [
        { elementId: "mi", key: "10" }, // two active tokens of the SAME element (multi-instance)
        { elementId: "mi", key: "11" },
        { elementId: "solo", key: "12" },
      ],
    }],
    // One job row for the ambiguous element and one for the unambiguous element.
    jobs: [
      { elementId: "mi", instanceKey: "3", jobType: "work", key: "50" },
      { elementId: "solo", instanceKey: "3", jobType: "work", key: "51" },
    ],
  }));

  // Both element instances still surface (deriveElementInstances emits each active token)...
  assert.deepEqual(
    deriveElementInstances(snapshot).map((e) => e.elementInstanceKey).sort(),
    ["10", "11", "12"],
  );
  // ...but the JOB park on the ambiguous `mi` element can't be paired to a single token from
  // the snapshot, so it is dropped rather than joined to an arbitrary (wrong) key. Only the
  // unambiguous `solo` park survives.
  assert.deepEqual(deriveWaitStates(snapshot), [
    { elementInstanceKey: "12", processInstanceKey: "3", elementId: "solo", waitStateType: "JOB", jobType: "work", jobKey: "51" },
  ]);
});
