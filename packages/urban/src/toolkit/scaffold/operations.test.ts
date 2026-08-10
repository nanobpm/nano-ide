import { test } from "node:test";
import assert from "node:assert/strict";
import { planOperationScaffold, renderOperationStub } from "./operations.ts";
import { scaffoldOperations } from "../scaffold.ts";
import type { GenIO } from "../gen.ts";
import type { OpenApiDoc } from "../../openapi/spec.ts";

const doc: OpenApiDoc = {
  openapi: "3.0.0",
  paths: {
    "/invoices/{id}": {
      get: {
        operationId: "getInvoice",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        responses: { "200": {} },
      },
    },
    "/invoices": {
      post: { operationId: "createInvoice", responses: { "201": {} } },
    },
  },
};

test("renderOperationStub is a typed default-exported delegate that throws NotImplemented", () => {
  const stub = renderOperationStub("getInvoice");
  assert.match(stub, /import \{ NotImplemented \} from "@nanobpm\/urban";/);
  assert.match(stub, /import \{ defineOperation \} from "\.\.\/nano-generated\/operations\.ts";/);
  assert.match(stub, /export default defineOperation\("getInvoice", async \(input, app\) =>/);
  assert.match(stub, /throw new NotImplemented\("getInvoice"\);/);
});

test("renderOperationStub adjusts the generated-import depth for a nested api.dir", () => {
  const stub = renderOperationStub("getInvoice", "api/handlers");
  assert.match(stub, /import \{ defineOperation \} from "\.\.\/\.\.\/nano-generated\/operations\.ts";/);
});

test("planOperationScaffold plans one stub per declared operationId", () => {
  const plans = planOperationScaffold(doc);
  const byId = Object.fromEntries(plans.map((p) => [p.operationId, p.handlerPath]));
  assert.deepEqual(byId, {
    getInvoice: "operations/getInvoice.ts",
    createInvoice: "operations/createInvoice.ts",
  });
});

test("planOperationScaffold honors a custom api.dir", () => {
  const plans = planOperationScaffold(doc, "handlers");
  assert.ok(plans.every((p) => p.handlerPath.startsWith("handlers/")));
});

test("planOperationScaffold throws on a duplicate operationId (incoherent spec)", () => {
  const dupe: OpenApiDoc = {
    openapi: "3.0.0",
    paths: {
      "/a": { get: { operationId: "same", responses: { "200": {} } } },
      "/b": { get: { operationId: "same", responses: { "200": {} } } },
    },
  };
  assert.throws(() => planOperationScaffold(dupe), /duplicate operationId\(s\): same/);
});

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
    "/app/nano.app.json": JSON.stringify({ id: "demo", api: { spec: "openapi.json" } }),
    "/app/openapi.json": JSON.stringify(doc),
  };
}

test("scaffoldOperations is a no-op when the app declares no api binding", async () => {
  const io = memIO({ "/app/nano.app.json": JSON.stringify({ id: "demo" }) });
  const run = await scaffoldOperations({ root: "/app", io, write: true });
  assert.deepEqual(run.outcomes, []);
});

test("scaffoldOperations dry-run writes nothing and reports would-create per op", async () => {
  const io = memIO(appFixture());
  const before = Object.keys(io.files).length;
  const run = await scaffoldOperations({ root: "/app", io });
  assert.equal(run.write, false);
  assert.equal(Object.keys(io.files).length, before, "dry-run must not write");
  assert.deepEqual(run.outcomes.map((o) => o.status).sort(), ["would-create", "would-create"]);
});

test("scaffoldOperations --write creates one typed stub per op", async () => {
  const io = memIO(appFixture());
  const run = await scaffoldOperations({ root: "/app", io, write: true });
  assert.ok(run.outcomes.every((o) => o.status === "created"));
  assert.match(io.files["/app/operations/getInvoice.ts"], /NotImplemented\("getInvoice"\)/);
  assert.match(io.files["/app/operations/createInvoice.ts"], /NotImplemented\("createInvoice"\)/);
});

test("scaffoldOperations never clobbers an existing delegate (keeps it)", async () => {
  const files = appFixture();
  files["/app/operations/getInvoice.ts"] = "// hand-written, do not touch\n";
  const io = memIO(files);
  const run = await scaffoldOperations({ root: "/app", io, write: true });
  assert.equal(io.files["/app/operations/getInvoice.ts"], "// hand-written, do not touch\n");
  assert.equal(run.outcomes.find((o) => o.operationId === "getInvoice")?.status, "kept");
  assert.equal(run.outcomes.find((o) => o.operationId === "createInvoice")?.status, "created");
});

test("scaffoldOperations is idempotent: a second --write run keeps everything", async () => {
  const io = memIO(appFixture());
  await scaffoldOperations({ root: "/app", io, write: true });
  const snapshot = JSON.stringify(io.files);
  const run2 = await scaffoldOperations({ root: "/app", io, write: true });
  assert.ok(run2.outcomes.every((o) => o.status === "kept"));
  assert.equal(JSON.stringify(io.files), snapshot, "files unchanged on re-run");
});
