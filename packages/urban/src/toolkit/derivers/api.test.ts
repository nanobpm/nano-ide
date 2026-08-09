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

test("emitted object types mirror runtime additionalProperties semantics", () => {
  // default (absent) → extras allowed at runtime, so the emitted type carries an index signature
  assert.match(schemaToTs({ type: "object", properties: { a: { type: "string" } } }), /\[key: string\]: unknown/);
  // additionalProperties: false → closed object, no index signature
  assert.doesNotMatch(
    schemaToTs({ type: "object", properties: { a: { type: "string" } }, additionalProperties: false }),
    /\[key: string\]/,
  );
  // typed additionalProperties → typed index signature
  assert.match(
    schemaToTs({ type: "object", properties: {}, additionalProperties: { type: "number" } }),
    /\[key: string\]: number/,
  );
  // a closed, empty object is Record<string, never>, not a loose Record<string, unknown>
  assert.equal(schemaToTs({ type: "object", additionalProperties: false }), "Record<string, never>");
});

test("a typeless schema with properties is emitted as an object (matches the validator)", () => {
  const out = schemaToTs({ properties: { a: { type: "string" } }, required: ["a"] });
  assert.match(out, /"a": string/);
  assert.match(out, /\[key: string\]: unknown/);
});

test("required query params aren't undefined-widened; optional ones use the ? modifier", () => {
  const qdoc: OpenApiDoc = {
    openapi: "3.0.0",
    paths: {
      "/search": {
        get: {
          operationId: "search",
          parameters: [
            { name: "q", in: "query", required: true, schema: { type: "string" } },
            { name: "page", in: "query", schema: { type: "string" } },
          ],
          responses: { "200": {} },
        },
      },
    },
  };
  const out = emitApiBindings(qdoc);
  assert.match(out, /"q": string \| string\[\]/); // required → present, not optional
  assert.doesNotMatch(out, /"q"\?:/); // not optional
  assert.doesNotMatch(out, /"q": string \| string\[\] \| undefined/); // not undefined-widened
  assert.match(out, /"page"\?: string \| string\[\]/); // optional → ? modifier
});

test("request body optionality follows requestBody.required (runtime passes undefined when absent)", () => {
  const mk = (required: boolean): OpenApiDoc => ({
    openapi: "3.0.0",
    paths: {
      "/n": {
        post: {
          operationId: "op",
          requestBody: {
            required,
            content: { "application/json": { schema: { type: "object", properties: { text: { type: "string" } } } } },
          },
          responses: { "200": {} },
        },
      },
    },
  });
  assert.match(emitApiBindings(mk(false)), /body\?: \{/); // optional body → `?`
  const req = emitApiBindings(mk(true));
  assert.match(req, /\n {2}body: \{/); // required body → no `?`
  assert.doesNotMatch(req, /body\?:/);
});

test("typed additionalProperties alongside declared props falls back to unknown (valid TS, no TS2411)", () => {
  // A narrow index type (number) would make `{ "a": string; [key: string]: number }` invalid TS,
  // so with declared properties the index signature widens to unknown; a pure map keeps its type.
  const withProps = schemaToTs({
    type: "object",
    properties: { a: { type: "string" } },
    required: ["a"],
    additionalProperties: { type: "number" },
  });
  assert.match(withProps, /"a": string/);
  assert.match(withProps, /\[key: string\]: unknown/);
  assert.doesNotMatch(withProps, /\[key: string\]: number/);
  // No declared properties → precise map type is safe.
  assert.match(
    schemaToTs({ type: "object", additionalProperties: { type: "number" } }),
    /\[key: string\]: number/,
  );
});

test("a required body with no JSON schema is typed `unknown`, not `undefined`", () => {
  const mk = (required: boolean): OpenApiDoc => ({
    openapi: "3.0.0",
    paths: {
      "/n": {
        post: {
          operationId: "op",
          // requestBody with no parseable JSON schema (e.g. unsupported content)
          requestBody: { required, content: { "text/plain": {} } },
          responses: { "200": {} },
        },
      },
    },
  });
  assert.match(emitApiBindings(mk(true)), /\n {2}body: unknown;/); // required → body IS present
  assert.match(emitApiBindings(mk(false)), /body\?: undefined;/); // optional/absent
});

test("request body types derive only from JSON media types (JSON-only surface)", () => {
  const doc2: OpenApiDoc = {
    openapi: "3.0.0",
    paths: {
      "/n": {
        post: {
          operationId: "op",
          requestBody: {
            required: true,
            content: {
              "application/xml": { schema: { type: "string" } }, // ignored
              "application/vnd.acme+json": { schema: { type: "object", properties: { a: { type: "string" } } } },
            },
          },
          responses: { "200": {} },
        },
      },
    },
  };
  const out = emitApiBindings(doc2);
  assert.match(out, /body: \{ "a"\?: string/); // picked the +json schema, not the xml string
});

test("emitApiBindings fails closed on operationIds that collapse to the same TS type name", () => {
  const clash: OpenApiDoc = {
    openapi: "3.0.0",
    paths: {
      "/a": { get: { operationId: "get-invoice", responses: { "200": {} } } },
      "/b": { get: { operationId: "get_invoice", responses: { "200": {} } } },
    },
  };
  assert.throws(() => emitApiBindings(clash), /duplicate TypeScript type "GetInvoiceRequest"/);
});

test("emitApiBindings fails closed on component schema names that collapse to the same TS type name", () => {
  const clash: OpenApiDoc = {
    openapi: "3.0.0",
    components: { schemas: { "Foo-Bar": { type: "object" }, "Foo_Bar": { type: "object" } } },
    paths: {},
  };
  assert.throws(() => emitApiBindings(clash), /duplicate TypeScript type "FooBar"/);
});
