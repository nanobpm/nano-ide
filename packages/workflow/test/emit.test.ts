// Unit tests for the authoring surfaces + model derivation + the replay engine.
// These need no gateway and always run. Run against the built `dist` artifact.
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  defineWorkflow,
  defineFlow,
  envelope,
  toBpmn,
  toDeployableBpmn,
  declarativeToLayoutedBpmn,
  layoutBpmn,
  externalJobTypes,
  walkNodes,
  replayOnce,
  Worker,
  WorkflowClient,
  WorkflowError,
  type ImperativeWorkflow,
  type Journal,
  type DeclarativeFlow,
} from "../dist/index.js";

test("imperative emit: single looped orchestrator with derived job type", () => {
  const wf = defineWorkflow("pr-review", async () => {});
  assert.equal(wf.orchestrateType, "pr-review:__orchestrate");
  const xml = toBpmn(wf);
  assert.match(xml, /<zeebe:taskDefinition type="pr-review:__orchestrate" \/>/);
  assert.match(xml, /<bpmn:exclusiveGateway id="Gw" default="f_loop">/);
  assert.match(xml, /<bpmn:conditionExpression>=wfDone<\/bpmn:conditionExpression>/);
  assert.match(xml, /<bpmn:sequenceFlow id="f_loop" sourceRef="Gw" targetRef="Orchestrate" \/>/);
});

test("walkNodes: fails fast on an unregistered flow-node kind instead of silently skipping recursion", () => {
  // A runtime-invalid node whose `kind` was never registered (JSON.parse yields
  // an untyped value — no `as` cast). Silently skipping it (the old
  // `nodeKind(n.kind)?.walk?.` form) would hide the missing registration and
  // could drop nested nodes; consumers like WorkflowClient.signal() must see a
  // clear error, matching the emitter's requireNodeKind fail-fast.
  const bogus = JSON.parse('[{"kind":"__never_registered__","name":"x"}]');
  assert.throws(() => walkNodes(bogus, () => {}), /no handler registered for flow-node kind "__never_registered__"/);
});

test("declarative emit: service tasks + derived types + message/subscription", () => {
  const flow = defineFlow("pr-review", (w) => {
    w.run("fetchDiff", async () => ({}));
    w.signal("humanApproval", { correlationKey: "prId" });
    w.run("merge", async () => ({}));
  });
  const xml = toBpmn(flow);
  assert.match(xml, /<zeebe:taskDefinition type="pr-review:fetchDiff" \/>/);
  assert.match(xml, /<zeebe:taskDefinition type="pr-review:merge" \/>/);
  assert.match(xml, /<bpmn:intermediateCatchEvent id="humanApproval"/);
  assert.match(xml, /<bpmn:message id="Msg_humanApproval" name="pr-review:humanApproval">/);
  assert.match(xml, /<zeebe:subscription correlationKey="=prId" \/>/);
});

test("declarative emit: timer intermediate catch (after → timeDuration)", () => {
  const flow = defineFlow("delayed", (w) => {
    w.task("kickoff");
    w.timer("cooldown", { after: "PT30M" });
    w.task("resume");
  });
  const xml = toBpmn(flow);
  assert.match(xml, /<bpmn:intermediateCatchEvent id="cooldown" name="cooldown">/);
  assert.match(xml, /<bpmn:timerEventDefinition>\s*<bpmn:timeDuration>PT30M<\/bpmn:timeDuration>\s*<\/bpmn:timerEventDefinition>/);
  // A timer catch is NOT a message: no message/subscription emitted for it.
  assert.doesNotMatch(xml, /Msg_cooldown/);
});

test("declarative emit: timer intermediate catch (at → timeDate)", () => {
  const flow = defineFlow("scheduled", (w) => {
    w.timer("until", { at: "2026-01-01T09:00:00Z" });
    w.task("newYear");
  });
  const xml = toBpmn(flow);
  assert.match(xml, /<bpmn:intermediateCatchEvent id="until"/);
  assert.match(xml, /<bpmn:timeDate>2026-01-01T09:00:00Z<\/bpmn:timeDate>/);
});

test("declarative emit: timer catch accepts a FEEL expression", () => {
  const flow = defineFlow("feelwait", (w) => {
    w.timer("wait", { after: "=duration(delay)" });
    w.task("go");
  });
  assert.match(toBpmn(flow), /<bpmn:timeDuration>=duration\(delay\)<\/bpmn:timeDuration>/);
});

test("declarative emit: timer literals are trimmed before emission (validate == store)", () => {
  const flow = defineFlow("trimmed", (w) => {
    w.startOn({ cycle: " R/PT1H " });
    w.task("poll");
    w.timer("wait", { after: "  PT30M  " });
    w.task("done");
  });
  const xml = toBpmn(flow);
  assert.match(xml, /<bpmn:timeCycle>R\/PT1H<\/bpmn:timeCycle>/);
  assert.match(xml, /<bpmn:timeDuration>PT30M<\/bpmn:timeDuration>/);
  assert.doesNotMatch(xml, /<bpmn:timeCycle> /);
  assert.doesNotMatch(xml, /<bpmn:timeDuration>  /);
});

test("declarative emit: startOn cycle → durable timer start (cron replacement)", () => {
  const flow = defineFlow("nightly-report", (w) => {
    w.startOn({ cycle: "R/PT24H" });
    w.task("generate");
    w.task("email");
  });
  const xml = toBpmn(flow);
  assert.match(
    xml,
    /<bpmn:startEvent id="Start">[\s\S]*?<bpmn:timerEventDefinition>\s*<bpmn:timeCycle>R\/PT24H<\/bpmn:timeCycle>\s*<\/bpmn:timerEventDefinition>[\s\S]*?<\/bpmn:startEvent>/,
  );
  assert.match(xml, /<bpmn:outgoing>f_0<\/bpmn:outgoing>/);
});

test("declarative emit: startOn after → one-shot timer start; at → timeDate start", () => {
  const delayed = defineFlow("delayed-start", (w) => {
    w.startOn({ after: "PT10S" });
    w.task("run");
  });
  assert.match(toBpmn(delayed), /<bpmn:startEvent[\s\S]*?<bpmn:timeDuration>PT10S<\/bpmn:timeDuration>/);

  const dated = defineFlow("dated-start", (w) => {
    w.startOn({ at: "2026-03-01T00:00:00Z" });
    w.task("run");
  });
  assert.match(toBpmn(dated), /<bpmn:startEvent[\s\S]*?<bpmn:timeDate>2026-03-01T00:00:00Z<\/bpmn:timeDate>/);
});

test("declarative emit: a plain flow still emits a none start (no timer)", () => {
  const flow = defineFlow("plain", (w) => {
    w.task("only");
  });
  const xml = toBpmn(flow);
  assert.match(xml, /<bpmn:startEvent id="Start"><bpmn:outgoing>f_0<\/bpmn:outgoing><\/bpmn:startEvent>/);
  assert.doesNotMatch(xml, /timerEventDefinition/);
});

test("timer validation: rejects zero or both of after/at, and bad ISO", () => {
  assert.throws(
    () => defineFlow("x", (w) => w.timer("t", {} as { after: string })),
    /exactly one of \{ after \}.*\{ at \}/,
  );
  assert.throws(
    () => defineFlow("x", (w) => w.timer("t", { after: "PT1M", at: "2026-01-01T00:00:00Z" } as { after: string })),
    /exactly one of \{ after \}/,
  );
  assert.throws(() => defineFlow("x", (w) => w.timer("t", { after: "1 minute" })), /ISO-8601 duration/);
  assert.throws(() => defineFlow("x", (w) => w.timer("t", { at: "tomorrow" })), /ISO-8601 instant/);
  // A timeDate is an absolute instant: a bare local datetime (no Z/offset) is ambiguous and rejected.
  assert.throws(() => defineFlow("x", (w) => w.timer("t", { at: "2026-01-01T09:00:00" })), /ISO-8601 instant/);
  assert.doesNotThrow(() => defineFlow("ok", (w) => { w.timer("t", { at: "2026-01-01T09:00:00+02:00" }); w.task("a"); }));
  // A null/non-object opts (e.g. a JSON-derived config) must still yield the
  // helpful "needs exactly one of …" error, not a raw `Cannot use 'in' operator
  // … in null` TypeError. JSON.parse() returns `any` — a runtime-invalid input
  // with no `as`-cast.
  assert.throws(
    () => defineFlow("x", (w) => w.timer("t", JSON.parse("null"))),
    /exactly one of \{ after \}.*\{ at \}/,
  );
});

test("declarative builder: null-prototype method table — inherited names are never registered methods", () => {
  // The builder's method table is assembled on a NULL prototype so its
  // duplicate-detection own-property check (and every `w.<method>` lookup) can
  // never mistake an inherited `Object.prototype` name (`toString`,
  // `constructor`, `hasOwnProperty`, …) for a contributed builder method, and
  // so a `__proto__` method name cannot mutate the prototype. Both footguns
  // derive from an `Object.prototype` chain — pinning the null prototype guards
  // the whole class.
  let builder: object | undefined;
  defineFlow("proto", (w) => {
    builder = w;
    w.task("a");
  });
  if (!builder) throw new Error("build callback did not receive the assembled builder");
  assert.strictEqual(Object.getPrototypeOf(builder), null);
  for (const inherited of ["toString", "constructor", "hasOwnProperty", "__proto__"]) {
    assert.ok(!(inherited in builder), `inherited "${inherited}" must not appear on the builder`);
  }
});

test("startOn validation: cycle format, once-only, first-statement, top-level", () => {
  assert.throws(() => defineFlow("x", (w) => { w.startOn({ cycle: "every hour" }); w.task("a"); }), /repeating interval/);

  assert.throws(
    () => defineFlow("x", (w) => { w.task("a"); w.startOn({ cycle: "R/PT1H" }); }),
    /must be the first statement/,
  );

  assert.throws(
    () => defineFlow("x", (w) => { w.startOn({ cycle: "R/PT1H" }); w.startOn({ after: "PT1S" }); w.task("a"); }),
    /only once/,
  );

  assert.throws(
    () => defineFlow("x", (w) => { w.task("a"); w.loop((b) => { b.startOn({ cycle: "R/PT1H" }); b.break(); }); }),
    /only valid at the top level/,
  );

  assert.throws(
    () => defineFlow("x", (w) => { w.startOn({} as { cycle: string }); w.task("a"); }),
    /exactly one of \{ cycle \}/,
  );
});

test("timer catch: emitted XML round-trips through auto-layout with DI", async () => {
  const flow = defineFlow("scheduler", (w) => {
    w.startOn({ cycle: "R/PT1H" });
    w.task("poll");
    w.timer("backoff", { after: "PT5M" });
    w.task("notify");
  });
  const laid = await declarativeToLayoutedBpmn(flow);
  assert.match(laid, /bpmndi:BPMNDiagram/);
  assert.match(laid, /<bpmn:timeCycle>R\/PT1H<\/bpmn:timeCycle>/);
  assert.match(laid, /<bpmn:timeDuration>PT5M<\/bpmn:timeDuration>/);
});

test("declarative layout: auto-generates diagram interchange (DI) and preserves zeebe wiring", async () => {
  const flow = defineFlow("pr-review", (w) => {
    w.run("fetchDiff", async () => ({}));
    w.signal("humanApproval", { correlationKey: "prId" });
    w.task("merge");
  });

  // The semantic emitter is DI-less: the engine runs it, but it has no diagram.
  assert.doesNotMatch(toBpmn(flow), /bpmndi:BPMNDiagram/);

  const laid = await declarativeToLayoutedBpmn(flow);

  // A diagram is now present, with a shape per flow node and an edge per flow.
  assert.match(laid, /<bpmndi:BPMNDiagram\b/);
  assert.match(laid, /<bpmndi:BPMNPlane\b/);
  // Start, fetchDiff, humanApproval, merge, End = 5 shapes; 4 sequence flows.
  assert.ok(
    (laid.match(/<bpmndi:BPMNShape\b/g) ?? []).length >= 5,
    "expected a shape per flow node",
  );
  assert.ok(
    (laid.match(/<bpmndi:BPMNEdge\b/g) ?? []).length >= 4,
    "expected an edge per sequence flow",
  );

  // The semantic content survives the layout round-trip (bpmn-moddle re-serialise):
  // job types, the message, and its zeebe subscription/correlation are intact.
  assert.match(laid, /zeebe:taskDefinition type="pr-review:merge"/);
  assert.match(laid, /<bpmn:message\b/);
  assert.match(laid, /zeebe:subscription/);
  assert.match(laid, /correlationKey="=prId"/);
});

test("layoutBpmn: adds DI to a DI-less model and is idempotent on already-laid-out input", async () => {
  const flow = defineFlow("linear", (w) => {
    w.run("a", async () => ({}));
    w.run("b", async () => ({}));
  });
  const once = await layoutBpmn(toBpmn(flow));
  assert.match(once, /<bpmndi:BPMNDiagram\b/);
  // Re-laying-out an already-diagrammed model still yields exactly one diagram.
  const twice = await layoutBpmn(once);
  assert.equal((twice.match(/<bpmndi:BPMNDiagram\b/g) ?? []).length, 1);
});

test("toDeployableBpmn: lays out (DI) by default, DI-less when layout:false", async () => {
  const flow = defineFlow("deployable", (w) => {
    w.run("a", async () => ({}));
    w.signal("wait", { correlationKey: "id" });
    w.run("b", async () => ({}));
  });
  const laid = await toDeployableBpmn(flow);
  assert.match(laid, /<bpmndi:BPMNDiagram\b/);
  // Opting out yields the semantic model the engine runs, with no diagram.
  const bare = await toDeployableBpmn(flow, { layout: false });
  assert.doesNotMatch(bare, /bpmndi:BPMNDiagram/);
});

async function captureDeployXml(
  flow: DeclarativeFlow,
  opts?: { layout?: boolean },
): Promise<string> {
  let sent = "";
  const client = new WorkflowClient({
    client: {
      async createDeployment(input: { resources: File[] }) {
        sent = await input.resources[0].text();
        return { deploymentKey: "1" };
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
  await client.deploy(flow, opts);
  return sent;
}

test("deploy: posts a laid-out model (DI) so the deployed process is inspectable", async () => {
  const flow = defineFlow("pr-review", (w) => {
    w.run("fetchDiff", async () => ({}));
    w.task("merge");
  });
  const xml = await captureDeployXml(flow);
  assert.match(xml, /<bpmndi:BPMNDiagram\b/);
  assert.match(xml, /<bpmndi:BPMNShape\b/);
  // The semantic wiring survives the layout round-trip.
  assert.match(xml, /<zeebe:taskDefinition type="pr-review:fetchDiff" \/>/);
});

test("deploy({layout:false}): posts the DI-less semantic model", async () => {
  const flow = defineFlow("pr-review", (w) => {
    w.run("fetchDiff", async () => ({}));
  });
  const xml = await captureDeployXml(flow, { layout: false });
  assert.doesNotMatch(xml, /bpmndi:BPMNDiagram/);
  assert.match(xml, /<zeebe:taskDefinition type="pr-review:fetchDiff" \/>/);
});

test("declarative validation: duplicates, missing correlationKey, empty, bad id", () => {
  assert.throws(
    () =>
      defineFlow("dup", (w) => {
        w.run("a", async () => ({}));
        w.run("a", async () => ({}));
      }),
    /duplicate step name "a"/,
  );
  assert.throws(
    // @ts-expect-error intentionally missing correlationKey
    () => defineFlow("f", (w) => w.signal("s", {})),
    /needs \{ correlationKey \}/,
  );
  assert.throws(() => defineFlow("empty", () => {}), /declared no steps/);
  assert.throws(() => defineFlow("bad id!", (w) => w.run("a", async () => ({}))), /not a valid BPMN identifier/);
});

test("replayOnce: first pass runs only the frontier step (its side effect once)", async () => {
  const calls: string[] = [];
  const wf: ImperativeWorkflow = defineWorkflow("t", async (ctx) => {
    await ctx.run("a", () => {
      calls.push("a");
      return { n: 1 };
    });
    await ctx.run("b", () => {
      calls.push("b");
      return { n: 2 };
    });
  });

  const step0 = await replayOnce(wf, {}, {});
  assert.equal(step0.done, false);
  assert.deepEqual(calls, ["a"], "only the frontier (a) executed");
  assert.equal(step0.done === false && step0.frontier.key, "1:a");
});

test("replayOnce: recorded steps are replayed (handler NOT called), frontier advances", async () => {
  const calls: string[] = [];
  const wf = defineWorkflow("t", async (ctx) => {
    const a = await ctx.run("a", () => {
      calls.push("a");
      return { n: 1 };
    });
    await ctx.run("b", () => {
      calls.push("b");
      return { n: (a as { n: number }).n + 1 };
    });
  });

  const journal: Journal = { "1:a": { n: 1 } };
  const step = await replayOnce(wf, {}, journal);
  assert.equal(step.done, false);
  assert.deepEqual(calls, ["b"], "a was replayed from the journal (no side effect); only b ran");
  assert.equal(step.done === false && step.frontier.key, "2:b");
});

test("replayOnce: a fully-journalled run reports done and calls nothing", async () => {
  const calls: string[] = [];
  const wf = defineWorkflow("t", async (ctx) => {
    await ctx.run("a", () => {
      calls.push("a");
      return { n: 1 };
    });
    await ctx.run("b", () => {
      calls.push("b");
      return { n: 2 };
    });
  });
  const step = await replayOnce(wf, {}, { "1:a": { n: 1 }, "2:b": { n: 2 } });
  assert.equal(step.done, true);
  assert.deepEqual(calls, [], "nothing executed — pure replay to completion");
});

test("replayOnce: repeated ctx.run in a loop gets distinct ordinal keys", async () => {
  const wf = defineWorkflow("loop", async (ctx) => {
    for (let i = 0; i < 3; i++) await ctx.run("tick", () => ({ i }));
  });
  // With the first tick recorded, the frontier is the SECOND tick (2:tick).
  const step = await replayOnce(wf, {}, { "1:tick": { i: 0 } });
  assert.equal(step.done === false && step.frontier.key, "2:tick");
});

test("replayOnce: input is available and stable across replays", async () => {
  const wf = defineWorkflow("t", async (ctx) => {
    await ctx.run("useInput", () => ({ prId: ctx.input.prId }));
  });
  const step = await replayOnce(wf, { prId: "PR-1" }, {});
  assert.equal(step.done === false && (step.frontier.result as { prId: string }).prId, "PR-1");
});

test("worker: rejects two workflows that resolve to the same derived job type", () => {
  const a = defineWorkflow("dup", async () => {});
  const b = defineWorkflow("dup", async () => {});
  assert.throws(
    () => new Worker({ baseUrl: "http://localhost:0", workflows: [a, b] }),
    /duplicate derived job type "dup:__orchestrate"/,
  );
});

test("worker: distinct workflow ids register without collision", () => {
  const a = defineFlow("wf-a", (w) => w.run("step", async () => ({})));
  const b = defineFlow("wf-b", (w) => w.run("step", async () => ({})));
  const worker = new Worker({ baseUrl: "http://localhost:0", workflows: [a, b] });
  assert.deepEqual(worker.servedTypes.sort(), ["wf-a:step", "wf-b:step"]);
});

test("declarative task: external step emits a service task + job type but is NOT hosted", () => {
  const flow = defineFlow("pr-review", (w) => {
    w.run("fetchDiff", async () => ({}));
    w.task("signPdf"); // served by a worker outside this program
    w.run("merge", async () => ({}));
  });
  const xml = toBpmn(flow);
  // External `task` derives the same service task + job type as a `run`.
  assert.match(xml, /<bpmn:serviceTask id="signPdf" name="signPdf">/);
  assert.match(xml, /<zeebe:taskDefinition type="pr-review:signPdf" \/>/);
  // externalJobTypes surfaces the contract external workers must poll.
  assert.deepEqual(externalJobTypes(flow), ["pr-review:signPdf"]);
  // The local Worker hosts only the `run` steps; the external type is unhosted.
  const worker = new Worker({ baseUrl: "http://localhost:0", workflows: [flow] });
  assert.deepEqual(worker.servedTypes.sort(), ["pr-review:fetchDiff", "pr-review:merge"]);
  assert.equal(worker.servedTypes.includes("pr-review:signPdf"), false);
});

test("declarative task: an explicit jobType override replaces the derived type but keeps the element id", () => {
  const flow = defineFlow("convergence-loop", (w) => {
    w.run("persist-round", async () => ({}));
    w.task("review-round", { jobType: "senior:pr-review" });
  });
  const xml = toBpmn(flow);
  // The step name stays the BPMN element id...
  assert.match(xml, /<bpmn:serviceTask id="review-round" name="review-round">/);
  // ...but the emitted job type is the override, not `convergence-loop:review-round`.
  assert.match(xml, /<zeebe:taskDefinition type="senior:pr-review" \/>/);
  assert.doesNotMatch(xml, /type="convergence-loop:review-round"/);
  // externalJobTypes reports the override so external workers poll the right type.
  assert.deepEqual(externalJobTypes(flow), ["senior:pr-review"]);
  // A `run` step is unaffected and keeps its derived type.
  assert.match(xml, /<zeebe:taskDefinition type="convergence-loop:persist-round" \/>/);
});

test("declarative task: an invalid jobType override is rejected at authoring time", () => {
  assert.throws(
    () => defineFlow("f", (w) => w.task("t", { jobType: "bad token" })),
    /not a valid job type/,
  );
});

test("toBpmn re-validates jobType overrides on a workflow mutated outside the builder", () => {
  const flow = defineFlow("f", (w) => w.task("t", { jobType: "ok:type" }));
  // Simulate a workflow object built/mutated outside defineFlow's authoring
  // guard: toBpmn must still reject the invalid override, not emit bad XML.
  const task = (flow.steps as { kind: string; jobType?: string }[]).find((n) => n.kind === "task");
  task!.jobType = "bad token";
  assert.throws(() => toBpmn(flow), /not a valid job type/);
});

test("externalJobTypes dedupes tasks that share one override token, preserving order", () => {
  const flow = defineFlow("f", (w) => {
    w.task("a", { jobType: "senior:pr-review" });
    w.task("b", { jobType: "senior:triage" });
    w.task("c", { jobType: "senior:pr-review" });
  });
  assert.deepEqual(externalJobTypes(flow), ["senior:pr-review", "senior:triage"]);
});

test("declarative task: a duplicate task/run step name is rejected", () => {
  assert.throws(
    () =>
      defineFlow("dup", (w) => {
        w.run("a", async () => ({}));
        w.task("a");
      }),
    /duplicate step name "a"/,
  );
});

test("worker: a run step with no handler is rejected at registration (fail fast)", () => {
  // `DeclarativeFlow` is a public type; a consumer could hand-build a flow whose
  // `run` step has no handler. Registration must fail fast rather than crash on
  // the first job activation with `handler is not a function`.
  const malformed: DeclarativeFlow = {
    kind: "declarative",
    id: "broken",
    steps: [{ kind: "run", name: "a" }],
    handlers: {}, // no handler for "a"
  };
  assert.throws(
    () => new Worker({ baseUrl: "http://localhost:0", workflows: [malformed] }),
    /run step "a" has no handler/,
  );
});

test("client.signal: rejects an unknown signal name with a clear error", async () => {
  const flow = defineFlow("pr-review", (w) => {
    w.run("fetchDiff", async () => ({}));
    w.signal("humanApproval", { correlationKey: "prId" });
  });
  const client = new WorkflowClient({ baseUrl: "http://localhost:0" });
  await assert.rejects(
    () => client.signal(flow, "humanApprovel", "PR-1"),
    (e: unknown) =>
      e instanceof WorkflowError &&
      /unknown signal "humanApprovel"/.test((e as Error).message) &&
      /"humanApproval"/.test((e as Error).message),
  );
});

// --- Slice 2: control-flow combinators ---------------------------------------

test("switch: emits an exclusive gateway with a conditional edge per case + a default", () => {
  const flow = defineFlow("router", (w) => {
    w.run("classify", async () => ({}));
    w.switch("status", {
      approved: (c) => c.run("doApprove", async () => ({})),
      rejected: (c) => c.run("doReject", async () => ({})),
      default: (c) => c.run("doEscalate", async () => ({})),
    });
  });
  const xml = toBpmn(flow);
  // One gateway named for the subject.
  assert.match(xml, /<bpmn:exclusiveGateway id="Gw_0" name="status" default="f_\d+">/);
  // A FEEL equality condition per case.
  assert.match(xml, /<bpmn:conditionExpression>=status = &quot;approved&quot;<\/bpmn:conditionExpression>/);
  assert.match(xml, /<bpmn:conditionExpression>=status = &quot;rejected&quot;<\/bpmn:conditionExpression>/);
  // All three arms lead to their service tasks.
  for (const t of ["doApprove", "doReject", "doEscalate"]) {
    assert.match(xml, new RegExp(`<bpmn:serviceTask id="${t}"`));
    assert.match(xml, new RegExp(`<zeebe:taskDefinition type="router:${t}" \\/>`));
  }
});

test("switch: requires at least one non-default case", () => {
  assert.throws(
    () =>
      defineFlow("f", (w) => {
        w.run("a", async () => ({}));
        // @ts-expect-error a switch with only a default is meaningless
        w.switch("x", { default: (c) => c.run("b", async () => ({})) });
      }),
    /needs at least one case/,
  );
});

test("switch: a runtime-invalid default arm is rejected with a helpful error", () => {
  assert.throws(
    () =>
      defineFlow("f", (w) => {
        w.run("a", async () => ({}));
        // A JS/JSON-derived config could pass a non-function default; it must
        // fail with the builder's own message, not an opaque TypeError.
        const bogus = JSON.parse('{"default":"not a block"}');
        bogus.active = (c) => c.run("b", async () => ({}));
        w.switch("x", bogus);
      }),
    /switch\("x"\) default must be a block/,
  );
});

test("branch: then is guarded by the condition, else is the gateway default", () => {
  const flow = defineFlow("guard", (w) => {
    w.run("check", async () => ({}));
    w.branch("count >= 3", {
      then: (g) => g.run("tooMany", async () => ({})),
      else: (g) => g.run("again", async () => ({})),
    });
  });
  const xml = toBpmn(flow);
  assert.match(xml, /<bpmn:exclusiveGateway id="Gw_0" default="f_\d+">/);
  assert.match(xml, /<bpmn:conditionExpression>=count &gt;= 3<\/bpmn:conditionExpression>/);
  assert.match(xml, /<bpmn:serviceTask id="tooMany"/);
  assert.match(xml, /<bpmn:serviceTask id="again"/);
});

test("branch: a runtime-invalid else arm is rejected with a helpful error", () => {
  assert.throws(
    () =>
      defineFlow("f", (w) => {
        w.run("a", async () => ({}));
        const bogus = JSON.parse('{"then":null,"else":"not a block"}');
        // then must still be caught first; make it a real block so we exercise else.
        bogus.then = (g) => g.run("t", async () => ({}));
        w.branch("count >= 3", bogus);
      }),
    /branch\("count >= 3"\) else arm must be a block/,
  );
});

test("loop: the body falls through back to the loop head; break exits to End", () => {
  const flow = defineFlow("poll", (w) => {
    w.loop((b) => {
      b.run("attempt", async () => ({}));
      b.branch("done", {
        then: (g) => g.break(),
        else: (g) => g.run("wait", async () => ({})),
      });
    });
  });
  const xml = toBpmn(flow);
  // A convergent loop-head gateway exists.
  assert.match(xml, /<bpmn:exclusiveGateway id="Loop_0">/);
  // The "attempt" task's outgoing eventually targets the branch gateway, and the
  // else arm ("wait") falls through back to the loop head (a back-edge).
  const back = xml.match(/<bpmn:sequenceFlow id="f_\d+" sourceRef="wait" targetRef="Loop_0" \/>/);
  assert.ok(back, "wait must loop back to the loop head");
  // The break arm's edge (from the branch gateway's then) reaches End.
  assert.match(xml, /<bpmn:endEvent id="End">/);
  assert.match(xml, /targetRef="End"/);
});

test("break/continue: rejected outside a loop", () => {
  assert.throws(
    () => defineFlow("f", (w) => w.break()),
    /break\(\) is only valid inside a loop/,
  );
  assert.throws(
    () => defineFlow("f", (w) => w.continue()),
    /continue\(\) is only valid inside a loop/,
  );
});

test("continue: jumps straight back to the loop head", () => {
  const flow = defineFlow("c", (w) => {
    w.loop((b) => {
      b.run("tick", async () => ({}));
      b.branch("retry", {
        then: (g) => g.continue(),
        else: (g) => g.break(),
      });
    });
  });
  const xml = toBpmn(flow);
  // continue routes the branch's then edge (a conditional flow) back to the head.
  assert.match(xml, /<bpmn:sequenceFlow id="f_\d+" sourceRef="Gw_1" targetRef="Loop_0" name="then">/);
});

// --- Slice 2: typed data envelopes lifted into the model ---------------------

test("envelope: referenced shapes are lifted to nano:shapes + dataEnvelope props", () => {
  const OrderIn = envelope("OrderIn", {
    orderId: "string",
    total: "number",
    lines: { type: "integer", list: true },
    note: { type: "string", optional: true },
  });
  const OrderOut = envelope("OrderOut", { ok: "boolean" });
  const flow = defineFlow(
    "orders",
    { charge: { in: OrderIn, out: OrderOut } },
    (w) => w.run("charge", async () => ({ ok: true })),
  );
  const xml = toBpmn(flow);
  // The shape container is lifted onto the process.
  assert.match(xml, /<nano:shapes>/);
  assert.match(xml, /<nano:shape id="OrderIn">/);
  assert.match(xml, /<nano:extend name="orderId" type="string" \/>/);
  assert.match(xml, /<nano:extend name="lines" type="integer" list="true" \/>/);
  assert.match(xml, /<nano:extend name="note" type="string" optional="true" \/>/);
  assert.match(xml, /<nano:shape id="OrderOut">/);
  // The service task carries the dataEnvelope wiring.
  assert.match(xml, /<zeebe:property name="io.nanobpm.dataEnvelope.in" value="OrderIn" \/>/);
  assert.match(xml, /<zeebe:property name="io.nanobpm.dataEnvelope.out" value="OrderOut" \/>/);
  // The nano namespace is declared.
  assert.match(xml, /xmlns:nano="https:\/\/nanobpm.io\/schema\/shapes\/1.0"/);
});

test("envelope: an unreferenced envelope is NOT lifted (only used shapes appear)", () => {
  const Used = envelope("Used", { a: "string" });
  const flow = defineFlow("f", { s: { in: Used } }, (w) => w.run("s", async () => ({})));
  const xml = toBpmn(flow);
  assert.match(xml, /<nano:shape id="Used">/);
  assert.doesNotMatch(xml, /Unused/);
});

test("signal: a typed payload envelope is lifted onto the message", () => {
  const Answer = envelope("Answer", { verdict: "string" });
  const flow = defineFlow(
    "ask",
    { waitAnswer: { in: Answer } },
    (w) => {
      w.run("prepare", async () => ({}));
      w.signal("waitAnswer", { correlationKey: "caseId" });
    },
  );
  const xml = toBpmn(flow);
  assert.match(xml, /<bpmn:message id="Msg_waitAnswer" name="ask:waitAnswer">/);
  assert.match(xml, /<zeebe:subscription correlationKey="=caseId" \/>/);
  assert.match(xml, /<zeebe:property name="io.nanobpm.dataEnvelope.in" value="Answer" \/>/);
  assert.match(xml, /<nano:shape id="Answer">/);
});

// --- Slice 2: the urban-pr-review convergence loop (golden model) ------------

test("urban golden: a loop wrapping a status switch with a nested guard compiles", () => {
  const ReviewRoundIn = envelope("ReviewRoundIn", {
    prKey: "string",
    prompt: "string",
    round: "integer",
    maxRounds: "integer",
  });
  const ReviewRoundOut = envelope("ReviewRoundOut", { status: "string" });
  const RoundState = envelope("RoundState", { round: "integer" });
  const ReviewReady = envelope("ReviewReady", { reviewId: "string" });
  const EscalationAnswered = envelope("EscalationAnswered", { answer: "string" });

  const convergence = defineFlow(
    "convergence-loop",
    {
      "review-round": { in: ReviewRoundIn, out: ReviewRoundOut },
      "persist-round": { out: RoundState },
      "wait-review": { in: ReviewReady },
      "wait-answer": { in: EscalationAnswered },
      "wait-answer-max": { in: EscalationAnswered },
    },
    (w) => {
      w.loop((b) => {
        b.run("review-round", async () => ({ status: "addressed" }));
        b.switch("status", {
          converged: (c) => {
            c.run("persist-converged", async () => ({}));
            c.break();
          },
          addressed: (c) =>
            c.branch("round >= maxRounds", {
              then: (g) => {
                g.run("persist-escalation-maxrounds", async () => ({}));
                g.signal("wait-answer-max", { correlationKey: "prKey" });
              },
              else: (g) => {
                g.run("persist-round", async () => ({ round: 1 }));
                g.signal("wait-review", { correlationKey: "prKey" });
              },
            }),
          default: (c) => {
            c.run("persist-escalation", async () => ({}));
            c.signal("wait-answer", { correlationKey: "prKey" });
          },
        });
      });
    },
  );

  const xml = toBpmn(convergence);

  // The status switch: a gateway with a case edge per terminal status.
  assert.match(xml, /<bpmn:exclusiveGateway id="Gw_\d+" name="status" default="f_\d+">/);
  assert.match(xml, /=status = &quot;converged&quot;/);
  assert.match(xml, /=status = &quot;addressed&quot;/);

  // The nested max-rounds guard.
  assert.match(xml, /=round &gt;= maxRounds/);

  // The two durable waits (correlated on prKey) plus their payload shapes.
  assert.match(xml, /<bpmn:intermediateCatchEvent id="wait-review"/);
  assert.match(xml, /<bpmn:intermediateCatchEvent id="wait-answer"/);
  assert.match(xml, /<zeebe:subscription correlationKey="=prKey" \/>/);
  assert.match(xml, /<nano:shape id="ReviewReady">/);
  assert.match(xml, /<nano:shape id="EscalationAnswered">/);

  // The loop back-edges: both waits and the addressed persist path re-enter the
  // loop head (the review-round runs again after a wait resumes).
  assert.match(xml, /sourceRef="wait-review" targetRef="Loop_0" \/>/);
  assert.match(xml, /sourceRef="wait-answer" targetRef="Loop_0" \/>/);
  assert.match(xml, /sourceRef="wait-answer-max" targetRef="Loop_0" \/>/);

  // review-round is the loop head's downstream task and carries its typed I/O.
  assert.match(xml, /<zeebe:property name="io.nanobpm.dataEnvelope.in" value="ReviewRoundIn" \/>/);
  assert.match(xml, /<zeebe:property name="io.nanobpm.dataEnvelope.out" value="ReviewRoundOut" \/>/);

  // The converged path breaks out of the loop to End.
  assert.match(xml, /<bpmn:serviceTask id="persist-converged"/);
  assert.match(xml, /<bpmn:endEvent id="End">/);

  // The Worker hosts every run step; the derived types are the workers' contract.
  const worker = new Worker({ baseUrl: "http://localhost:0", workflows: [convergence] });
  assert.ok(worker.servedTypes.includes("convergence-loop:review-round"));
  assert.ok(worker.servedTypes.includes("convergence-loop:persist-converged"));
  assert.ok(worker.servedTypes.includes("convergence-loop:persist-round"));
});

// --- Slice 2: review hardening -----------------------------------------------

test("client.signal: accepts a signal nested inside a switch/branch/loop", async () => {
  const flow = defineFlow("nested", (w) => {
    w.run("start", async () => ({}));
    w.loop((b) => {
      b.run("attempt", async () => ({}));
      b.branch("done", {
        then: (g) => g.break(),
        else: (g) => g.signal("waitReview", { correlationKey: "prKey" }),
      });
    });
  });
  const client = new WorkflowClient({ baseUrl: "http://localhost:0" });
  // The nested signal name is discovered via walkNodes, so it is NOT rejected as
  // unknown; the call fails only when the (unreachable) gateway is dialed.
  await assert.rejects(
    () => client.signal(flow, "waitReview", "PR-1"),
    (e: unknown) => !(e instanceof WorkflowError && /unknown signal/.test((e as Error).message)),
  );
  // A genuine typo is still rejected fast.
  await assert.rejects(
    () => client.signal(flow, "waitReviwe", "PR-1"),
    /unknown signal "waitReviwe"/,
  );
});

test("defineFlow: rejects a non-object contracts arg and a missing build callback", () => {
  // @ts-expect-error contracts must be an object
  assert.throws(() => defineFlow("f", null, (w) => w.run("a", async () => ({}))), /contracts argument must be an object/);
  // @ts-expect-error build callback is required
  assert.throws(() => defineFlow("f", { a: {} }), /build callback .* is required/);
});

test("defineFlow: rejects step names that collide with generated BPMN ids", () => {
  for (const bad of ["Start", "End", "Gw_0", "Loop_0", "Sub_0", "Msg_x", "f_0"]) {
    assert.throws(
      () => defineFlow("wf", (w) => w.run(bad, async () => ({}))),
      /reserved/,
      `"${bad}" must be rejected`,
    );
  }
  // A step named the same as the workflow id collides with the process id.
  assert.throws(() => defineFlow("wf", (w) => w.run("wf", async () => ({}))), /reserved/);
});

test("envelope: rejects a null/invalid field spec with a clear error (not a TypeError)", () => {
  assert.throws(
    // @ts-expect-error null is not a valid field spec
    () => envelope("Bad", { a: null }),
    /must be a scalar type or a \{ type, optional\?, list\? \} object/,
  );
});

// --- Parallelism primitives: w.parallel (AND fork/join) + w.forEach (MI) ------

test("declarative emit: parallel emits a fork/join parallel-gateway pair, one branch each", () => {
  const flow = defineFlow("fan", (w) => {
    w.task("prep");
    w.parallel([(b) => b.task("lint"), (b) => b.task("test"), (b) => b.task("build")]);
    w.task("report");
  });
  const xml = toBpmn(flow);
  // Exactly two parallel gateways (a diverging split + a converging join); no
  // exclusive gateways are emitted for a parallel block.
  assert.equal((xml.match(/<bpmn:parallelGateway /g) ?? []).length, 2);
  assert.doesNotMatch(xml, /<bpmn:exclusiveGateway /);
  // The split (Gw_0) fans out to all three branches; the join (Gw_1) collects them.
  assert.equal((xml.match(/sourceRef="Gw_0"/g) ?? []).length, 3);
  assert.equal((xml.match(/targetRef="Gw_1"/g) ?? []).length, 3);
  // A parallel branch's flows carry NO condition (unlike switch/branch arms).
  assert.doesNotMatch(xml, /sourceRef="Gw_0"[^>]*>\s*<bpmn:conditionExpression/);
  // prep feeds the split; the join feeds report.
  assert.match(xml, /sourceRef="prep" targetRef="Gw_0"/);
  assert.match(xml, /sourceRef="Gw_1" targetRef="report"/);
});

test("declarative emit: parallel requires at least two branches", () => {
  assert.throws(() => defineFlow("f", (w) => w.parallel([(b) => b.task("a")])), /at least two branch/);
  // @ts-expect-error a non-array is rejected
  assert.throws(() => defineFlow("f", (w) => w.parallel("nope")), /at least two branch/);
});

test("declarative emit: forEach over a single task lifts a PARALLEL multi-instance onto it", () => {
  const flow = defineFlow("fanout", (w) => {
    w.task("plan");
    w.forEach("plan.items", "item", (b) => b.task("handle"));
    w.task("done");
  });
  const xml = toBpmn(flow);
  // No sub-process for a single-activity body: the MI rides the service task.
  assert.doesNotMatch(xml, /<bpmn:subProcess/);
  assert.match(xml, /<bpmn:serviceTask id="handle"[\s\S]*?<bpmn:multiInstanceLoopCharacteristics isSequential="false">/);
  assert.match(xml, /<zeebe:loopCharacteristics inputCollection="=plan\.items" inputElement="item" \/>/);
  // The MI activity is wired inline between plan and done.
  assert.match(xml, /sourceRef="plan" targetRef="handle"/);
  assert.match(xml, /sourceRef="handle" targetRef="done"/);
});

test("declarative emit: forEach { sequential } emits a sequential multi-instance", () => {
  const flow = defineFlow("seq", (w) => w.forEach("xs", "x", (b) => b.task("step"), { sequential: true }));
  assert.match(toBpmn(flow), /<bpmn:multiInstanceLoopCharacteristics isSequential="true">/);
});

test("declarative emit: forEach collects an output collection with an output element", () => {
  const flow = defineFlow("collect", (w) =>
    w.forEach("items", "item", (b) => b.task("double"), { outputCollection: "results", outputElement: "double.value" }),
  );
  const xml = toBpmn(flow);
  assert.match(
    xml,
    /<zeebe:loopCharacteristics inputCollection="=items" inputElement="item" outputCollection="results" outputElement="=double\.value" \/>/,
  );
});

test("declarative emit: forEach { completionCondition } lifts a FEEL completion condition", () => {
  const flow = defineFlow("early", (w) =>
    w.forEach("items", "item", (b) => b.task("try"), { completionCondition: "count(results) >= 2" }),
  );
  assert.match(toBpmn(flow), /<bpmn:completionCondition>=count\(results\) &gt;= 2<\/bpmn:completionCondition>/);
});

test("declarative emit: a multi-step forEach body becomes an embedded multi-instance sub-process", () => {
  const flow = defineFlow("waves", (w) => {
    w.task("plan");
    w.forEach("agents", "a", (b) => {
      b.task("spawn");
      b.task("collect");
    });
    w.task("report");
  });
  const xml = toBpmn(flow);
  // The body is wrapped in a sub-process carrying the MI characteristics, with
  // its own start/end and both inner tasks nested inside it.
  assert.match(xml, /<bpmn:subProcess id="Sub_0">[\s\S]*<bpmn:multiInstanceLoopCharacteristics isSequential="false">/);
  assert.match(xml, /<bpmn:startEvent id="Sub_0_start">/);
  assert.match(xml, /<bpmn:endEvent id="Sub_0_end">/);
  assert.match(xml, /<bpmn:serviceTask id="spawn"/);
  assert.match(xml, /<bpmn:serviceTask id="collect"/);
  // The sub-process is wired inline at the top level between plan and report.
  assert.match(xml, /sourceRef="plan" targetRef="Sub_0"/);
  assert.match(xml, /sourceRef="Sub_0" targetRef="report"/);
});

test("declarative emit: forEach validates its inputs", () => {
  assert.throws(() => defineFlow("f", (w) => w.forEach("", "x", (b) => b.task("a"))), /non-empty FEEL collection/);
  assert.throws(() => defineFlow("f", (w) => w.forEach("xs", "1bad", (b) => b.task("a"))), /forEach itemVar/);
  assert.throws(() => defineFlow("f", (w) => w.forEach("xs", "x", () => {})), /declared no steps/);
  assert.throws(
    () => defineFlow("f", (w) => w.forEach("xs", "x", (b) => b.task("a"), { outputElement: "a.v" })),
    /outputElement needs an outputCollection/,
  );
});

test("declarative emit: break/continue cannot cross a forEach scope boundary", () => {
  // A forEach body runs in its own token scope (the MI sub-process), so the
  // enclosing loop is unreachable from inside it.
  assert.throws(
    () =>
      defineFlow("f", (w) =>
        w.loop((l) => {
          l.forEach("xs", "x", (b) => {
            b.task("a");
            b.break();
          });
        }),
      ),
    /break\(\) is only valid inside a loop/,
  );
});
