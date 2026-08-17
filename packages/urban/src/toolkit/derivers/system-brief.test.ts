import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildSystemBrief,
  deriveSystemBrief,
  emitSystemBriefMd,
  foldOwnership,
  scanModelDecisions,
  SYSTEM_BRIEF_JSON,
  SYSTEM_BRIEF_MD,
  type SystemBrief,
} from "./system-brief.ts";
import type { ModelSource } from "./worker-io.ts";

// A model with a service task (worker), a business-rule task (decision), and ownership
// `nano:meta` (single-valued + two repeated `adr`s).
const ORDER_XML = `
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"
  xmlns:zeebe="http://camunda.org/schema/zeebe/1.0">
  <bpmn:process id="order-fulfilment">
    <bpmn:extensionElements>
      <nano:meta xmlns:nano="urn:nano" key="owner" value="payments-team" />
      <nano:meta xmlns:nano="urn:nano" key="slack" value="#payments" />
      <nano:meta xmlns:nano="urn:nano" key="adr" value="ADR 0040" />
      <nano:meta xmlns:nano="urn:nano" key="adr" value="ADR 0060" />
    </bpmn:extensionElements>
    <bpmn:serviceTask id="charge">
      <bpmn:extensionElements>
        <zeebe:taskDefinition type="charge-card" />
        <zeebe:ioMapping>
          <zeebe:property name="io.nanobpm.dataEnvelope.in" value="io.acme.ChargeReq" />
          <zeebe:property name="io.nanobpm.dataEnvelope.out" value="io.acme.ChargeRes" />
        </zeebe:ioMapping>
      </bpmn:extensionElements>
    </bpmn:serviceTask>
    <bpmn:businessRuleTask id="risk">
      <bpmn:extensionElements>
        <zeebe:calledDecision decisionId="fraud-score" resultVariable="score" />
      </bpmn:extensionElements>
    </bpmn:businessRuleTask>
  </bpmn:process>
</bpmn:definitions>`;

const models: ModelSource[] = [{ path: "order.bpmn", xml: ORDER_XML }];

test("scanModelDecisions extracts businessRuleTask → calledDecision", () => {
  const decisions = scanModelDecisions(ORDER_XML);
  assert.deepEqual(decisions, [
    { process: "order-fulfilment", elementId: "risk", decisionId: "fraud-score" },
  ]);
});

test("foldOwnership folds reserved meta keys, accumulating repeated `adr`", () => {
  const own = foldOwnership(models);
  assert.equal(own.owner, "payments-team");
  assert.equal(own.slack, "#payments");
  assert.deepEqual(own.adrs, ["ADR 0040", "ADR 0060"]);
  assert.equal(own.team, undefined);
});

test("buildSystemBrief folds processes, call graph, decisions, ownership", () => {
  const b: SystemBrief = buildSystemBrief(models, "acme-orders");
  assert.equal(b.app, "acme-orders");
  assert.deepEqual(b.processes, ["order-fulfilment"]);
  assert.equal(b.workers.length, 1);
  assert.equal(b.workers[0].taskType, "charge-card");
  assert.equal(b.workers[0].in, "io.acme.ChargeReq");
  assert.equal(b.decisions[0].decisionId, "fraud-score");
  assert.equal(b.ownership.owner, "payments-team");
});

test("emitSystemBriefMd renders owner, call graph, and decisions", () => {
  const md = emitSystemBriefMd(buildSystemBrief(models, "acme-orders"));
  assert.match(md, /# acme-orders — system brief/);
  assert.match(md, /payments-team/);
  assert.match(md, /ADR 0040, ADR 0060/);
  assert.match(md, /charge-card/);
  assert.match(md, /fraud-score/);
});

test("emitSystemBriefMd degrades gracefully with no ownership meta", () => {
  const bare = `<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL">
    <bpmn:process id="p1"></bpmn:process></bpmn:definitions>`;
  const md = emitSystemBriefMd(buildSystemBrief([{ path: "p.bpmn", xml: bare }]));
  assert.match(md, /No ownership metadata declared/);
  assert.match(md, /## Processes/);
});

test("deriveSystemBrief emits both artifacts with valid JSON", () => {
  const arts = deriveSystemBrief(models, "acme-orders");
  const md = arts.find((a) => a.path.endsWith(SYSTEM_BRIEF_MD));
  const json = arts.find((a) => a.path.endsWith(SYSTEM_BRIEF_JSON));
  assert.ok(md && json);
  const parsed = JSON.parse(json!.content);
  assert.equal(parsed.app, "acme-orders");
  assert.equal(parsed.workers[0].taskType, "charge-card");
});
