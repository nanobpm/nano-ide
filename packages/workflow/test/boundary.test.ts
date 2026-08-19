// Tests for the `boundary` flow-node kind (S2/#317): an activity-level attached
// interrupting timer boundary event (an SLA) with an `onTimeout` escalation body.
// Run against the built `dist` artifacts (like the other harness-based tests).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { defineFlow, declarativeToBpmn } from "../dist/index.js";
import { normalize, assertDerivationParity } from "../dist/test-support/index.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const NWF = join(HERE, "fixtures", "nwf");
const DERIVED = join(HERE, "fixtures", "derived");
const nwf = (name) => readFileSync(join(NWF, `${name}.bpmn`), "utf8");

// The boundary event's id-agnostic semantic descriptor (its type + timer
// definition + cancelActivity + edge-degree signature), extracted from a
// normalized model. A boundary is unique per model here, so `find` is exact.
const boundaryNode = (model) => model.nodes.find((n) => n.startsWith("boundaryEvent"));
const attachFlow = (model) => model.flows.find((f) => f.includes("--attach-->"));

test("boundary: derives an attached interrupting timer boundary event matching feature.bpmn's SLA", () => {
  // Reproduce the boundary shape feature.bpmn attaches to `feature-escalation`
  // (a FEEL-expression `=escalationSlaTimeout` interrupting timer) and assert the
  // derived boundary event is STRUCTURALLY IDENTICAL to the golden's — same
  // timer definition, same interrupting (cancelActivity omitted) marker, same
  // edge-degree (no incoming, one outgoing, attached to a host).
  const flow = defineFlow("f", (w) => {
    w.run("feature-escalation", async () => ({}));
    w.boundary({ timer: "=escalationSlaTimeout", name: "SLA elapsed", onTimeout: (b) => { b.task("record-feature"); } });
    w.task("after");
  });
  const derived = normalize(declarativeToBpmn(flow));
  const golden = normalize(nwf("feature"));
  assert.equal(boundaryNode(derived), boundaryNode(golden), "derived boundary event must match feature.bpmn's SLA");
  assert.ok(boundaryNode(derived).includes("timeDuration{xsi:type=bpmn:tFormalExpression}==escalationSlaTimeout"));
});

test("boundary: matches plan-fanout.bpmn and readiness-gate.bpmn boundary shapes", () => {
  // plan-fanout's SLA is the same FEEL-timer interrupting shape as feature's.
  const planFlow = defineFlow("p", (w) => {
    w.run("plan-review-decision", async () => ({}));
    w.boundary({ timer: "=escalationSlaTimeout", name: "SLA elapsed", onTimeout: (b) => { b.task("record-plan-sla"); } });
    w.task("after");
  });
  assert.equal(boundaryNode(normalize(declarativeToBpmn(planFlow))), boundaryNode(normalize(nwf("plan-fanout"))));

  // readiness-gate's boundary uses a different FEEL timer (`=probeTimeout`).
  const gateFlow = defineFlow("g", (w) => {
    w.run("probe", async () => ({}));
    w.boundary({ timer: "=probeTimeout", name: "Gate timed out", onTimeout: (b) => { b.task("probe-timeout"); } });
    w.task("after");
  });
  assert.equal(boundaryNode(normalize(declarativeToBpmn(gateFlow))), boundaryNode(normalize(nwf("readiness-gate"))));
});

test("boundary: a FEEL-expression timeDuration renders an xsi:type formal expression", () => {
  const flow = defineFlow("feel", (w) => {
    w.task("act");
    w.boundary({ timer: "=agentSlaTimeout", onTimeout: (b) => { b.task("esc"); } });
  });
  const xml = declarativeToBpmn(flow);
  assert.match(xml, /<bpmn:timeDuration xsi:type="bpmn:tFormalExpression">=agentSlaTimeout<\/bpmn:timeDuration>/);
});

test("boundary: a literal ISO-8601 timeDuration renders without a formal-expression marker", () => {
  const flow = defineFlow("iso", (w) => {
    w.task("act");
    w.boundary({ timer: "PT24H", onTimeout: (b) => { b.task("esc"); } });
  });
  const xml = declarativeToBpmn(flow);
  assert.match(xml, /<bpmn:timeDuration>PT24H<\/bpmn:timeDuration>/);
  assert.doesNotMatch(xml, /PT24H<\/bpmn:timeDuration>[\s\S]*xsi:type/);
});

test("boundary: interrupting (default) omits cancelActivity; non-interrupting is explicit", () => {
  const interrupting = declarativeToBpmn(
    defineFlow("i", (w) => {
      w.task("act");
      w.boundary({ timer: "PT1H", onTimeout: (b) => { b.task("esc"); } });
    }),
  );
  assert.match(interrupting, /<bpmn:boundaryEvent[^>]*attachedToRef="act">/);
  assert.doesNotMatch(interrupting, /cancelActivity/);

  const nonInterrupting = declarativeToBpmn(
    defineFlow("n", (w) => {
      w.task("act");
      w.boundary({ timer: "PT1H", interrupting: false, onTimeout: (b) => { b.task("esc"); } });
    }),
  );
  assert.match(nonInterrupting, /<bpmn:boundaryEvent[^>]*attachedToRef="act" cancelActivity="false">/);
});

test("boundary: attaches to the PRECEDING activity's derived element id", () => {
  const flow = defineFlow("a", (w) => {
    w.task("await-decision");
    w.boundary({ timer: "PT1H", onTimeout: (b) => { b.task("esc"); } });
  });
  const model = normalize(declarativeToBpmn(flow));
  const attach = attachFlow(model);
  assert.ok(attach, "a boundary must produce an --attach--> edge to its host");
  // The host serviceTask hosts exactly one boundary and keeps its own out-edge.
  assert.match(attach, /hosts=1/);
});

test("boundary: the onTimeout body converges with the activity's normal continuation", () => {
  // After `act`, the normal path and the escalation body both reach `after`, so
  // `after` has two incoming sequence flows (in=2): a real join, not a dead end.
  const flow = defineFlow("c", (w) => {
    w.task("act");
    w.boundary({ timer: "PT1H", onTimeout: (b) => { b.task("record-timeout"); } });
    w.task("after");
  });
  const model = normalize(declarativeToBpmn(flow));
  const afterNode = model.nodes.find((n) => n.includes("taskDefinition{type=c:after}"));
  assert.ok(afterNode, "the post-boundary activity must exist");
  assert.match(afterNode, /in=2/);
  // The escalation activity is wired from the boundary event's outgoing flow.
  const escFromBoundary = model.flows.find(
    (f) => f.startsWith("boundaryEvent") && f.includes("=[]=>") && f.includes("record-timeout"),
  );
  assert.ok(escFromBoundary, "the boundary event's outgoing flow must feed the onTimeout body");
});

test("boundary: full derive → normalize → parity against a checked-in golden", () => {
  // Exercises the whole harness path (a boundary in a complete flow) against an
  // id-renamed, DI-independent golden copy of the derived output.
  const flow = defineFlow("boundary-demo", (w) => {
    w.run("prepare", async () => ({}));
    w.task("await-decision");
    w.boundary({ timer: "=escalationSlaTimeout", name: "SLA elapsed", interrupting: true, onTimeout: (b) => { b.task("record-timeout"); } });
    w.task("record-result");
  });
  assertDerivationParity(flow, join(DERIVED, "boundary-demo.bpmn"));
});

test("boundary: rejects invalid options with actionable messages", () => {
  assert.throws(
    () => defineFlow("e", (w) => { w.task("a"); w.boundary({ onTimeout: (b) => { b.task("x"); } }); }),
    /boundary\(\.\.\.\) needs a \{ timer \}/,
  );
  assert.throws(
    () => defineFlow("e", (w) => { w.task("a"); w.boundary({ timer: "nope", onTimeout: (b) => { b.task("x"); } }); }),
    /is not an ISO-8601 duration/,
  );
  assert.throws(
    () => defineFlow("e", (w) => { w.task("a"); w.boundary({ timer: "PT1H" }); }),
    /needs an \{ onTimeout \} escalation body/,
  );
  // A boundary with no preceding activity has nothing to attach to.
  assert.throws(
    () => defineFlow("e", (w) => { w.boundary({ timer: "PT1H", onTimeout: (b) => { b.task("x"); } }); }),
    /must follow the activity it attaches to/,
  );
  // A boundary after a structural node (no derived element id) is rejected.
  assert.throws(
    () =>
      defineFlow("e", (w) => {
        w.switch("s", { ok: (c) => { c.task("t"); } });
        w.boundary({ timer: "PT1H", onTimeout: (b) => { b.task("x"); } });
      }),
    /can only attach to a named activity/,
  );
});
