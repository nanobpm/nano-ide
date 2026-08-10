import { test } from "node:test";
import assert from "node:assert/strict";
import { runGen, collectArtifacts, type GenIO } from "./gen.ts";
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

test("runGen writes migrations, the worker index, the meta accessor, and the message map", async () => {
  const io = memIO(fixture());
  const res = await runGen({ root: "/app", io });
  const paths = res.artifacts.map((a) => a.path).sort();
  assert.deepEqual(paths, [
    "nano-generated/app.schema.sql",
    "nano-generated/domain-rows.d.ts",
    "nano-generated/message-io.d.ts",
    "nano-generated/meta.ts",
    "nano-generated/worker-io.d.ts",
  ]);
  assert.ok(io.files["/app/nano-generated/app.schema.sql"].includes("CREATE TABLE"));
  assert.ok(io.files["/app/nano-generated/worker-io.d.ts"].includes("demo.do"));
  assert.ok(io.files["/app/nano-generated/meta.ts"].includes("export function meta"));
  assert.ok(io.files["/app/nano-generated/message-io.d.ts"].includes("export type MessageName"));
  assert.ok(io.files["/app/nano-generated/domain-rows.d.ts"].includes('"greetings": Greetings;'));
  assert.ok(io.files["/app/nano-generated/domain-rows.d.ts"].includes('"greeting": {'));
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

test("runGen derives processes/<id>.bpmn from workflows/*.ts and feeds worker-io off it", async () => {
  const io = codeFirstIO();
  const res = await runGen({ root: "/cf", io });
  const bpmn = io.files["/cf/processes/greet.bpmn"];
  assert.ok(bpmn, "expected a derived processes/greet.bpmn");
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
  assert.equal(io.files["/cf/processes/greet.bpmn"], undefined, "must not write .bpmn");
  // still derives the model in-memory so worker-io is populated.
  assert.ok(io.files["/cf/nano-generated/worker-io.d.ts"].includes("greet:hello"));
  assert.equal(res.incomplete, false);
});

test("the provenance sweep removes a stale derived .bpmn no longer backed by a workflow", async () => {
  const io = codeFirstIO();
  // a leftover derived model from a since-deleted flow, provenance-stamped.
  io.files["/cf/processes/stale.bpmn"] = `<?xml version="1.0"?>\n${MODEL_PROVENANCE}\n<bpmn:x/>`;
  await runGen({ root: "/cf", io });
  assert.ok(io.files["/cf/processes/greet.bpmn"], "keeps the live derived model");
  assert.equal(io.files["/cf/processes/stale.bpmn"], undefined, "sweeps the stale derived model");
});

test("the sweep never touches an authored (un-stamped) .bpmn", async () => {
  const io = codeFirstIO();
  io.files["/cf/processes/authored.bpmn"] = `<?xml version="1.0"?>\n<bpmn:authored/>`;
  await runGen({ root: "/cf", io });
  assert.ok(io.files["/cf/processes/authored.bpmn"], "authored .bpmn must survive the sweep");
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
