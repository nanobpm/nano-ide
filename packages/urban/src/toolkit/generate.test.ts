import { test } from "node:test";
import assert from "node:assert/strict";
import { generate } from "./generate.ts";
import type { GenIO } from "./gen.ts";
import { defineFlow, envelope } from "@nanobpm/workflow";

/** In-memory filesystem mirroring gen.test.ts's memIO (IO-free, deterministic). */
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
  api: { spec: "openapi.json" },
});

const BPMN = `<bpmn:process id="p" xmlns:bpmn="x" xmlns:zeebe="y">
  <bpmn:serviceTask id="T"><bpmn:extensionElements>
    <zeebe:taskDefinition type="demo.do" />
  </bpmn:extensionElements></bpmn:serviceTask>
</bpmn:process>`;

const OPENAPI = JSON.stringify({
  openapi: "3.0.0",
  paths: {
    "/ping": { get: { operationId: "ping", responses: { "200": {} } } },
  },
});

function fixture(): Record<string, string> {
  return {
    "/app/nano.app.json": MANIFEST,
    "/app/processes/p.bpmn": BPMN,
    "/app/openapi.json": OPENAPI,
  };
}

test("generate write mode scaffolds worker + operation stubs alongside derived artifacts", async () => {
  const io = memIO(fixture());
  const res = await generate({ root: "/app", io });

  // Derived artifacts landed (the runGen half).
  assert.ok(io.files["/app/nano-generated/worker-io.d.ts"], "expected derived worker-io");
  assert.ok(io.files["/app/nano-generated/app.schema.sql"], "expected derived migrations");

  // Worker stub created + wired into the manifest.
  assert.deepEqual(
    res.workerStubs.map((s) => s.status),
    ["created"],
  );
  assert.ok(io.files["/app/workers/demo-do/worker.ts"], "expected a worker stub on disk");
  assert.ok(res.manifestPatched, "expected workers[] to be patched");
  assert.equal(res.wiredWorkers.length, 1);

  // Operation stub created.
  assert.deepEqual(
    res.operationStubs.map((s) => s.status),
    ["created"],
  );
  assert.ok(io.files["/app/operations/ping.ts"], "expected an operation stub on disk");

  // Write mode never reports missing stubs.
  assert.deepEqual(res.missingStubs, []);
});

test("generate --check writes nothing and reports would-create stubs as missing", async () => {
  const io = memIO(fixture());
  // Pre-derive so the only drift under --check comes from the missing stubs.
  await generate({ root: "/app", io });
  const before = { ...io.files };

  const res = await generate({ root: "/app", io, check: true });

  // Nothing changed on disk (both derivation and scaffolding are write-free under --check).
  assert.deepEqual(io.files, before, "--check must not write");

  // The already-created stubs are kept, so nothing is missing this run.
  assert.deepEqual(res.missingStubs, []);
  assert.deepEqual(res.drift, []);
});

test("generate --check surfaces an uncommitted stub via missingStubs (the CI drift catch)", async () => {
  const io = memIO(fixture());
  const before = { ...io.files };

  const res = await generate({ root: "/app", io, check: true });

  assert.deepEqual(io.files, before, "--check must not write");
  assert.deepEqual(
    res.missingStubs.sort(),
    ["operations/ping.ts", "workers/demo-do/worker.ts"],
  );
});

test("generate keeps existing human-owned stubs (write-once, never clobbered)", async () => {
  const io = memIO(fixture());
  io.files["/app/workers/demo-do/worker.ts"] = "// hand-authored body";
  io.files["/app/operations/ping.ts"] = "// hand-authored delegate";

  const res = await generate({ root: "/app", io });

  assert.equal(io.files["/app/workers/demo-do/worker.ts"], "// hand-authored body");
  assert.equal(io.files["/app/operations/ping.ts"], "// hand-authored delegate");
  assert.deepEqual(res.workerStubs.map((s) => s.status), ["kept"]);
  assert.deepEqual(res.operationStubs.map((s) => s.status), ["kept"]);
  assert.deepEqual(res.missingStubs, []);
});

// --- code-first: w.run steps are inline-handled, so gen must never scaffold stubs for them ---

const GreetIn = envelope("GreetIn", { who: "string" });
const GreetOut = envelope("GreetOut", { message: "string" });

/** The stock code-first template's flow: one inline-handled `w.run` step (nano-ide#595's repro). */
const greetFlow = defineFlow("greet", { hello: { in: GreetIn, out: GreetOut } }, (w) => {
  w.run("hello", async () => ({ message: "hi" }));
});

test("generate on a code-first app scaffolds NO stub for an inline w.run step (nano-ide#595)", async () => {
  // The stock code-first app (create-urban-app --code-first): `greet:hello` is served by
  // `w.run("hello", …)` and hosted in-process by main.ts's Worker. Scaffolding a throwing stub
  // for it puts a second, always-failing worker on the same job type.
  const io = memIO(
    {
      "/cf/nano.app.json": JSON.stringify({
        id: "cf",
        data: { default: "app" },
        models: { workflows: ["workflows/*.ts"] },
      }),
      "/cf/workflows/greet.ts": "// derived in-memory via importModule stub",
    },
    { "/cf/workflows/greet.ts": { greet: greetFlow } },
  );

  const res = await generate({ root: "/cf", io });

  assert.equal(res.incomplete, false);
  assert.deepEqual(res.workerStubs, [], "no worker stub is scaffolded for an inline-handled step");
  assert.deepEqual(res.wiredWorkers, [], "nothing is wired into workers[]");
  assert.equal(res.manifestPatched, false, "the manifest is untouched");
  assert.equal(io.files["/cf/workers/greet-hello/worker.ts"], undefined, "no throwing stub on disk");
  const manifest = JSON.parse(io.files["/cf/nano.app.json"]);
  assert.equal(manifest.workers, undefined, "workers[] stays undeclared");
  // The model itself is still derived and written.
  assert.ok(io.files["/cf/resources/processes/greet.bpmn"], "the derived .bpmn still lands");
});

test("generate on a code-first app still scaffolds a stub for an external w.task step", async () => {
  // The other half of the split: only `w.run` steps are inline; a `w.task` step has no in-process
  // handler, so it still needs its write-once stub.
  const flow = defineFlow("orders", (w) => {
    w.run("charge", async () => ({}));
    w.task("sign"); // external worker
  });
  const io = memIO(
    {
      "/cf/nano.app.json": JSON.stringify({
        id: "cf",
        data: { default: "app" },
        models: { workflows: ["workflows/*.ts"] },
      }),
      "/cf/workflows/orders.ts": "// derived in-memory via importModule stub",
    },
    { "/cf/workflows/orders.ts": { flow } },
  );

  const res = await generate({ root: "/cf", io });

  assert.deepEqual(res.workerStubs.map((s) => s.taskType), ["orders:sign"]);
  assert.ok(io.files["/cf/workers/orders-sign/worker.ts"], "external task gets its stub");
  assert.equal(io.files["/cf/workers/orders-charge/worker.ts"], undefined, "inline step gets none");
});
