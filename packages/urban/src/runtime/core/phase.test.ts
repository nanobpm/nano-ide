import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildScopeIndex,
  derivePhase,
  deriveInstancePhases,
  furthestReached,
  rollupLineagePhase,
  SCOPE_CONTAINERS,
  type InstancePhase,
  type ProvenanceProgressRow,
} from "./phase.ts";
import { buildLineageTree, type LineageEdge } from "./lineage.ts";

// A representative model in the spirit of the issue's motivating `plan-fanout.bpmn`: a process
// with named subProcesses ("Plan", "Implement task") wrapping tasks, a flat task at process level,
// a nano:phase override (attribute form), and a zeebe:property override.
const MODEL = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" xmlns:zeebe="http://camunda.org/schema/zeebe/1.0" xmlns:nano="http://nanobpm.io/schema/1.0">
  <bpmn:process id="plan-fanout" name="Plan Fanout">
    <bpmn:startEvent id="start" name="Start" />
    <bpmn:subProcess id="plan" name="Plan">
      <bpmn:serviceTask id="draft-plan" name="Draft plan" />
      <bpmn:userTask id="review-plan" name="Review plan" />
    </bpmn:subProcess>
    <bpmn:subProcess id="implement" name="Implement task">
      <bpmn:serviceTask id="write-code" name="Write code">
        <bpmn:extensionElements>
          <zeebe:properties>
            <zeebe:property name="nano:phase" value="Coding (agent)" />
          </zeebe:properties>
        </bpmn:extensionElements>
      </bpmn:serviceTask>
      <bpmn:subProcess id="trial-merge" name="Trial merge">
        <bpmn:serviceTask id="merge-attempt" name="Merge attempt" />
      </bpmn:subProcess>
    </bpmn:subProcess>
    <bpmn:serviceTask id="finalize" name="Finalize plan" nano:phase="Wrap up" />
    <bpmn:endEvent id="dispatched" name="Dispatched" />
  </bpmn:process>
</bpmn:definitions>`;

test("SCOPE_CONTAINERS names the process + nestable scope families", () => {
  assert.deepEqual([...SCOPE_CONTAINERS], ["process", "subProcess", "adHocSubProcess", "transaction"]);
});

test("buildScopeIndex records the process and every id-bearing element with its scope chain", () => {
  const idx = buildScopeIndex(MODEL);
  assert.equal(idx.process?.id, "plan-fanout");
  assert.equal(idx.process?.name, "Plan Fanout");

  // A flat task at process level: chain is just the process.
  assert.deepEqual(idx.elements.get("start")?.scopeChain, ["plan-fanout"]);
  // A task inside a top-level subProcess.
  assert.deepEqual(idx.elements.get("draft-plan")?.scopeChain, ["plan-fanout", "plan"]);
  // A task inside a nested subProcess: full outermost→innermost chain.
  assert.deepEqual(idx.elements.get("merge-attempt")?.scopeChain, [
    "plan-fanout",
    "implement",
    "trial-merge",
  ]);
  // Scope containers are flagged and carry their own chain (excluding themselves).
  assert.equal(idx.elements.get("trial-merge")?.isScope, true);
  assert.deepEqual(idx.elements.get("trial-merge")?.scopeChain, ["plan-fanout", "implement"]);
  assert.equal(idx.elements.get("write-code")?.isScope, false);
});

test("buildScopeIndex captures nano:phase overrides in attribute and zeebe:property forms", () => {
  const idx = buildScopeIndex(MODEL);
  // Attribute form on a flat task.
  assert.equal(idx.elements.get("finalize")?.phaseOverride, "Wrap up");
  // zeebe:property form nested in extensionElements attaches to the owning service task, not to a
  // sibling or ancestor.
  assert.equal(idx.elements.get("write-code")?.phaseOverride, "Coding (agent)");
  assert.equal(idx.elements.get("implement")?.phaseOverride, undefined);
  // No override → undefined.
  assert.equal(idx.elements.get("draft-plan")?.phaseOverride, undefined);
});

test("buildScopeIndex ignores over-broad matches: bare `phase` attr and non-zeebe/loose `property`", () => {
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" xmlns:zeebe="http://camunda.org/schema/zeebe/1.0">
  <bpmn:process id="p" name="P">
    <!-- A bare, unprefixed phase="…" attribute must NOT be treated as an override. -->
    <bpmn:serviceTask id="bare-attr" name="Bare attr" phase="not an override" />
    <!-- A bpmn:property (non-zeebe) carrying name="nano:phase" must NOT override. -->
    <bpmn:serviceTask id="bpmn-prop" name="Bpmn prop">
      <bpmn:extensionElements>
        <bpmn:property name="nano:phase" value="not an override" />
      </bpmn:extensionElements>
    </bpmn:serviceTask>
    <!-- A zeebe:property outside any extensionElements block must NOT override. -->
    <bpmn:serviceTask id="loose-prop" name="Loose prop">
      <zeebe:property name="nano:phase" value="not an override" />
    </bpmn:serviceTask>
  </bpmn:process>
</bpmn:definitions>`;
  const idx = buildScopeIndex(xml);
  assert.equal(idx.elements.get("bare-attr")?.phaseOverride, undefined);
  assert.equal(idx.elements.get("bpmn-prop")?.phaseOverride, undefined);
  assert.equal(idx.elements.get("loose-prop")?.phaseOverride, undefined);
});

test("derivePhase builds a breadcrumb of enclosing named scopes down to the element", () => {
  const idx = buildScopeIndex(MODEL);
  const phase = derivePhase(idx, "review-plan");
  assert.ok(phase);
  assert.deepEqual(
    phase.breadcrumb.map((c) => c.label),
    ["Plan Fanout", "Plan", "Review plan"],
  );
  assert.deepEqual(
    phase.breadcrumb.map((c) => c.kind),
    ["process", "subProcess", "element"],
  );
  assert.equal(phase.process, "Plan Fanout");
  assert.equal(phase.coarse, "Plan");
  assert.equal(phase.fine, "Review plan");
});

test("derivePhase: coarse is the top-level subProcess even when nested deeper", () => {
  const idx = buildScopeIndex(MODEL);
  const phase = derivePhase(idx, "merge-attempt");
  assert.ok(phase);
  assert.deepEqual(
    phase.breadcrumb.map((c) => c.label),
    ["Plan Fanout", "Implement task", "Trial merge", "Merge attempt"],
  );
  // Outermost meaningful scope = the top-level subProcess directly under the process.
  assert.equal(phase.coarse, "Implement task");
  assert.equal(phase.fine, "Merge attempt");
});

test("derivePhase: a flat (process-level) element yields a task-granular phase for free", () => {
  const idx = buildScopeIndex(MODEL);
  const phase = derivePhase(idx, "start");
  assert.ok(phase);
  assert.deepEqual(
    phase.breadcrumb.map((c) => c.label),
    ["Plan Fanout", "Start"],
  );
  // No subProcess → coarse falls back to the process.
  assert.equal(phase.coarse, "Plan Fanout");
  assert.equal(phase.fine, "Start");
});

test("derivePhase granularity: auto is subProcess-then-element", () => {
  const idx = buildScopeIndex(MODEL);
  // Inside a subProcess → auto picks the coarse subProcess label.
  assert.equal(derivePhase(idx, "review-plan")?.label, "Plan");
  // Flat → auto falls to the element label.
  assert.equal(derivePhase(idx, "start")?.label, "Start");
});

test("derivePhase granularity: subProcess and element force a level", () => {
  const idx = buildScopeIndex(MODEL);
  assert.equal(derivePhase(idx, "merge-attempt", { granularity: "subProcess" })?.label, "Implement task");
  assert.equal(derivePhase(idx, "merge-attempt", { granularity: "element" })?.label, "Merge attempt");
  // A flat element forced to subProcess granularity falls back to the process (no subProcess).
  assert.equal(derivePhase(idx, "start", { granularity: "subProcess" })?.label, "Plan Fanout");
});

test("derivePhase: Tier-1 override replaces the structural label and flags its source", () => {
  const idx = buildScopeIndex(MODEL);
  const attrForm = derivePhase(idx, "finalize");
  assert.ok(attrForm);
  assert.equal(attrForm.fine, "Wrap up");
  assert.equal(attrForm.breadcrumb.at(-1)?.source, "override");

  const propForm = derivePhase(idx, "write-code");
  assert.ok(propForm);
  assert.equal(propForm.fine, "Coding (agent)");
  assert.equal(propForm.breadcrumb.at(-1)?.source, "override");
  // Its structural ancestors remain structural.
  assert.equal(propForm.breadcrumb[0].source, "structural");
});

test("derivePhase: unnamed element falls back to its id (never blank)", () => {
  const idx = buildScopeIndex(
    `<bpmn:process id="p"><bpmn:task id="t42" /></bpmn:process>`,
  );
  const phase = derivePhase(idx, "t42");
  assert.ok(phase);
  assert.equal(phase.fine, "t42");
  assert.equal(phase.breadcrumb.at(-1)?.source, "structural");
});

test("derivePhase returns undefined for an unknown element", () => {
  const idx = buildScopeIndex(MODEL);
  assert.equal(derivePhase(idx, "no-such-element"), undefined);
});

test("derivePhase tolerates namespace prefixes and entity-encoded names", () => {
  const idx = buildScopeIndex(
    `<process id="p" name="A &amp; B"><subProcess id="s" name="Wave &lt;1&gt;"><task id="t" name="Go" /></subProcess></process>`,
  );
  const phase = derivePhase(idx, "t");
  assert.ok(phase);
  assert.deepEqual(
    phase.breadcrumb.map((c) => c.label),
    ["A & B", "Wave <1>", "Go"],
  );
});

test("furthestReached picks the greatest seq per instance and ignores null joins", () => {
  const rows: ProvenanceProgressRow[] = [
    { instance_key: "i1", element_id: "start", seq: 1, at: "2024-01-01T00:00:00Z" },
    { instance_key: "i1", element_id: "review-plan", seq: 5, at: "2024-01-01T00:05:00Z" },
    { instance_key: "i1", element_id: "draft-plan", seq: 3, at: "2024-01-01T00:03:00Z" },
    { instance_key: "i2", element_id: "finalize", seq: 2, at: "2024-01-01T00:02:00Z" },
    { instance_key: null, element_id: "x", seq: 9 },
    { instance_key: "i3", element_id: null, seq: 9 },
  ];
  const f = furthestReached(rows);
  assert.equal(f.get("i1")?.elementId, "review-plan");
  assert.equal(f.get("i1")?.seq, 5);
  assert.equal(f.get("i2")?.elementId, "finalize");
  assert.equal(f.has("i3"), false);
  assert.equal(f.has(""), false);
});

test("deriveInstancePhases projects furthest element → phase per instance", () => {
  const idx = buildScopeIndex(MODEL);
  const rows: ProvenanceProgressRow[] = [
    { instance_key: "i1", element_id: "draft-plan", seq: 1, at: "2024-01-01T00:01:00Z" },
    { instance_key: "i1", element_id: "review-plan", seq: 2, at: "2024-01-01T00:02:00Z" },
    { instance_key: "i2", element_id: "merge-attempt", seq: 3, at: "2024-01-01T00:03:00Z" },
    // Furthest element belongs to a different deployed model → skipped.
    { instance_key: "i3", element_id: "foreign-element", seq: 4, at: "2024-01-01T00:04:00Z" },
  ];
  const phases = deriveInstancePhases(idx, rows);
  assert.equal(phases.get("i1")?.phase.label, "Plan");
  assert.equal(phases.get("i1")?.seq, 2);
  assert.equal(phases.get("i1")?.at, "2024-01-01T00:02:00Z");
  assert.equal(phases.get("i2")?.phase.coarse, "Implement task");
  assert.equal(phases.has("i3"), false);
});

test("rollupLineagePhase: epic frontier is the most-recently-advanced contributor", () => {
  // Parent epic i-root fans out to two children; the child that advanced latest defines the frontier.
  const edges: LineageEdge[] = [
    { rootRequestKey: "i-root", instanceKey: "i-child-a", causedByInstanceKey: "i-root", edgeType: "weak" },
    { rootRequestKey: "i-root", instanceKey: "i-child-b", causedByInstanceKey: "i-root", edgeType: "weak" },
  ];
  const tree = buildLineageTree("i-root", edges);
  const idx = buildScopeIndex(MODEL);
  const rows: ProvenanceProgressRow[] = [
    { instance_key: "i-root", element_id: "draft-plan", seq: 1, at: "2024-01-01T00:01:00Z" },
    { instance_key: "i-child-a", element_id: "review-plan", seq: 2, at: "2024-01-01T00:02:00Z" },
    { instance_key: "i-child-b", element_id: "merge-attempt", seq: 3, at: "2024-01-01T00:09:00Z" },
  ];
  const phases = deriveInstancePhases(idx, rows);
  const rollup = rollupLineagePhase(tree, phases);
  assert.equal(rollup.rootRequestKey, "i-root");
  assert.equal(rollup.frontier?.instanceKey, "i-child-b");
  assert.equal(rollup.frontier?.phase.coarse, "Implement task");
  assert.equal(rollup.contributions.length, 3);
});

test("rollupLineagePhase: frontier breaks ties on seq and folds in unattached nodes", () => {
  const tree = buildLineageTree("i-root", [
    { rootRequestKey: "i-root", instanceKey: "i-root", edgeType: "weak" },
  ]);
  // Two contributors with the SAME `at` — greater seq wins the tie.
  const phaseByInstance = new Map<string, InstancePhase>([
    [
      "i-root",
      { instanceKey: "i-root", phase: derivePhase(buildScopeIndex(MODEL), "start")!, seq: 1, at: "t" },
    ],
    // An orphan node not reachable from root but present via the phase map is still considered.
    [
      "i-orphan",
      { instanceKey: "i-orphan", phase: derivePhase(buildScopeIndex(MODEL), "finalize")!, seq: 9, at: "t" },
    ],
  ]);
  // Attach the orphan to tree.nodes so the rollup can see it.
  const treeWithOrphan = {
    ...tree,
    nodes: [...tree.nodes, { instanceKey: "i-orphan", attachments: [], children: [] }],
  };
  const rollup = rollupLineagePhase(treeWithOrphan, phaseByInstance);
  assert.equal(rollup.frontier?.instanceKey, "i-orphan");
  assert.equal(rollup.contributions.length, 2);
});

test("rollupLineagePhase: no phased nodes → no frontier", () => {
  const tree = buildLineageTree("i-root", [
    { rootRequestKey: "i-root", instanceKey: "i-root", edgeType: "weak" },
  ]);
  const rollup = rollupLineagePhase(tree, new Map());
  assert.equal(rollup.frontier, undefined);
  assert.deepEqual(rollup.contributions, []);
});

test("buildScopeIndex is resilient to comments, CDATA and self-closing scopes", () => {
  const idx = buildScopeIndex(
    `<bpmn:process id="p" name="P">
       <!-- a comment with <fake id="x" /> inside -->
       <bpmn:subProcess id="s" name="S">
         <bpmn:serviceTask id="t" name="T"><![CDATA[<not id="y"/>]]></bpmn:serviceTask>
       </bpmn:subProcess>
     </bpmn:process>`,
  );
  assert.equal(idx.elements.has("x"), false);
  assert.equal(idx.elements.has("y"), false);
  assert.deepEqual(idx.elements.get("t")?.scopeChain, ["p", "s"]);
});
