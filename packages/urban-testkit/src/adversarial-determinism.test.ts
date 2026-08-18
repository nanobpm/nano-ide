// Determinism guard for the mock layer (epic #296, S5).
//
// The whole test kit is deterministic under a virtual clock: the drain reaches a fixpoint without
// wall-clock time or randomness. The mock layer (job-worker mocking + child-process mocking) must
// preserve that. This file guards it two ways:
//
//   • Runtime: mocks of every deterministically-terminal outcome drive an instance to quiescence,
//     and a *second* explicit `drain()` is a no-op (a true fixpoint, not a moving target).
//   • Static: the mock modules — `worker-mock.ts`, `child-process-mock.ts`, and the mock
//     interception added to `wasm-engine.ts` — contain NO `setTimeout` / `setInterval` /
//     wall-clock (`Date.now()`, `new Date()`, `performance.now()`) / `Math.random()` usage. This
//     is the regression net: a future edit that sneaks real time or randomness into the mock path
//     fails CI here even if it happens not to flake in a given run.
//
// Runs on Node and Deno.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createWasmEngineClient, type WasmEngineClient } from "./wasm-engine.ts";

// ---------------------------------------------------------------------------------------------
// Runtime fixpoint checks.
// ---------------------------------------------------------------------------------------------

/** Two service tasks then a user task — parks ACTIVE so mocked completions stay observable. */
const TWO_BPMN = `<?xml version="1.0" encoding="UTF-8"?>
<definitions xmlns="http://www.omg.org/spec/BPMN/20100524/MODEL"
             xmlns:zeebe="http://camunda.org/schema/zeebe/1.0"
             targetNamespace="http://nanobpm/testkit">
  <process id="two" isExecutable="true">
    <startEvent id="s"/>
    <sequenceFlow id="f1" sourceRef="s" targetRef="ta"/>
    <serviceTask id="ta"><extensionElements><zeebe:taskDefinition type="a"/></extensionElements></serviceTask>
    <sequenceFlow id="f2" sourceRef="ta" targetRef="tb"/>
    <serviceTask id="tb"><extensionElements><zeebe:taskDefinition type="b"/></extensionElements></serviceTask>
    <sequenceFlow id="f3" sourceRef="tb" targetRef="review"/>
    <userTask id="review"><extensionElements><zeebe:userTask/></extensionElements></userTask>
  </process>
</definitions>`;

/** A single service task — completes the whole instance (for the incident/error fixpoints). */
const SVC_BPMN = `<?xml version="1.0" encoding="UTF-8"?>
<definitions xmlns="http://www.omg.org/spec/BPMN/20100524/MODEL"
             xmlns:zeebe="http://camunda.org/schema/zeebe/1.0"
             targetNamespace="http://nanobpm/testkit">
  <process id="svc" isExecutable="true">
    <startEvent id="s"/>
    <sequenceFlow id="f1" sourceRef="s" targetRef="work"/>
    <serviceTask id="work"><extensionElements><zeebe:taskDefinition type="work"/></extensionElements></serviceTask>
    <sequenceFlow id="f2" sourceRef="work" targetRef="e"/>
    <endEvent id="e"/>
  </process>
</definitions>`;

/** Parent with a call activity to `child`, then a user task. */
const PARENT_BPMN = `<?xml version="1.0" encoding="UTF-8"?>
<definitions xmlns="http://www.omg.org/spec/BPMN/20100524/MODEL"
             xmlns:zeebe="http://camunda.org/schema/zeebe/1.0"
             targetNamespace="http://nanobpm/testkit">
  <process id="parent" isExecutable="true">
    <startEvent id="s"/>
    <sequenceFlow id="f1" sourceRef="s" targetRef="ca"/>
    <callActivity id="ca">
      <extensionElements><zeebe:calledElement processId="child" propagateAllChildVariables="true"/></extensionElements>
    </callActivity>
    <sequenceFlow id="f2" sourceRef="ca" targetRef="review"/>
    <userTask id="review"><extensionElements><zeebe:userTask/></extensionElements></userTask>
  </process>
</definitions>`;

const CHILD_BPMN = `<?xml version="1.0" encoding="UTF-8"?>
<definitions xmlns="http://www.omg.org/spec/BPMN/20100524/MODEL"
             xmlns:zeebe="http://camunda.org/schema/zeebe/1.0"
             targetNamespace="http://nanobpm/testkit">
  <process id="child" isExecutable="true">
    <startEvent id="cs"/>
    <sequenceFlow id="cf1" sourceRef="cs" targetRef="cwork"/>
    <serviceTask id="cwork"><extensionElements><zeebe:taskDefinition type="cwork"/></extensionElements></serviceTask>
    <sequenceFlow id="cf2" sourceRef="cwork" targetRef="ce"/>
    <endEvent id="ce"/>
  </process>
</definitions>`;

function res(...models: { name: string; xml: string }[]): { name: string; content: string; contentType: string }[] {
  return models.map((m) => ({ name: m.name, content: m.xml, contentType: "text/xml" }));
}

async function withEngine(
  models: { name: string; xml: string }[],
  body: (engine: WasmEngineClient) => Promise<void>,
): Promise<void> {
  const engine = await createWasmEngineClient();
  try {
    await engine.deployResources(res(...models));
    await body(engine);
  } finally {
    await engine.close();
  }
}

/** Assert an extra `drain()` after the given `body` changes nothing observable — a true fixpoint.
 *  Compares the full snapshot before/after the redundant drain. */
async function assertRedundantDrainIsNoop(engine: WasmEngineClient): Promise<void> {
  const before = JSON.stringify(engine.snapshot());
  await engine.drain();
  const after = JSON.stringify(engine.snapshot());
  assert.equal(after, before, "a second drain() at the same virtual instant must be a no-op (fixpoint)");
}

test("determinism: worker completions drain to a fixpoint; a redundant drain is a no-op", async () => {
  await withEngine([{ name: "two.bpmn", xml: TWO_BPMN }], async (engine) => {
    engine.mockWorker("a").completeWith({ a: 1 });
    engine.mockWorker("b").completeWith({ b: 2 });
    await engine.createInstance({ processDefinitionId: "two" });
    await assertRedundantDrainIsNoop(engine);
  });
});

test("determinism: a worker incident outcome drains to a fixpoint; a redundant drain is a no-op", async () => {
  await withEngine([{ name: "svc.bpmn", xml: SVC_BPMN }], async (engine) => {
    engine.mockWorker("work").raiseIncident({ message: "stop" });
    await engine.createInstance({ processDefinitionId: "svc" });
    await assertRedundantDrainIsNoop(engine);
  });
});

test("determinism: a child-process completeWith drains to a fixpoint; a redundant drain is a no-op", async () => {
  await withEngine(
    [
      { name: "parent.bpmn", xml: PARENT_BPMN },
      { name: "child.bpmn", xml: CHILD_BPMN },
    ],
    async (engine) => {
      engine.mockChildProcess("child").completeWith({ done: true });
      await engine.createInstance({ processDefinitionId: "parent" });
      await assertRedundantDrainIsNoop(engine);
    },
  );
});

test("determinism: a child-process failWith incident drains to a fixpoint; a redundant drain is a no-op", async () => {
  await withEngine(
    [
      { name: "parent.bpmn", xml: PARENT_BPMN },
      { name: "child.bpmn", xml: CHILD_BPMN },
    ],
    async (engine) => {
      engine.mockChildProcess("child").failWith({ message: "child failed" });
      await engine.createInstance({ processDefinitionId: "parent" });
      await assertRedundantDrainIsNoop(engine);
    },
  );
});

test("determinism: repeated identical runs produce byte-identical mock-driven variable snapshots", async () => {
  // Determinism means reproducibility: the same mocked scenario twice yields the same merged state.
  // We compare only the mock-driven variables — the engine stamps a per-instance lineage UUID
  // (`_urban`) that legitimately differs run-to-run and is outside the mock layer's contract.
  const run = async (): Promise<string> => {
    let vars = "{}";
    await withEngine([{ name: "two.bpmn", xml: TWO_BPMN }], async (engine) => {
      engine.mockWorker("a").when((j) => j.variables.n === 1).completeWith({ a: "one" });
      engine.mockWorker("a").completeWith({ a: "default" });
      engine.mockWorker("b").completeWith({ b: 2 });
      const { processInstanceKey } = await engine.createInstance({ processDefinitionId: "two", variables: { n: 1 } });
      const inst = engine.snapshot().instances;
      const found = Array.isArray(inst)
        ? inst.find((i) => i && typeof i === "object" && String(Reflect.get(i, "key")) === processInstanceKey)
        : undefined;
      const raw = found && typeof found === "object" ? Reflect.get(found, "variables") : {};
      const merged: Record<string, unknown> = {};
      if (raw && typeof raw === "object") {
        for (const [k, v] of Object.entries(raw)) {
          if (k !== "_urban") merged[k] = v; // drop the per-instance lineage UUID
        }
      }
      vars = JSON.stringify(merged, Object.keys(merged).sort());
    });
    return vars;
  };
  const first = await run();
  const second = await run();
  assert.equal(second, first, "two identical mocked runs produced identical mock-driven variables");
  assert.ok(first.includes('"a":"one"'), "the first-match clause fired deterministically");
  assert.ok(first.includes('"b":2'), "the unconditional mock fired deterministically");
});

// ---------------------------------------------------------------------------------------------
// Static source guard — no wall-clock / randomness in the mock layer.
// ---------------------------------------------------------------------------------------------

/** Read a sibling source file (works under Node's type-stripping and Deno). */
function readSibling(name: string): string {
  return readFileSync(fileURLToPath(new URL(`./${name}`, import.meta.url)), "utf8");
}

/** Extract a named method's body from a class source by brace-matching from its signature, so the
 *  guard can scope the `wasm-engine.ts` scan to just the mock-interception seam (not unrelated
 *  engine-client code that may legitimately touch timers/clocks in future). Returns the body text
 *  including the surrounding braces. Throws if the method (or a balanced body) isn't found. */
function methodBody(source: string, signature: string): string {
  const start = source.indexOf(signature);
  assert.notEqual(start, -1, `expected to find method \`${signature}\` in the source`);
  const open = source.indexOf("{", start);
  assert.notEqual(open, -1, `expected an opening brace after \`${signature}\``);
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    const ch = source[i];
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return source.slice(open, i + 1);
    }
  }
  throw new Error(`unbalanced braces scanning \`${signature}\``);
}

/** Forbidden non-deterministic constructs. Each is a real source of wall-clock/randomness that
 *  would break the virtual-clock fixpoint. `now()` alone is NOT forbidden — the engine exposes a
 *  virtual `now()` — only JS wall-clock/randomness APIs are. */
const FORBIDDEN: readonly { readonly label: string; readonly pattern: RegExp }[] = [
  { label: "setTimeout", pattern: /\bsetTimeout\s*\(/ },
  { label: "setInterval", pattern: /\bsetInterval\s*\(/ },
  { label: "Date.now()", pattern: /\bDate\s*\.\s*now\s*\(/ },
  { label: "new Date(...) wall-clock", pattern: /\bnew\s+Date\s*\(/ },
  { label: "Date.UTC()", pattern: /\bDate\s*\.\s*UTC\s*\(/ },
  { label: "performance.now()", pattern: /\bperformance\s*\.\s*now\s*\(/ },
  { label: "Math.random()", pattern: /\bMath\s*\.\s*random\s*\(/ },
  { label: "queueMicrotask", pattern: /\bqueueMicrotask\s*\(/ },
  { label: "setImmediate", pattern: /\bsetImmediate\s*\(/ },
];

function assertNoForbidden(where: string, text: string): void {
  for (const { label, pattern } of FORBIDDEN) {
    assert.equal(
      pattern.test(text),
      false,
      `${where} must not use ${label} — it would break the deterministic virtual-clock drain fixpoint`,
    );
  }
}

test("determinism (static): worker-mock.ts uses no wall-clock or randomness", () => {
  assertNoForbidden("worker-mock.ts", readSibling("worker-mock.ts"));
});

test("determinism (static): child-process-mock.ts uses no wall-clock or randomness", () => {
  assertNoForbidden("child-process-mock.ts", readSibling("child-process-mock.ts"));
});

test("determinism (static): the wasm-engine.ts mock-interception seam uses no wall-clock or randomness", () => {
  const src = readSibling("wasm-engine.ts");
  // Scope to exactly the methods that implement mock dispatch/registration — the seam this epic
  // added — rather than the whole engine client, so an unrelated future engine feature that
  // legitimately touches timers doesn't false-positive this mock-focused guard.
  const seams = [
    "async drain(",
    "#dispatchableJobTypes(",
    "#runChildProcessJob(",
    "async #runJob(",
    "#failFromError(",
    "mockWorker(",
    "clearWorkerMock(",
    "mockChildProcess(",
    "clearChildProcessMock(",
    "observeJobs(",
  ];
  for (const sig of seams) {
    assertNoForbidden(`wasm-engine.ts \`${sig})\``, methodBody(src, sig));
  }
});

test("determinism (static): the guard's method extractor actually finds a non-trivial mock seam", () => {
  // Guard-the-guard: if a refactor renames/removes a seam, `methodBody` throws (caught above) — but
  // a silently-empty body would let the scan pass vacuously. Assert the extracted `#runJob` body is
  // substantial and contains its known mock-dispatch call, so the scan above is not a no-op.
  const runJob = methodBody(readSibling("wasm-engine.ts"), "async #runJob(");
  assert.ok(runJob.length > 200, "the extracted #runJob body should be substantial, not an empty match");
  assert.ok(runJob.includes("applyOutcome"), "#runJob should contain the mock-outcome application the guard scans");
});
