// Self-tests for the derivation-parity harness (the oracle S1–S6 assert against).
// These need no gateway for the parity checks; `deploySmoke` runs only when a
// gateway binary is available (mirroring the integration tests' skip). Run
// against the built `dist` artifacts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { defineFlow, declarativeToBpmn } from "../dist/index.js";
import {
  normalize,
  diffModels,
  modelsEqual,
  assertDerivationParity,
  deploySmoke,
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
