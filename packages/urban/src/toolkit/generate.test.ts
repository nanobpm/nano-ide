import { test } from "node:test";
import assert from "node:assert/strict";
import { generate } from "./generate.ts";
import type { GenIO } from "./gen.ts";

/** In-memory filesystem mirroring gen.test.ts's memIO (IO-free, deterministic). */
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
    async remove(p) {
      delete files[p];
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
