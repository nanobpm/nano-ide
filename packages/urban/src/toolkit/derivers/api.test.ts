import { test } from "node:test";
import assert from "node:assert/strict";
import { deriveApi, emitApiBindings, emitApiBindingsRuntime, schemaToTs, API_BINDINGS_DTS, API_BINDINGS_TS } from "./api.ts";
import type { OpenApiDoc } from "../../openapi/spec.ts";

const doc: OpenApiDoc = {
  openapi: "3.0.0",
  components: {
    schemas: {
      Invoice: {
        type: "object",
        properties: { id: { type: "string" }, amount: { type: "integer" }, status: { type: "string", enum: ["draft", "sent"] } },
        required: ["id", "amount"],
      },
    },
  },
  paths: {
    "/invoices/{id}": {
      get: {
        operationId: "getInvoice",
        summary: "Fetch one invoice",
        parameters: [
          { name: "id", in: "path", required: true, schema: { type: "string" } },
          { name: "expand", in: "query", schema: { type: "string" } },
        ],
        responses: { "200": { content: { "application/json": { schema: { $ref: "#/components/schemas/Invoice" } } } } },
      },
    },
  },
};

test("schemaToTs renders primitives, enums, arrays, refs, and unknown fallback", () => {
  assert.equal(schemaToTs({ type: "string" }), "string");
  assert.equal(schemaToTs({ type: "integer" }), "number");
  assert.equal(schemaToTs({ type: "string", enum: ["a", "b"] }), '"a" | "b"');
  assert.equal(schemaToTs({ type: "array", items: { type: "string" } }), "Array<string>");
  assert.equal(schemaToTs({ $ref: "#/components/schemas/Invoice" }), "Invoice");
  assert.equal(schemaToTs(undefined), "unknown");
});

test("emitApiBindings emits component types + per-op request/response + the id map", () => {
  const out = emitApiBindings(doc);
  assert.match(out, /export type Invoice = \{/);
  assert.match(out, /export interface GetInvoiceRequest \{/);
  assert.match(out, /params: \{ "id": string \}/);
  assert.match(out, /export type GetInvoiceResponse = Invoice;/);
  assert.match(out, /export type ApiOperationId = "getInvoice";/);
  assert.match(out, /"getInvoice": \{ request: GetInvoiceRequest; response: GetInvoiceResponse \};/);
});

test("emitApiBindingsRuntime re-types the runtime defineOperation", () => {
  const out = emitApiBindingsRuntime();
  assert.match(out, /import \{ defineOperation as defineOperationRaw \} from "@nanobpm\/urban";/);
  assert.match(out, /export function defineOperation<K extends ApiOperationId>/);
  assert.match(out, /return defineOperationRaw\(id, handler\);/);
});

test("deriveApi emits both artifacts under nano-generated/", () => {
  const arts = deriveApi(doc);
  const paths = arts.map((a) => a.path).sort();
  assert.deepEqual(paths, [`nano-generated/${API_BINDINGS_DTS}`, `nano-generated/${API_BINDINGS_TS}`]);
});
