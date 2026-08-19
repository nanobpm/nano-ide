// Self-tests for the derivation-parity harness (the oracle S1–S6 assert against).
// These need no gateway for the parity checks; `deploySmoke` runs only when a
// gateway binary is available (mirroring the integration tests' skip). Run
// against the built `dist` artifacts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { defineFlow } from "../dist/index.js";
import { WorkflowClient } from "../dist/index.js";
import {
  normalize,
  diffModels,
  modelsEqual,
  assertDerivationParity,
  deploySmoke,
  parseXml,
  isFlowBuilder,
  assemblyFailureMessage,
} from "../dist/test-support/index.js";
import { Gateway, resolveServerBin } from "./server.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const NWF = join(HERE, "fixtures", "nwf");
const DERIVED = join(HERE, "fixtures", "derived");
const nwf = (name: string): string => readFileSync(join(NWF, `${name}.bpmn`), "utf8");

// Consistently rename every id and every reference to it (and the `incoming`/
// `outgoing` flow-id back-references), so the model is unchanged but the XML
// looks entirely different — proof the normalizer is id-agnostic.
function renameIds(xml: string, prefix: string): string {
  const refAttrs = ["id", "sourceRef", "targetRef", "attachedToRef", "default", "messageRef", "errorRef", "signalRef", "escalationRef"];
  const re = new RegExp(`\\b(${refAttrs.join("|")})="([^"]*)"`, "g");
  return xml
    .replace(re, (_m, a: string, v: string) => `${a}="${prefix}${v}"`)
    .replace(/(<bpmn:(?:incoming|outgoing)>)([^<]*)(<\/bpmn:(?:incoming|outgoing)>)/g, (_m, o, v, c) => `${o}${prefix}${v}${c}`);
}

// A small flow exercising several node kinds (run/task/switch/signal/timer) —
// its derivation is asserted against a checked-in golden, and it is the model
// deploySmoke tries to deploy.
const smokeFlow = defineFlow("smoke-demo", (w) => {
  w.run("prepare", async () => ({}));
  w.task("external-sign");
  w.switch("status", {
    ok: (c) => {
      c.run("finish", async () => ({}));
    },
    default: (c) => {
      c.signal("await-fix", { correlationKey: "caseId" });
    },
  });
  w.timer("cooldown", { after: "PT5M" });
});

test("parseXml: rejects malformed documents instead of silently accepting them", () => {
  // Mismatched end tag: `<a><b></a>` must not be silently accepted as a tree.
  assert.throws(() => parseXml("<a><b></a></a>"), /mismatched end tag/);
  // Unclosed tag: the document ends with `<b>` still open.
  assert.throws(() => parseXml("<a><b></b>"), /unclosed tag/);
  // Stray end tag with nothing open.
  assert.throws(() => parseXml("</a>"), /unbalanced end tag/);
  // Multiple top-level roots: a well-formed document has exactly one root.
  assert.throws(() => parseXml("<a/><b/>"), /multiple root elements/);
  // A well-formed document still parses.
  const el = parseXml("<a><b/></a>");
  assert.equal(el.name, "a");
  assert.equal(el.children.length, 1);
  assert.equal(el.children[0].name, "b");
});

test("isFlowBuilder: fails fast when a core built-in method is missing (tree-shaken registration)", () => {
  // Every built-in method present + all-functions → a valid builder.
  const complete = {
    startOn: () => {},
    run: () => {},
    task: () => {},
    signal: () => {},
    timer: () => {},
    switch: () => {},
    branch: () => {},
    loop: () => {},
    parallel: () => {},
    forEach: () => {},
    break: () => {},
    continue: () => {},
  };
  assert.equal(isFlowBuilder(complete), true);

  // A builder missing a core method (e.g. `run` never registered because its
  // node-kind module was tree-shaken) previously passed the guard — every own
  // property was still a function — and only blew up later as an opaque
  // `w.run is not a function`. It must now be rejected at assembly time.
  const { run: _dropped, ...missingRun } = complete;
  void _dropped;
  assert.equal(isFlowBuilder(missingRun), false);
});

test("assemblyFailureMessage: names the missing built-in method(s) so the failure is actionable", () => {
  const complete = {
    startOn: () => {},
    run: () => {},
    task: () => {},
    signal: () => {},
    timer: () => {},
    switch: () => {},
    branch: () => {},
    loop: () => {},
    parallel: () => {},
    forEach: () => {},
    break: () => {},
    continue: () => {},
  };
  // A missing built-in (e.g. `run` + `task` tree-shaken away) must be NAMED in
  // the diagnostic — the generic "missing registered methods" alone gave no
  // clue which registration was dropped.
  const { run: _r, task: _t, ...missing } = complete;
  void _r;
  void _t;
  const msg = assemblyFailureMessage(missing);
  assert.match(msg, /missing registered methods:/);
  assert.match(msg, /run/);
  assert.match(msg, /task/);
  // When every built-in is present, no missing-method list is appended.
  assert.equal(assemblyFailureMessage(complete), "internal: assembled FlowBuilder failed its assembly invariant");
});

test("assemblyFailureMessage: names a non-function own-property when every built-in is present", () => {
  const complete = {
    startOn: () => {},
    run: () => {},
    task: () => {},
    signal: () => {},
    timer: () => {},
    switch: () => {},
    branch: () => {},
    loop: () => {},
    parallel: () => {},
    forEach: () => {},
    break: () => {},
    continue: () => {},
  };
  // Every built-in is present, but an own-property is not a function (e.g. a
  // stray descriptor/value leaked onto the assembled builder). The old
  // diagnostic still claimed "missing registered methods", which is misleading
  // when nothing is missing — it must now NAME the offending property instead.
  const withBadProp = { ...complete, oops: 42 };
  const msg = assemblyFailureMessage(withBadProp);
  assert.doesNotMatch(msg, /missing registered methods/);
  assert.match(msg, /non-function own-property:/);
  assert.match(msg, /oops/);
});

test("switch: rejects a non-object cases argument with a helpful message, not a raw TypeError", () => {
  // A JSON-derived / runtime-invalid `cases` (null) previously reached
  // `Object.entries(null)` and threw an opaque `TypeError: Cannot convert
  // undefined or null to object` out of the builder. It must now fail with a
  // clear switch(...) diagnostic (like `timer` guards its opts). JSON.parse
  // yields `any`, so no `as`-cast is needed to build the invalid input.
  const badCases = JSON.parse("null");
  assert.throws(
    () => defineFlow("bad-switch", (w) => { w.switch("status", badCases); }),
    /switch\("status"\) needs a cases object/,
  );
  // A valid cases object still assembles.
  assert.doesNotThrow(() =>
    defineFlow("ok-switch", (w) => {
      w.switch("status", {
        ok: (c) => {
          c.task("t");
        },
      });
    }),
  );
});

test("parseXml: out-of-range numeric character references are left verbatim, not thrown", () => {
  // `String.fromCodePoint` throws a RangeError for code points > 0x10FFFF; the
  // reader must treat such a reference as malformed and leave it as-is rather
  // than surfacing an opaque exception out of parseXml.
  assert.doesNotThrow(() => parseXml('<a v="&#x110000;"/>'));
  assert.equal(parseXml('<a v="&#x110000;"/>').attrs.v, "&#x110000;");
  // A negative / non-scalar decimal reference is likewise left verbatim.
  assert.equal(parseXml('<a v="&#1114112;"/>').attrs.v, "&#1114112;");
  // Surrogate halves are not valid characters → left verbatim.
  assert.equal(parseXml('<a v="&#xD800;"/>').attrs.v, "&#xD800;");
  // A valid scalar value still decodes (BMP + astral).
  assert.equal(parseXml('<a v="&#x41;"/>').attrs.v, "A");
  assert.equal(parseXml('<a v="&#128512;"/>').attrs.v, "\u{1f600}");
});

test("normalize: sees through element-id renaming (canonicalizes ids + sequence-flow ids)", () => {
  const golden = nwf("feature");
  assert.ok(modelsEqual(normalize(golden), normalize(renameIds(golden, "x_"))));
});

test("normalize: strips DI layout so its presence/absence does not change the model", () => {
  const golden = nwf("convergence-loop");
  const withoutDI = golden.replace(/<bpmndi:BPMNDiagram[\s\S]*?<\/bpmndi:BPMNDiagram>/g, "");
  assert.notEqual(withoutDI, golden, "fixture should contain a DI block to strip");
  assert.ok(modelsEqual(normalize(golden), normalize(withoutDI)));
});

test("normalize: is invariant to child ORDER (compares as a multiset)", () => {
  const a = `<?xml version="1.0"?>
    <bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL">
      <bpmn:process id="p" isExecutable="true">
        <bpmn:startEvent id="s"><bpmn:outgoing>e1</bpmn:outgoing></bpmn:startEvent>
        <bpmn:task id="a"><bpmn:incoming>e1</bpmn:incoming><bpmn:outgoing>e2</bpmn:outgoing></bpmn:task>
        <bpmn:endEvent id="z"><bpmn:incoming>e2</bpmn:incoming></bpmn:endEvent>
        <bpmn:sequenceFlow id="e1" sourceRef="s" targetRef="a"/>
        <bpmn:sequenceFlow id="e2" sourceRef="a" targetRef="z"/>
      </bpmn:process>
    </bpmn:definitions>`;
  const b = `<?xml version="1.0"?>
    <bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL">
      <bpmn:process id="p" isExecutable="true">
        <bpmn:sequenceFlow id="e2" sourceRef="a" targetRef="z"/>
        <bpmn:endEvent id="z"><bpmn:incoming>e2</bpmn:incoming></bpmn:endEvent>
        <bpmn:sequenceFlow id="e1" sourceRef="s" targetRef="a"/>
        <bpmn:task id="a"><bpmn:outgoing>e2</bpmn:outgoing><bpmn:incoming>e1</bpmn:incoming></bpmn:task>
        <bpmn:startEvent id="s"><bpmn:outgoing>e1</bpmn:outgoing></bpmn:startEvent>
      </bpmn:process>
    </bpmn:definitions>`;
  assert.ok(modelsEqual(normalize(a), normalize(b)));
});

test("normalize: a message's correlationKey and envelope are part of its identity", () => {
  // Two models identical except for the subscription's correlationKey (and, in
  // the third, an envelope property) must NOT compare equal — the parity oracle
  // has to catch a wrong-correlationKey / wrong-envelope derivation, not just a
  // wrong message NAME. Guards the defect class where a signal step emits a
  // message subscription whose semantics the oracle used to drop.
  const model = (corr: string, prop = ""): string => `<?xml version="1.0"?>
    <bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"
                      xmlns:zeebe="http://camunda.org/schema/zeebe/1.0">
      <bpmn:process id="p" isExecutable="true">
        <bpmn:startEvent id="s"><bpmn:outgoing>e1</bpmn:outgoing></bpmn:startEvent>
        <bpmn:intermediateCatchEvent id="c">
          <bpmn:incoming>e1</bpmn:incoming>
          <bpmn:messageEventDefinition messageRef="m"/>
        </bpmn:intermediateCatchEvent>
        <bpmn:sequenceFlow id="e1" sourceRef="s" targetRef="c"/>
      </bpmn:process>
      <bpmn:message id="m" name="await">
        <bpmn:extensionElements>
          <zeebe:subscription correlationKey="=${corr}"/>${prop}
        </bpmn:extensionElements>
      </bpmn:message>
    </bpmn:definitions>`;

  // Same name, same key, same envelope -> equal (identity is stable).
  assert.ok(modelsEqual(normalize(model("caseId")), normalize(model("caseId"))));

  // Differing correlationKey -> NOT equal, and the diff names the section.
  assert.ok(!modelsEqual(normalize(model("caseId")), normalize(model("orderId"))));
  assert.match(diffModels(normalize(model("caseId")), normalize(model("orderId"))), /message subscriptions:/);

  // Differing envelope property (zeebe:properties) -> NOT equal.
  const prop = `\n          <zeebe:properties><zeebe:property name="in" value="Envelope"/></zeebe:properties>`;
  assert.ok(!modelsEqual(normalize(model("caseId")), normalize(model("caseId", prop))));
});

test("parity: a matching pair passes and a deliberately mismatched pair reports a legible diff", () => {
  // Matching: a golden equals its id-renamed self.
  const golden = nwf("feature");
  assert.equal(diffModels(normalize(golden), normalize(renameIds(golden, "m_"))), "");

  // Mismatched: two different goldens differ, with a red/green structural diff.
  const diff = diffModels(normalize(nwf("feature")), normalize(nwf("retro")));
  assert.ok(diff.length > 0, "different goldens must produce a non-empty diff");
  assert.match(diff, /flow nodes:/);
  assert.match(diff, /^\s*-\s/m, "diff must mark golden-only lines with -");
  assert.match(diff, /^\s*\+\s/m, "diff must mark derived-only lines with +");
});

test("assertDerivationParity: a derived flow matches its checked-in golden", () => {
  // The golden is an id-renamed, DI-augmented copy of the derived output — so
  // this exercises the full derive → normalize → structural-compare path, not a
  // trivial string equality.
  assertDerivationParity(smokeFlow, join(DERIVED, "smoke-demo.bpmn"));
});

test("assertDerivationParity: throws a legible diff when the derived flow does NOT match the golden", () => {
  assert.throws(
    () => assertDerivationParity(nwf("retro"), join(NWF, "feature.bpmn")),
    (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.match(err.message, /derivation parity failed/);
      assert.match(err.message, /structural mismatch/);
      return true;
    },
  );
});

test("deploySmoke: skips cleanly when no engine is reachable", async () => {
  const prev = process.env.WORKFLOW_GATEWAY_URL;
  delete process.env.WORKFLOW_GATEWAY_URL;
  try {
    const res = await deploySmoke(smokeFlow);
    assert.equal(res.skipped, true);
    assert.equal(res.deployed, false);
  } finally {
    if (prev !== undefined) process.env.WORKFLOW_GATEWAY_URL = prev;
  }
});

// An engine that answers with an empty object (e.g. an SDK response whose only
// fields are non-JSON and get dropped by toJsonObject) is NOT an acceptance —
// deploySmoke's error message literally calls this the "empty deploy result"
// case, so the guard must reject `{}`, not just a non-object.
function stubClient(deployResult: unknown): WorkflowClient {
  return new WorkflowClient({
    client: {
      async createDeployment() {
        return deployResult;
      },
      async createProcessInstance() {
        return {};
      },
      async correlateMessage() {
        return {};
      },
      async getProcessInstance() {
        return {};
      },
      createJobWorker() {
        return { start() {}, stop() {} };
      },
    },
  });
}

test("deploySmoke: rejects an empty deploy result ({}) instead of reporting acceptance", async () => {
  await assert.rejects(
    () => deploySmoke(smokeFlow, { client: stubClient({}) }),
    (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.match(err.message, /empty deploy result/);
      assert.match(err.message, /smoke-demo/);
      return true;
    },
  );
});

test("deploySmoke: accepts a non-empty deploy result", async () => {
  const res = await deploySmoke(smokeFlow, { client: stubClient({ deploymentKey: "1" }) });
  assert.equal(res.deployed, true);
  assert.equal(res.skipped, false);
  assert.deepEqual(res.result, { deploymentKey: "1" });
});

const hasBin = resolveServerBin();
const skip = hasBin ? false : "no gateway binary built (set SERVER_BIN or `make debug`)";

test("deploySmoke: deploys a derived model to a live engine and asserts acceptance", { skip }, async () => {
  const scratch = join(HERE, `.smoke-${process.pid}`);
  const gw = await Gateway.create(scratch);
  try {
    const res = await deploySmoke(smokeFlow, { baseUrl: gw.baseUrl, transport: "rest" });
    assert.equal(res.skipped, false);
    assert.equal(res.deployed, true);
    assert.ok(res.result && typeof res.result === "object");
  } finally {
    await gw.stop();
  }
});
