import assert from "node:assert/strict";
import { test } from "node:test";

import { distinctTaskTypes, scanTaskDefinitions } from "./taskdef.ts";

const MODEL = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"
                  xmlns:zeebe="http://camunda.org/schema/zeebe/1.0">
  <bpmn:process id="plan-fanout" isExecutable="true">
    <bpmn:serviceTask id="plan" name="Plan">
      <bpmn:extensionElements>
        <zeebe:taskDefinition type="planning.planner" retries="3" />
      </bpmn:extensionElements>
    </bpmn:serviceTask>
    <bpmn:serviceTask id="test" name="Test">
      <bpmn:extensionElements>
        <zeebe:taskDefinition type="qa.tester" />
      </bpmn:extensionElements>
    </bpmn:serviceTask>
    <bpmn:userTask id="approve" name="Approve" />
    <bpmn:serviceTask id="notype" name="No type">
      <bpmn:extensionElements />
    </bpmn:serviceTask>
  </bpmn:process>
</bpmn:definitions>`;

test("scans taskDefinition leaves with process and element provenance", () => {
  const leaves = scanTaskDefinitions(MODEL);
  assert.deepEqual(leaves, [
    { taskType: "planning.planner", process: "plan-fanout", elementId: "plan", agentic: false },
    { taskType: "qa.tester", process: "plan-fanout", elementId: "test", agentic: false },
  ]);
});

test("skips service tasks without a task definition", () => {
  const leaves = scanTaskDefinitions(MODEL);
  assert.ok(!leaves.some((l) => l.elementId === "notype"));
  assert.ok(!leaves.some((l) => l.elementId === "approve"));
});

test("tolerates attribute ordering (type before id on the task-definition)", () => {
  const xml = `<bpmn:definitions xmlns:bpmn="x" xmlns:zeebe="y">
    <bpmn:process id="proc">
      <bpmn:serviceTask id="t">
        <zeebe:taskDefinition retries="1" type="ci.runner" />
      </bpmn:serviceTask>
    </bpmn:process>
  </bpmn:definitions>`;
  const leaves = scanTaskDefinitions(xml);
  assert.equal(leaves.length, 1);
  assert.equal(leaves[0].taskType, "ci.runner");
});

test("returns an empty process id when none is present", () => {
  const xml = `<bpmn:definitions xmlns:bpmn="x" xmlns:zeebe="y">
    <bpmn:serviceTask id="t"><zeebe:taskDefinition type="decide" /></bpmn:serviceTask>
  </bpmn:definitions>`;
  const leaves = scanTaskDefinitions(xml);
  assert.equal(leaves[0].process, "");
});

test("tolerates whitespace around attribute equals signs (id / type / process id)", () => {
  const xml = `<bpmn:definitions xmlns:bpmn="x" xmlns:zeebe="y">
    <bpmn:process id = "spaced-proc">
      <bpmn:serviceTask id = "t">
        <zeebe:taskDefinition type = "ci.runner" retries="1" />
      </bpmn:serviceTask>
    </bpmn:process>
  </bpmn:definitions>`;
  const leaves = scanTaskDefinitions(xml);
  assert.deepEqual(leaves, [
    { taskType: "ci.runner", process: "spaced-proc", elementId: "t", agentic: false },
  ]);
});

test("distinctTaskTypes de-duplicates in first-occurrence order", () => {
  assert.deepEqual(
    distinctTaskTypes([
      { taskType: "b", process: "p", elementId: "1", agentic: false },
      { taskType: "a", process: "p", elementId: "2", agentic: false },
      { taskType: "b", process: "p", elementId: "3", agentic: false },
    ]),
    ["b", "a"],
  );
});

test("marks a leaf agentic when it carries a linkName=\"prompt\" linked resource", () => {
  const xml = `<bpmn:definitions xmlns:bpmn="x" xmlns:zeebe="y">
    <bpmn:process id="nwf-retro">
      <bpmn:serviceTask id="retro">
        <bpmn:extensionElements>
          <zeebe:taskDefinition type="senior:retro" />
          <zeebe:linkedResources>
            <zeebe:linkedResource resourceId="retro.md" bindingType="latest" resourceType="GenericScript" linkName="prompt" />
          </zeebe:linkedResources>
        </bpmn:extensionElements>
      </bpmn:serviceTask>
      <bpmn:serviceTask id="gather">
        <bpmn:extensionElements>
          <zeebe:taskDefinition type="pr.retro-gather" />
        </bpmn:extensionElements>
      </bpmn:serviceTask>
    </bpmn:process>
  </bpmn:definitions>`;
  const leaves = scanTaskDefinitions(xml);
  assert.deepEqual(leaves, [
    { taskType: "senior:retro", process: "nwf-retro", elementId: "retro", agentic: true },
    { taskType: "pr.retro-gather", process: "nwf-retro", elementId: "gather", agentic: false },
  ]);
});

test("prompt detection tolerates attribute ordering (linkName before resourceId)", () => {
  const xml = `<bpmn:definitions xmlns:bpmn="x" xmlns:zeebe="y">
    <bpmn:serviceTask id="t">
      <zeebe:taskDefinition type="senior:feature" />
      <zeebe:linkedResource linkName="prompt" resourceId="feature.md" />
    </bpmn:serviceTask>
  </bpmn:definitions>`;
  assert.equal(scanTaskDefinitions(xml)[0].agentic, true);
});

test("a non-prompt linked resource (other linkName) does not mark a leaf agentic", () => {
  const xml = `<bpmn:definitions xmlns:bpmn="x" xmlns:zeebe="y">
    <bpmn:serviceTask id="t">
      <zeebe:taskDefinition type="senior:feature" />
      <zeebe:linkedResource resourceId="schema.md" linkName="schema" />
    </bpmn:serviceTask>
  </bpmn:definitions>`;
  assert.equal(scanTaskDefinitions(xml)[0].agentic, false);
});
