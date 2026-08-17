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

test("emitSystemBriefMd escapes `|` and newlines in model-authored ownership cells", () => {
  const evil = `<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL">
    <bpmn:process id="p1">
      <bpmn:extensionElements>
        <nano:meta xmlns:nano="urn:nano" key="owner" value="a | b" />
      </bpmn:extensionElements>
    </bpmn:process></bpmn:definitions>`;
  const md = emitSystemBriefMd(buildSystemBrief([{ path: "p.bpmn", xml: evil }]));
  const ownerLine = md.split("\n").find((l) => l.startsWith("| Owner |"));
  assert.ok(ownerLine, "owner row rendered");
  // The literal `|` from the meta value must be escaped so it can't add a phantom column.
  assert.match(ownerLine!, /a \\\| b/);
});

test("processId only recognises `bpmn:process` (consistent with scanModelWorkers)", () => {
  // A non-`bpmn:`-prefixed process must not be listed, otherwise the brief would show a process
  // id while every worker/decision row carried an empty Process column.
  const other = `<definitions xmlns:foo="urn:foo">
    <foo:process id="not-bpmn"></foo:process></definitions>`;
  const b = buildSystemBrief([{ path: "o.bpmn", xml: other }]);
  assert.deepEqual(b.processes, []);
});

test("deriveSystemBrief emits both artifacts with valid JSON", () => {
  const arts = deriveSystemBrief(models, "acme-orders");
  const md = arts.find((a) => a.path.endsWith(SYSTEM_BRIEF_MD));
  const json = arts.find((a) => a.path.endsWith(SYSTEM_BRIEF_JSON));
  assert.ok(md && json);
  const parsed: unknown = JSON.parse(json!.content);
  assertSystemBriefShape(parsed);
  assert.equal(parsed.app, "acme-orders");
  assert.equal(parsed.workers[0].taskType, "charge-card");
});

/** Runtime-validate the parsed JSON shape (no `as` cast — banned in this repo) and narrow it to
 * `SystemBrief` for the assertions that follow. */
function assertSystemBriefShape(v: unknown): asserts v is SystemBrief {
  assert.ok(typeof v === "object" && v !== null, "brief is an object");
  assert.ok(!("app" in v) || typeof v.app === "string", "app is absent or a string");
  assert.ok("workers" in v && Array.isArray(v.workers), "workers is an array");
  assert.ok("processes" in v && Array.isArray(v.processes), "processes is an array");
  assert.ok("decisions" in v && Array.isArray(v.decisions), "decisions is an array");
  assert.ok("ownership" in v && typeof v.ownership === "object" && v.ownership !== null, "ownership is an object");
}
