import { test } from "node:test";
import assert from "node:assert/strict";
import {
  planWorkerScaffold,
  renderWorkerStub,
  slugifyTaskType,
  type ScaffoldWorker,
} from "./workers.ts";
import type { ModelSource } from "../derivers/worker-io.ts";
import { detectJsonIndent, scaffoldWorkers } from "../scaffold.ts";
import type { GenIO } from "../gen.ts";

// A service task with a data-envelope in/out contract; `type` is the taskType, and the
// io.nanobpm.dataEnvelope.in/out zeebe:property carry the envelope type ids.
function serviceTask(id: string, taskType: string, inType?: string, outType?: string): string {
  const props = [
    inType ? `<zeebe:property name="io.nanobpm.dataEnvelope.in" value="${inType}" />` : "",
    outType ? `<zeebe:property name="io.nanobpm.dataEnvelope.out" value="${outType}" />` : "",
  ].join("");
  return `<bpmn:serviceTask id="${id}"><bpmn:extensionElements>
      <zeebe:taskDefinition type="${taskType}" />
      ${props ? `<zeebe:taskHeaders>${props}</zeebe:taskHeaders>` : ""}
    </bpmn:extensionElements></bpmn:serviceTask>`;
}

function model(path: string, procId: string, ...tasks: string[]): ModelSource {
  return {
    path,
    xml: `<bpmn:process id="${procId}" xmlns:bpmn="x" xmlns:zeebe="y">
      ${tasks.join("\n")}
    </bpmn:process>`,
  };
}

test("slugifyTaskType makes a filesystem-safe slug", () => {
  assert.equal(slugifyTaskType("pr.finalize"), "pr-finalize");
  assert.equal(slugifyTaskType("Orders::Charge Card!"), "orders-charge-card");
  assert.equal(slugifyTaskType("---"), "worker");
});

test("typed in+out stub imports both symbols and parameterises the handler", () => {
  const stub = renderWorkerStub("pr.finalize", true, true);
  assert.match(stub, /import type \{ AppJobHandler \} from "@nanobpm\/urban\/worker";/);
  assert.match(stub, /import type \{ WorkerInputs, WorkerOutputs \} from "\.\.\/\.\.\/nano-generated\/worker-io\.d\.ts";/);
  assert.match(stub, /AppJobHandler<WorkerInputs\["pr\.finalize"\], WorkerOutputs\["pr\.finalize"\]>/);
  assert.match(stub, /export default handler;/);
  assert.match(stub, /throw new Error\("worker not implemented: pr\.finalize"\)/);
});

test("untyped stub imports no generated types and uses bare AppJobHandler", () => {
  const stub = renderWorkerStub("demo.do", false, false);
  assert.doesNotMatch(stub, /worker-io\.d\.ts/);
  assert.match(stub, /const handler: AppJobHandler = async \(job, app\) =>/);
});

test("stub is lint-clean under the scaffold config: tab-indented, both params referenced", () => {
  // Guards the two ways `urban gen`'s stub used to fail a fresh scaffold's own `biome check`
  // (nano-ide#451): space indentation (Biome defaults to tabs) and unused `job`/`app` params
  // (correctness/noUnusedFunctionParameters). Body lines must be tab-indented and both params
  // must be read before the author fills in the body.
  const stub = renderWorkerStub("greet.hello", false, false);
  const bodyLines = stub.split("\n").filter((l) => l.startsWith(" ") || l.startsWith("\t"));
  assert.ok(bodyLines.length > 0, "the stub has an indented body");
  for (const line of bodyLines) {
    assert.ok(line.startsWith("\t"), `body line is tab-indented, not space-indented: ${line}`);
  }
  assert.match(stub, /app\.log\.warn\("worker not implemented", \{ jobKey: job\.jobKey \}\)/);
});

test("detectJsonIndent reuses tab/space width but clamps to JSON.stringify's 10-char cap", () => {
  assert.equal(detectJsonIndent('{\n\t"a": 1\n}'), "\t");
  assert.equal(detectJsonIndent('{\n  "a": 1\n}'), "  ");
  assert.equal(detectJsonIndent("{}"), "\t", "no indentation falls back to a tab");
  // JSON.stringify silently truncates a string `space` to 10 chars, so a wider space indent must
  // be clamped rather than promising a fidelity the serializer cannot honor.
  const wide = `{\n${" ".repeat(12)}"a": 1\n}`;
  const indent = detectJsonIndent(wide);
  assert.equal(indent, " ".repeat(10));
  assert.equal(JSON.stringify({ a: 1 }, null, indent), JSON.stringify({ a: 1 }, null, wide.match(/\n( +)/)?.[1]));
});

test("typed-out-only stub fills In with the open default", () => {
  const stub = renderWorkerStub("demo.out", false, true);
  assert.match(stub, /import type \{ WorkerOutputs \} from/);
  assert.match(stub, /AppJobHandler<Record<string, unknown>, WorkerOutputs\["demo\.out"\]>/);
});

test("planWorkerScaffold: typed vs untyped from declared types", () => {
  const m = model(
    "a.bpmn",
    "orders",
    serviceTask("A", "orders.charge", "ChargeIn", "ChargeOut"),
    serviceTask("B", "orders.ship"),
  );
  const { plans } = planWorkerScaffold([m], [], ["ChargeIn", "ChargeOut"]);
  assert.equal(plans.length, 2);
  const charge = plans.find((p) => p.taskType === "orders.charge")!;
  assert.equal(charge.typedIn, true);
  assert.equal(charge.typedOut, true);
  assert.equal(charge.handlerPath, "workers/orders-charge/worker.ts");
  assert.deepEqual(charge.manifestEntry, { taskType: "orders.charge", handler: "workers/orders-charge/worker.ts" });
  const ship = plans.find((p) => p.taskType === "orders.ship")!;
  assert.equal(ship.typedIn, false);
  assert.equal(ship.typedOut, false);
});

test("planWorkerScaffold: an in/out that is not a declared type stays untyped", () => {
  const m = model("a.bpmn", "p", serviceTask("A", "t.a", "Undeclared", "AlsoUndeclared"));
  const { plans } = planWorkerScaffold([m], [], ["SomethingElse"]);
  assert.equal(plans[0].typedIn, false);
  assert.equal(plans[0].typedOut, false);
});

test("planWorkerScaffold: skips already-wired, orchestrator, and duplicates", () => {
  const wired: ScaffoldWorker[] = [{ taskType: "t.wired", handler: "workers/x/worker.ts" }];
  const models = [
    model("a.bpmn", "p1", serviceTask("A", "t.wired"), serviceTask("B", "t.new"), serviceTask("O", "wf:__orchestrate")),
    model("b.bpmn", "p2", serviceTask("C", "t.new")), // duplicate taskType across models
  ];
  const { plans, skipped } = planWorkerScaffold(models, wired, []);
  assert.deepEqual(plans.map((p) => p.taskType), ["t.new"]);
  const reasons = Object.fromEntries(skipped.map((s) => [s.taskType, s.reason]));
  assert.equal(reasons["t.wired"], "already-wired");
  assert.equal(reasons["wf:__orchestrate"], "orchestrator");
  assert.equal(reasons["t.new"], "duplicate");
});

test("planWorkerScaffold: skips a task type declared external (out-of-process worker)", () => {
  const models = [
    model("a.bpmn", "p1", serviceTask("A", "senior:review"), serviceTask("B", "t.new")),
  ];
  const { plans, skipped } = planWorkerScaffold(models, [], [], ["senior:review"]);
  assert.deepEqual(plans.map((p) => p.taskType), ["t.new"]);
  const reasons = Object.fromEntries(skipped.map((s) => [s.taskType, s.reason]));
  assert.equal(reasons["senior:review"], "external");
});

test("planWorkerScaffold: colliding slugs get a numeric suffix", () => {
  const m = model("a.bpmn", "p", serviceTask("A", "orders.charge"), serviceTask("B", "orders-charge"));
  const { plans } = planWorkerScaffold([m], [], []);
  const slugs = plans.map((p) => p.slug).sort();
  assert.deepEqual(slugs, ["orders-charge", "orders-charge-2"]);
});

// ── runner (impure edge, in-memory IO) ──────────────────────────────────────────────────

function memIO(files: Record<string, string>): GenIO & { files: Record<string, string> } {
  return {
    files,
    async readText(p) {
      if (!(p in files)) throw new Error(`ENOENT ${p}`);
      return files[p];
    },
    async writeText(p, c) {
      files[p] = c;
    },
    async listDir(p) {
      const prefix = p.replace(/\/+$/, "") + "/";
      const names = new Set<string>();
      for (const f of Object.keys(files)) {
        if (f.startsWith(prefix)) {
          const rest = f.slice(prefix.length);
          if (!rest.includes("/")) names.add(rest);
        }
      }
      return [...names];
    },
    async exists(p) {
      return p in files;
    },
  };
}

function appFixture(): Record<string, string> {
  return {
    "/app/nano.app.json": JSON.stringify({
      id: "demo",
      models: { processes: ["processes/*.bpmn"] },
      workers: [{ taskType: "t.wired", handler: "workers/wired/worker.ts" }],
    }),
    "/app/processes/p.bpmn": model("p.bpmn", "p",
      serviceTask("A", "t.new"),
      serviceTask("B", "t.wired"),
    ).xml,
  };
}

test("scaffoldWorkers dry-run writes nothing and reports would-create", async () => {
  const io = memIO(appFixture());
  const before = Object.keys(io.files).length;
  const run = await scaffoldWorkers({ root: "/app", io });
  assert.equal(run.write, false);
  assert.equal(Object.keys(io.files).length, before, "dry-run must not write");
  assert.deepEqual(run.outcomes.map((o) => o.status), ["would-create"]);
  assert.equal(run.outcomes[0].taskType, "t.new");
  assert.equal(run.manifestPatched, false);
  assert.ok(run.skipped.some((s) => s.taskType === "t.wired" && s.reason === "already-wired"));
});

test("scaffoldWorkers --write creates the stub and patches the manifest once", async () => {
  const io = memIO(appFixture());
  const run = await scaffoldWorkers({ root: "/app", io, write: true });
  assert.equal(run.outcomes[0].status, "created");
  const stub = io.files["/app/workers/t-new/worker.ts"];
  assert.ok(stub, "stub file written");
  assert.match(stub, /worker not implemented: t\.new/);
  const manifest = JSON.parse(io.files["/app/nano.app.json"]);
  assert.deepEqual(manifest.workers.map((w: { taskType: string }) => w.taskType), ["t.wired", "t.new"]);
  assert.ok(io.files["/app/nano.app.json"].endsWith("\n"), "manifest ends with newline");
});

test("scaffoldWorkers preserves the manifest's own indentation when wiring (nano-ide#451)", async () => {
  // `urban gen` used to reserialize nano.app.json with a hard-coded 2-space indent, clobbering
  // the tab-indented scaffold and breaking its own `biome check`. The patch must round-trip the
  // file's existing indentation instead.
  for (const indent of ["\t", "  "]) {
    const files = appFixture();
    files["/app/nano.app.json"] = `${JSON.stringify(JSON.parse(files["/app/nano.app.json"]), null, indent)}\n`;
    const io = memIO(files);
    await scaffoldWorkers({ root: "/app", io, write: true });
    const patched = io.files["/app/nano.app.json"];
    const firstIndent = patched.match(/\n([ \t]+)\S/)?.[1];
    assert.equal(firstIndent, indent, `indentation preserved (${JSON.stringify(indent)})`);
  }
});

test("scaffoldWorkers never clobbers an existing stub (keeps it), still wires it", async () => {
  const files = appFixture();
  files["/app/workers/t-new/worker.ts"] = "// hand-edited, do not touch\n";
  const io = memIO(files);
  const run = await scaffoldWorkers({ root: "/app", io, write: true });
  assert.equal(run.outcomes[0].status, "kept");
  assert.equal(io.files["/app/workers/t-new/worker.ts"], "// hand-edited, do not touch\n");
  const manifest = JSON.parse(io.files["/app/nano.app.json"]);
  assert.ok(manifest.workers.some((w: { taskType: string }) => w.taskType === "t.new"), "orphan stub gets wired");
});

test("scaffoldWorkers is idempotent: a second --write run is a no-op", async () => {
  const io = memIO(appFixture());
  await scaffoldWorkers({ root: "/app", io, write: true });
  const snapshot = JSON.stringify(io.files);
  const run2 = await scaffoldWorkers({ root: "/app", io, write: true });
  // t.new is now wired in the manifest, so the planner skips it entirely (nothing to do).
  assert.deepEqual(run2.outcomes, []);
  assert.ok(run2.skipped.some((s) => s.taskType === "t.new" && s.reason === "already-wired"));
  assert.equal(run2.manifestPatched, false, "no new wiring on the second run");
  assert.equal(JSON.stringify(io.files), snapshot, "files unchanged on re-run");
});

test("scaffoldWorkers reads manifest.externalTaskTypes and skips those (never scaffolds/wires)", async () => {
  const files = {
    "/app/nano.app.json": JSON.stringify({
      id: "demo",
      models: { processes: ["processes/*.bpmn"] },
      externalTaskTypes: ["senior:review"],
    }),
    "/app/processes/p.bpmn": model("p.bpmn", "p",
      serviceTask("A", "senior:review"),
      serviceTask("B", "t.new"),
    ).xml,
  };
  const io = memIO(files);
  const run = await scaffoldWorkers({ root: "/app", io, write: true });
  // Only the app-hosted task is scaffolded; the external one is skipped.
  assert.deepEqual(run.outcomes.map((o) => o.taskType), ["t.new"]);
  assert.ok(run.skipped.some((s) => s.taskType === "senior:review" && s.reason === "external"));
  assert.equal(io.files["/app/workers/senior-review/worker.ts"], undefined, "external task gets no stub");
  const manifest = JSON.parse(io.files["/app/nano.app.json"]);
  assert.ok(
    !manifest.workers?.some((w: { taskType: string }) => w.taskType === "senior:review"),
    "external task is never wired into workers[]",
  );
});
