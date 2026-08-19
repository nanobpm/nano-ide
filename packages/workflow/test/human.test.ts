// Tests for the `w.human` user-task builder (epic #314, S3/#318). Run against the
// built `dist` artifacts (like the other suites). The parity checks reuse the S0
// harness (`normalize` / `assertDerivationParity`); `deploySmoke` runs only when a
// gateway binary is available.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { defineFlow, declarativeToBpmn } from "../dist/index.js";
import type { HumanOptions } from "../dist/index.js";
import { normalize, assertDerivationParity } from "../dist/test-support/index.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const NWF = join(HERE, "fixtures", "nwf");
const DERIVED = join(HERE, "fixtures", "derived");
const nwf = (name: string): string => readFileSync(join(NWF, `${name}.bpmn`), "utf8");

// The id/degree-agnostic semantic definition of every `<bpmn:userTask>` in a
// model: its normalized node label with the edge-degree suffix (`<in=…>`)
// stripped, so it captures ONLY the user-task's semantic surface (its form,
// assignment, and io-mapping extension elements) independent of how it is wired
// into the surrounding graph. This is what a `w.human` slice must reproduce; the
// full-model wiring (multiple terminal end events, boundary hosts, gateways) is a
// separate concern owned by the model ports (S5).
function userTaskDefs(xml: string): string[] {
  return normalize(xml)
    .nodes.filter((n) => n.startsWith("userTask("))
    .map((n) => n.replace(/<in=.*$/, ""))
    .sort();
}

const userTask = (xml: string): string => {
  const m = xml.match(/<bpmn:userTask[\s\S]*?<\/bpmn:userTask>/);
  if (!m) throw new Error("no <bpmn:userTask> in derived model");
  return m[0];
};

const derive = (opts: HumanOptions): string =>
  declarativeToBpmn(defineFlow("h", (w) => {
    w.human("decide", opts);
  }));

// --- Emission: the four extension-element variants -------------------------

test("human: form-only derives a userTask with formDefinition + the zeebe:userTask marker", () => {
  const ut = userTask(derive({ form: "spine-demo" }));
  assert.match(ut, /<bpmn:userTask id="decide" name="decide">/);
  assert.match(ut, /<zeebe:formDefinition formId="spine-demo" \/>/);
  assert.match(ut, /<zeebe:userTask \/>/);
  // no assignment / io when not requested
  assert.doesNotMatch(ut, /assignmentDefinition/);
  assert.doesNotMatch(ut, /ioMapping/);
});

test("human: assignee derives a zeebe:assignmentDefinition with assignee (a FEEL expression is preserved)", () => {
  const ut = userTask(derive({ form: "f", assignee: "=escalationAssignee" }));
  assert.match(ut, /<zeebe:assignmentDefinition assignee="=escalationAssignee" \/>/);
  assert.doesNotMatch(ut, /candidateGroups=/);
});

test("human: candidateGroups derives a zeebe:assignmentDefinition with candidateGroups", () => {
  const ut = userTask(derive({ form: "f", candidateGroups: "operators" }));
  assert.match(ut, /<zeebe:assignmentDefinition candidateGroups="operators" \/>/);
  assert.doesNotMatch(ut, /assignee=/);
});

test("human: assignee AND candidateGroups derive a single assignmentDefinition carrying both", () => {
  const ut = userTask(derive({ form: "f", assignee: "=escalationAssignee", candidateGroups: "operators" }));
  assert.match(ut, /<zeebe:assignmentDefinition assignee="=escalationAssignee" candidateGroups="operators" \/>/);
});

test("human: io derives a zeebe:ioMapping with input and output mappings", () => {
  const ut = userTask(
    derive({
      form: "f",
      io: {
        input: [{ source: "=caseId", target: "case" }],
        output: [{ source: "=decision", target: "result" }],
      },
    }),
  );
  assert.match(ut, /<zeebe:ioMapping>/);
  assert.match(ut, /<zeebe:input source="=caseId" target="case" \/>/);
  assert.match(ut, /<zeebe:output source="=decision" target="result" \/>/);
});

test("human: an output-only ioMapping emits no <zeebe:input>", () => {
  const ut = userTask(derive({ form: "f", io: { output: [{ source: "=x", target: "y" }] } }));
  assert.match(ut, /<zeebe:output source="=x" target="y" \/>/);
  assert.doesNotMatch(ut, /<zeebe:input/);
});

test("human: XML metacharacters in a FEEL mapping are escaped", () => {
  const ut = userTask(derive({ form: "f", io: { output: [{ source: '=a < b and c = "x"', target: "r" }] } }));
  assert.match(ut, /source="=a &lt; b and c = &quot;x&quot;"/);
});

// --- Builder validation ----------------------------------------------------

test("human: rejects a missing/empty form", () => {
  assert.throws(() => defineFlow("h", (w) => { w.human("d", { form: "" }); }), /needs a non-empty \{ form \}/);
  const noForm = JSON.parse("{}");
  assert.throws(() => defineFlow("h", (w) => { w.human("d", noForm); }), /needs a non-empty \{ form \}/);
});

test("human: rejects a non-object options argument", () => {
  const bad = JSON.parse("null");
  assert.throws(() => defineFlow("h", (w) => { w.human("d", bad); }), /needs an options object/);
});

test("human: rejects a non-string assignee / candidateGroups and a malformed io entry", () => {
  const badAssignee = JSON.parse('{"form":"f","assignee":5}');
  assert.throws(() => defineFlow("h", (w) => { w.human("d", badAssignee); }), /\{ assignee \} must be a string/);
  const badGroups = JSON.parse('{"form":"f","candidateGroups":5}');
  assert.throws(() => defineFlow("h", (w) => { w.human("d", badGroups); }), /\{ candidateGroups \} must be a string/);
  const badIo = JSON.parse('{"form":"f","io":{"output":[{"source":"=x"}]}}');
  assert.throws(() => defineFlow("h", (w) => { w.human("d", badIo); }), /io\.output entries must be/);
});

test("human: rejects a duplicate step name (claims its name like every leaf)", () => {
  assert.throws(
    () => defineFlow("h", (w) => { w.human("d", { form: "f" }); w.human("d", { form: "g" }); }),
    /duplicate step name "d"/,
  );
});

// --- Derivation parity (the S0 oracle) -------------------------------------

test("assertDerivationParity: a pure-human flow (all four variants) matches its checked-in golden", () => {
  // The full derive → normalize → structural-compare path for `w.human`, against
  // an id-renamed, DI-augmented copy of the derived output (the S0 self-test
  // pattern) — not a trivial string equality.
  const flow = defineFlow("human-demo", (w) => {
    w.human("review-form-only", { form: "review-form" });
    w.human("assign-only", { form: "assign-form", assignee: "=owner" });
    w.human("group-only", { form: "group-form", candidateGroups: "reviewers" });
    w.human("assign-and-group", { form: "ag-form", assignee: "=escalationAssignee", candidateGroups: "operators" });
    w.human("with-io", {
      form: "io-form",
      io: { input: [{ source: "=caseId", target: "case" }], output: [{ source: "=decision", target: "result" }] },
    });
  });
  assertDerivationParity(flow, join(DERIVED, "human-demo.bpmn"));
});

test("parity: w.human reproduces the userTask surface of the vendored spine-demo golden", () => {
  // spine-demo's single user task is form-only (formId = the process id).
  const derived = declarativeToBpmn(defineFlow("spine-demo", (w) => { w.human("decide", { form: "spine-demo" }); }));
  assert.deepEqual(userTaskDefs(derived), userTaskDefs(nwf("spine-demo")));
});

test("parity: w.human reproduces the three approval-gate userTasks of the vendored plan-fanout golden", () => {
  // The plan-fanout approval gates: an assignment-only escalation, a trial-merge
  // decision, and a plan-review decision that also carries an ioMapping.
  const derived = declarativeToBpmn(
    defineFlow("plan-fanout", (w) => {
      w.human("plan-review-decision", {
        form: "plan-review-decision",
        assignee: "=escalationAssignee",
        candidateGroups: "operators",
        io: {
          output: [
            { source: "=(if planReviewEpoch = null then 0 else planReviewEpoch) + 1", target: "planReviewEpoch" },
            {
              source:
                '=(if planFindings = null then "" else planFindings) + (if (notes = null or notes = "") then "" else "\n\nHuman guidance:\n" + notes)',
              target: "planFindings",
            },
          ],
        },
      });
      w.human("feature-escalation", { form: "feature-escalation", assignee: "=escalationAssignee", candidateGroups: "operators" });
      w.human("trial-merge-decision", { form: "trial-merge-decision", assignee: "=escalationAssignee", candidateGroups: "operators" });
    }),
  );
  const golden = userTaskDefs(nwf("plan-fanout"));
  const actual = userTaskDefs(derived);
  // Every approval-gate user task in the golden is reproduced by w.human.
  for (const def of golden) assert.ok(actual.includes(def), `missing userTask surface: ${def}`);
});
