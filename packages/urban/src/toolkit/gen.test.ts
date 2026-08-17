import { test } from "node:test";
import assert from "node:assert/strict";
import { runGen, collectArtifacts, readModels, type GenIO } from "./gen.ts";
import { defineFlow, envelope } from "@nanobpm/workflow";
import { MODEL_PROVENANCE } from "./models.ts";

/** In-memory filesystem for deterministic, IO-free gen tests. */
function memIO(
  files: Record<string, string>,
  modules: Record<string, Record<string, unknown>> = {},
): GenIO & { files: Record<string, string> } {
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
    async listSubdirs(p) {
      const prefix = p.replace(/\/+$/, "") + "/";
      const names = new Set<string>();
      for (const f of Object.keys(files)) {
        if (f.startsWith(prefix)) {
          const rest = f.slice(prefix.length);
          const slash = rest.indexOf("/");
          if (slash > 0) names.add(rest.slice(0, slash));
        }
      }
      return [...names];
    },
    async exists(p) {
      return p in files;
    },
    async remove(p) {
      delete files[p];
    },
    async importModule(p) {
      if (!(p in modules)) throw new Error(`no module registered for ${p}`);
      return modules[p];
    },
  };
}

const MANIFEST = JSON.stringify({
  id: "demo",
  data: { default: "app" },
  models: { processes: ["processes/*.bpmn"] },
  types: { greeting: { table: "greetings", fields: { who: { type: "string" } } } },
});

const BPMN = `<bpmn:process id="p" xmlns:bpmn="x" xmlns:zeebe="y">
  <bpmn:serviceTask id="T"><bpmn:extensionElements>
    <zeebe:taskDefinition type="demo.do" />
  </bpmn:extensionElements></bpmn:serviceTask>
</bpmn:process>`;

function fixture(): Record<string, string> {
  return {
    "/app/nano.app.json": MANIFEST,
    "/app/processes/p.bpmn": BPMN,
  };
}

test("runGen writes migrations, the worker index, the meta accessor, the message map, and the system brief", async () => {
  const io = memIO(fixture());
  const res = await runGen({ root: "/app", io });
  const paths = res.artifacts.map((a) => a.path).sort();
  assert.deepEqual(paths, [
    "nano-generated/app.schema.sql",
    "nano-generated/domain-rows.d.ts",
    "nano-generated/message-io.d.ts",
    "nano-generated/meta.ts",
    "nano-generated/system-brief.json",
    "nano-generated/system-brief.md",
    "nano-generated/worker-io.d.ts",
  ]);
  assert.ok(io.files["/app/nano-generated/app.schema.sql"].includes("CREATE TABLE"));
  assert.ok(io.files["/app/nano-generated/worker-io.d.ts"].includes("demo.do"));
  assert.ok(io.files["/app/nano-generated/meta.ts"].includes("export function meta"));
  assert.ok(io.files["/app/nano-generated/message-io.d.ts"].includes("export type MessageName"));
  assert.ok(io.files["/app/nano-generated/domain-rows.d.ts"].includes('"greetings": Greetings;'));
  assert.ok(io.files["/app/nano-generated/domain-rows.d.ts"].includes('"greeting": {'));
  // The system brief threads the app id from the manifest and folds the process + call graph.
  assert.ok(io.files["/app/nano-generated/system-brief.md"].includes("# demo — system brief"));
  assert.ok(io.files["/app/nano-generated/system-brief.md"].includes("demo.do"));
  const brief = JSON.parse(io.files["/app/nano-generated/system-brief.json"]);
  assert.equal(brief.app, "demo");
  assert.deepEqual(brief.processes, ["p"]);
  assert.equal(brief.workers[0].taskType, "demo.do");
});

test("the system brief is drift-checked and swept like its sibling artifacts", async () => {
  const io = memIO(fixture());
  await runGen({ root: "/app", io });
  // Drift gate owns the brief: a hand-edit is reported by --check.
  io.files["/app/nano-generated/system-brief.json"] = "{ tampered: true }";
  const check = await runGen({ root: "/app", io, check: true });
  assert.ok(check.drift.includes("nano-generated/system-brief.json"), "brief drift is reported");
  // Stale sweep owns the brief: a renamed-away brief artifact is removed on the next write.
  io.files["/app/nano-generated/system-brief.old.md"] = "# stale brief";
  const res = await runGen({ root: "/app", io });
  assert.ok(res.swept.includes("nano-generated/system-brief.old.md"), "stale brief swept");
  assert.ok("/app/nano-generated/system-brief.md" in io.files, "fresh brief kept");
});

test("gen --check reports no drift right after a write", async () => {
  const io = memIO(fixture());
  await runGen({ root: "/app", io });
  const res = await runGen({ root: "/app", io, check: true });
  assert.deepEqual(res.drift, []);
});

test("gen --check detects drift when a generated file is stale", async () => {
  const io = memIO(fixture());
  await runGen({ root: "/app", io });
  io.files["/app/nano-generated/worker-io.d.ts"] = "// stale";
  const res = await runGen({ root: "/app", io, check: true });
  assert.deepEqual(res.drift, ["nano-generated/worker-io.d.ts"]);
});

test("collectArtifacts touches no writes", async () => {
  const io = memIO(fixture());
  const before = Object.keys(io.files).length;
  await collectArtifacts({ root: "/app", io });
  assert.equal(Object.keys(io.files).length, before);
});

test("runGen sweeps stale files from nano-generated/ (write mode)", async () => {
  const io = memIO(fixture());
  // A stale artifact left by a prior gen (e.g. a renamed `data_sdk.ts` orphan) that this run does
  // not re-emit. It must be removed so the app can't import a dead generated module.
  io.files["/app/nano-generated/data_sdk.ts"] = "// stale, renamed away";
  io.files["/app/nano-generated/old-worker-io.d.ts"] = "// stale";
  const res = await runGen({ root: "/app", io });
  assert.deepEqual(res.swept, [
    "nano-generated/data_sdk.ts",
    "nano-generated/old-worker-io.d.ts",
  ]);
  assert.ok(!("/app/nano-generated/data_sdk.ts" in io.files), "stale file removed");
  assert.ok(!("/app/nano-generated/old-worker-io.d.ts" in io.files), "stale file removed");
  // Current artifacts survive.
  assert.ok("/app/nano-generated/worker-io.d.ts" in io.files, "fresh artifact kept");
});

test("runGen never sweeps runtime-materialized wrappers gen does not emit", async () => {
  const io = memIO(fixture());
  // The SDK shims + `urban data`/console dataops wrappers live in nano-generated/ but are not
  // produced by `urban gen`; the app needs them at runtime, so the sweep must protect them.
  for (const name of ["domain.ts", "workers.ts", "messages.ts", "domain.json", "data-sdk.ts", "worker-sdk.ts"]) {
    io.files[`/app/nano-generated/${name}`] = `// runtime-materialized ${name}`;
  }
  const res = await runGen({ root: "/app", io });
  assert.deepEqual(res.swept, [], "no runtime-materialized file swept");
  for (const name of ["domain.ts", "workers.ts", "messages.ts", "domain.json", "data-sdk.ts", "worker-sdk.ts"]) {
    assert.ok(`/app/nano-generated/${name}` in io.files, `${name} preserved`);
  }
});

test("gen --check never sweeps (read-only)", async () => {
  const io = memIO(fixture());
  await runGen({ root: "/app", io });
  io.files["/app/nano-generated/stale.ts"] = "// stale";
  const res = await runGen({ root: "/app", io, check: true });
  assert.deepEqual(res.swept, []);
  assert.ok("/app/nano-generated/stale.ts" in io.files, "check mode leaves stale files untouched");
});

test("modelsOnly (urban derive) never sweeps nano-generated type-contract outputs", async () => {
  const io = memIO(fixture());
  // A prior `urban gen` wrote the type-contract outputs.
  await runGen({ root: "/app", io });
  assert.ok("/app/nano-generated/worker-io.d.ts" in io.files, "precondition: gen wrote outputs");
  // `urban derive` (modelsOnly) derives only models — its artifacts carry no nano-generated/*, so
  // the sweep must be a no-op here; otherwise it would wipe the type contracts above.
  const res = await runGen({ root: "/app", io, modelsOnly: true });
  assert.deepEqual(res.swept, []);
  assert.ok("/app/nano-generated/worker-io.d.ts" in io.files, "derive preserved the type contracts");
  assert.ok("/app/nano-generated/app.schema.sql" in io.files, "derive preserved the migrations");
});

// --- code-first model derivation (urban gen / urban derive) ---

const GreetIn = envelope("GreetIn", { who: "string" });
const GreetOut = envelope("GreetOut", { message: "string" });
const greetFlow = defineFlow("greet", { hello: { in: GreetIn, out: GreetOut } }, (w) => {
  w.run("hello", async () => ({ message: "hi" }));
});

const CODE_FIRST_MANIFEST = JSON.stringify({
  id: "cf",
  data: { default: "app" },
  models: { workflows: ["workflows/*.ts"] },
  types: { greeting: { table: "greetings", fields: { who: { type: "string" } } } },
});

function codeFirstIO() {
  return memIO(
    {
      "/cf/nano.app.json": CODE_FIRST_MANIFEST,
      "/cf/workflows/greet.ts": "// derived in-memory via importModule stub",
    },
    { "/cf/workflows/greet.ts": { greet: greetFlow } },
  );
}

test("runGen derives resources/processes/<id>.bpmn from workflows/*.ts and feeds worker-io off it", async () => {
  const io = codeFirstIO();
  const res = await runGen({ root: "/cf", io });
  const bpmn = io.files["/cf/resources/processes/greet.bpmn"];
  assert.ok(bpmn, "expected a derived resources/processes/greet.bpmn");
  assert.ok(bpmn.includes(MODEL_PROVENANCE), "derived .bpmn must be provenance-stamped");
  assert.ok(bpmn.includes('type="greet:hello"'), "derived .bpmn carries the task type");
  // worker-io is derived FROM the in-memory model, not from any on-disk file.
  assert.ok(io.files["/cf/nano-generated/worker-io.d.ts"].includes("greet:hello"));
  assert.equal(res.incomplete, false);
  assert.deepEqual(res.modelErrors, []);
});

test("gen --no-models derives in-memory for worker-io but writes no .bpmn", async () => {
  const io = codeFirstIO();
  const res = await runGen({ root: "/cf", io, emitModels: false });
  assert.equal(io.files["/cf/resources/processes/greet.bpmn"], undefined, "must not write .bpmn");
  // still derives the model in-memory so worker-io is populated.
  assert.ok(io.files["/cf/nano-generated/worker-io.d.ts"].includes("greet:hello"));
  assert.equal(res.incomplete, false);
});

test("the provenance sweep removes a stale derived .bpmn no longer backed by a workflow", async () => {
  const io = codeFirstIO();
  // a leftover derived model from a since-deleted flow, provenance-stamped.
  io.files["/cf/resources/processes/stale.bpmn"] = `<?xml version="1.0"?>\n${MODEL_PROVENANCE}\n<bpmn:x/>`;
  await runGen({ root: "/cf", io });
  assert.ok(io.files["/cf/resources/processes/greet.bpmn"], "keeps the live derived model");
  assert.equal(io.files["/cf/resources/processes/stale.bpmn"], undefined, "sweeps the stale derived model");
});

test("the sweep never touches an authored (un-stamped) .bpmn", async () => {
  const io = codeFirstIO();
  io.files["/cf/resources/processes/authored.bpmn"] = `<?xml version="1.0"?>\n<bpmn:authored/>`;
  await runGen({ root: "/cf", io });
  assert.ok(io.files["/cf/resources/processes/authored.bpmn"], "authored .bpmn must survive the sweep");
});

test("collectArtifacts trims api.spec whitespace so gen matches the runtime (no gen/runtime drift)", async () => {
  const manifest = JSON.stringify({ id: "demo", data: { default: "app" }, api: { spec: "  openapi.json  " } });
  const openapi = JSON.stringify({
    openapi: "3.0.0",
    paths: { "/ping": { get: { operationId: "ping", responses: { "200": {} } } } },
  });
  const io = memIO({ "/app/nano.app.json": manifest, "/app/openapi.json": openapi });
  const res = await collectArtifacts({ root: "/app", io });
  const paths = res.map((a) => a.path);
  // The whitespace-padded spec path still resolved and derived the endpoint contracts.
  assert.ok(paths.includes("nano-generated/api-io.d.ts"));
});

test("collectArtifacts resolves an api.spec with Windows-style separators (no gen/runtime drift)", async () => {
  const manifest = JSON.stringify({ id: "demo", data: { default: "app" }, api: { spec: "specs\\openapi.json" } });
  const openapi = JSON.stringify({
    openapi: "3.0.0",
    paths: { "/ping": { get: { operationId: "ping", responses: { "200": {} } } } },
  });
  const io = memIO({ "/app/nano.app.json": manifest, "/app/specs/openapi.json": openapi });
  const res = await collectArtifacts({ root: "/app", io });
  assert.ok(res.map((a) => a.path).includes("nano-generated/api-io.d.ts"));
});

test("collectArtifacts resolves an ABSOLUTE api.spec at its own path, not root-relative (no gen/runtime drift)", async () => {
  // An absolute manifest spec path must resolve to itself — mirroring the runtime's resolveAppPath
  // — not be stripped to a root-relative "/app/abs/openapi.json". Otherwise gen would read/derive a
  // different file than the runtime dispatches against.
  const manifest = JSON.stringify({ id: "demo", data: { default: "app" }, api: { spec: "/abs/openapi.json" } });
  const openapi = JSON.stringify({
    openapi: "3.0.0",
    paths: { "/ping": { get: { operationId: "ping", responses: { "200": {} } } } },
  });
  // Only the absolute location holds the spec; a root-relative read would ENOENT.
  const io = memIO({ "/app/nano.app.json": manifest, "/abs/openapi.json": openapi });
  const res = await collectArtifacts({ root: "/app", io });
  assert.ok(res.map((a) => a.path).includes("nano-generated/api-io.d.ts"));
});

test("runGen warns when a requestBody schema is shared across operations, but never fails", async () => {
  const manifest = JSON.stringify({ id: "demo", data: { default: "app" }, api: { spec: "openapi.json" } });
  const openapi = JSON.stringify({
    openapi: "3.1.0",
    components: { schemas: { StartVariables: { type: "object", properties: { pr: { type: "string" }, url: { type: "string" }, issue: { type: "string" } } } } },
    paths: {
      "/convergence": { post: { operationId: "startConvergenceLoop", requestBody: { content: { "application/json": { schema: { $ref: "#/components/schemas/StartVariables" } } } }, responses: { "200": {} } } },
      "/fanout": { post: { operationId: "startPlanFanout", requestBody: { content: { "application/json": { schema: { $ref: "#/components/schemas/StartVariables" } } } }, responses: { "200": {} } } },
    },
  });
  const io = memIO({ "/app/nano.app.json": manifest, "/app/openapi.json": openapi });
  const res = await runGen({ root: "/app", io });

  assert.equal(res.incomplete, false); // advisory only — gen still succeeds
  assert.equal(res.warnings.length, 1, `one shared-body warning: ${JSON.stringify(res.warnings)}`);
  assert.match(res.warnings[0], /StartVariables/);
  assert.match(res.warnings[0], /startConvergenceLoop, startPlanFanout/);
  // A clean spec (distinct bodies) produces no warning.
  const clean = memIO({
    "/app/nano.app.json": manifest,
    "/app/openapi.json": JSON.stringify({
      openapi: "3.1.0",
      components: { schemas: { A: { type: "object" }, B: { type: "object" } } },
      paths: {
        "/a": { post: { operationId: "opA", requestBody: { content: { "application/json": { schema: { $ref: "#/components/schemas/A" } } } }, responses: { "200": {} } } },
        "/b": { post: { operationId: "opB", requestBody: { content: { "application/json": { schema: { $ref: "#/components/schemas/B" } } } }, responses: { "200": {} } } },
      },
    }),
  });
  assert.deepEqual((await runGen({ root: "/app", io: clean })).warnings, []);
});

test("gen fuses a model-authored nano:shape envelope into the worker-io contract", async () => {
  // No manifest `types` at all: the envelope's shape lives ENTIRELY in the model as a `nano:shape`,
  // linked to the worker by `io.nanobpm.dataEnvelope.in`. Before the shape fuse was wired into gen
  // this produced an empty `WorkerInputs {}`; now it resolves to `DomainTypes["ReviewIn"]`.
  const manifest = JSON.stringify({
    id: "demo",
    data: { default: "app" },
    models: { processes: ["processes/p.bpmn"] },
  });
  const bpmn = `<bpmn:process id="p"
    xmlns:bpmn="x" xmlns:zeebe="y" xmlns:nano="z">
    <bpmn:extensionElements><nano:shapes>
      <nano:shape id="ReviewIn" name="Review — input">
        <nano:extend name="prUrl" type="string" />
        <nano:extend name="round" type="integer" />
      </nano:shape>
    </nano:shapes></bpmn:extensionElements>
    <bpmn:serviceTask id="T"><bpmn:extensionElements>
      <zeebe:taskDefinition type="demo.review" />
      <zeebe:properties>
        <zeebe:property name="io.nanobpm.dataEnvelope.in" value="ReviewIn" />
      </zeebe:properties>
    </bpmn:extensionElements></bpmn:serviceTask>
  </bpmn:process>`;
  const io = memIO({ "/app/nano.app.json": manifest, "/app/processes/p.bpmn": bpmn });
  const res = await runGen({ root: "/app", io });
  const workerIo = res.artifacts.find((a) => a.path.endsWith("worker-io.d.ts"));
  assert.ok(workerIo, "worker-io.d.ts is emitted");
  assert.match(workerIo!.content, /"demo\.review": DomainTypes\["ReviewIn"\];/);
  // The fused shape also lands in the domain registry the worker index imports from.
  const domain = res.artifacts.find((a) => a.path.endsWith("domain-rows.d.ts"));
  assert.ok(domain, "domain-rows.d.ts is emitted from the fused registry");
  assert.match(domain!.content, /"ReviewIn":/);
});

// Guards the gen/runtime drift class: gen's readModels must key the `resources/` convention off the
// *absence* of the whole `models` block (mirroring the runtime deploy, ADR 0062), NOT off a missing
// `models.processes`. A `models` block present for other overrides (e.g. forms) must suppress the
// convention scan, so gen never derives process models the runtime deploy would never deploy.
test("readModels: a models block without processes suppresses the resources/ convention (no gen/runtime drift)", async () => {
  const io = memIO({
    "/app/resources/a.bpmn": "<bpmn:definitions/>",
    "/app/resources/sub/b.bpmn": "<bpmn:definitions/>",
    "/app/resources/sub/deeper/c.bpmn": "<bpmn:definitions/>",
  });
  // No models block at all → convention scans resources/ recursively (issue #231).
  const byConvention = await readModels("/app", io, {});
  assert.deepEqual(
    byConvention.map((m) => m.path).sort(),
    ["resources/a.bpmn", "resources/sub/b.bpmn", "resources/sub/deeper/c.bpmn"],
    "with no models block, gen discovers under resources/ recursively by convention",
  );
  // A declared models block (even one that resolves to zero process files) is an explicit override:
  // the convention scan must be skipped entirely, matching runtime deployModels.
  const withEmptyModels = await readModels("/app", io, { models: {} });
  assert.deepEqual(withEmptyModels, [], "a declared models block suppresses the resources/ convention");
  const withOnlyProcesses = await readModels("/app", io, { models: { processes: [] } });
  assert.deepEqual(withOnlyProcesses, [], "an explicitly empty models.processes yields no models, not a convention fallback");
});
