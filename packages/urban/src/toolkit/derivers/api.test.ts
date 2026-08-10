import { test } from "node:test";
import assert from "node:assert/strict";
import { deriveApi, emitApiBindings, emitApiBindingsRuntime, emitApiController, schemaToTs, API_BINDINGS_DTS, API_BINDINGS_TS, API_CONTROLLER_TS } from "./api.ts";
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

test("schemaToTs renders OpenAPI 3.1 nullable type-arrays as `T | null`", () => {
  // The 3.1 idiom `type: [T, "null"]` must emit the same `T | null` as 3.0 `nullable: true`,
  // not degrade to `unknown` (the bug this fixes).
  assert.equal(schemaToTs({ type: ["string", "null"] }), "string | null");
  assert.equal(schemaToTs({ type: ["integer", "null"] }), "number | null");
  assert.equal(schemaToTs({ type: ["boolean", "null"] }), "boolean | null");
  assert.equal(schemaToTs({ type: ["array", "null"], items: { type: "string" } }), "Array<string> | null");
  // 3.0 nullable stays equivalent.
  assert.equal(schemaToTs({ type: "string", nullable: true }), "string | null");
  // A bare `type: ["null"]` is exactly `null`.
  assert.equal(schemaToTs({ type: ["null"] }), "null");
  // A genuine multi-type union renders as a union (plus `| null` when null is present).
  assert.equal(schemaToTs({ type: ["string", "number"] }), "string | number");
  assert.equal(schemaToTs({ type: ["string", "number", "null"] }), "string | number | null");
});

test("schemaToTs renders a 3.1 nullable object type-array as `{...} | null`", () => {
  assert.match(schemaToTs({ type: ["object", "null"], properties: { a: { type: "string" } } }), /\| null$/);
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

test("deriveApi emits the type map, typed defineOperation, and the controller under nano-generated/", () => {
  const arts = deriveApi(doc);
  const paths = arts.map((a) => a.path).sort();
  assert.deepEqual(paths, [
    `nano-generated/${API_BINDINGS_DTS}`,
    `nano-generated/${API_BINDINGS_TS}`,
    `nano-generated/${API_CONTROLLER_TS}`,
  ].sort());
});

test("emitApiController statically imports each delegate + asserts the set with satisfies", () => {
  const out = emitApiController(doc);
  // one default import per operation, from the default operations/ dir, with an explicit .ts ext
  assert.match(out, /import op0 from "\.\.\/operations\/getInvoice\.ts";/);
  // the registry maps the real operationId to the imported delegate
  assert.match(out, /"getInvoice": op0,/);
  // the load-bearing completeness assertion
  assert.match(out, /satisfies \{\s*\[K in ApiOperationId\]: OperationHandler<ReqFor<K>, ResFor<K>>;\s*\}/);
  assert.match(out, /import type \{ OperationHandler \} from "@nanobpm\/urban";/);
});

test("emitApiController honors a custom api.dir for the delegate import path", () => {
  const out = emitApiController(doc, "handlers");
  assert.match(out, /import op0 from "\.\.\/handlers\/getInvoice\.ts";/);
});

test("emitApiController on an empty spec is a valid empty registry (never = {})", () => {
  const empty: OpenApiDoc = { openapi: "3.0.0", paths: {} };
  const out = emitApiController(empty);
  assert.doesNotMatch(out, /^import op\d/m); // no delegate imports
  assert.match(out, /export const operations = \{\s*\} satisfies \{/);
});

test("emitApiController throws on a duplicate operationId (would silently overwrite a map key)", () => {
  const dupe: OpenApiDoc = {
    openapi: "3.0.0",
    paths: {
      "/a": { get: { operationId: "same", responses: { "200": {} } } },
      "/b": { get: { operationId: "same", responses: { "200": {} } } },
    },
  };
  assert.throws(() => emitApiController(dupe), /duplicate operationId\(s\): same/);
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
  assert.match(out, /"q": string/); // required scalar string → present, coerced to its schema type
  assert.doesNotMatch(out, /"q"\?:/); // not optional
  assert.doesNotMatch(out, /"q": string \| undefined/); // not undefined-widened
  assert.match(out, /"page"\?: string/); // optional → ? modifier
});

test("params are typed by their schema (coerced), not the raw wire string", () => {
  const pdoc: OpenApiDoc = {
    openapi: "3.0.0",
    paths: {
      "/things/{id}": {
        get: {
          operationId: "getThing",
          parameters: [
            { name: "id", in: "path", required: true, schema: { type: "integer" } },
            { name: "verbose", in: "query", schema: { type: "boolean" } },
            { name: "tags", in: "query", schema: { type: "array", items: { type: "string" } } },
            { name: "raw", in: "query" }, // no schema → raw wire type
          ],
          responses: { "200": {} },
        },
      },
    },
  };
  const out = emitApiBindings(pdoc);
  assert.match(out, /"id": number/); // integer path param → number, not string
  assert.match(out, /"verbose"\?: boolean/); // boolean query → boolean
  assert.match(out, /"tags"\?: Array<string>/); // array query → Array<item>
  assert.match(out, /"raw"\?: string \| string\[\]/); // schemaless query → raw wire type
});

test("the response type unions every documented JSON response body (success + error)", () => {
  const rdoc: OpenApiDoc = {
    openapi: "3.0.0",
    components: {
      schemas: {
        Ok: { type: "object", properties: { ok: { type: "boolean" } }, additionalProperties: false },
        Err: { type: "object", properties: { error: { type: "string" } }, additionalProperties: false },
      },
    },
    paths: {
      "/do": {
        post: {
          operationId: "doIt",
          responses: {
            "200": { content: { "application/json": { schema: { $ref: "#/components/schemas/Ok" } } } },
            "400": { content: { "application/json": { schema: { $ref: "#/components/schemas/Err" } } } },
          },
        },
      },
    },
  };
  const out = emitApiBindings(rdoc);
  assert.match(out, /export type DoItResponse = Ok \| Err;/); // both bodies in the union
});

test("an ejected operation keeps raw wire param/query types + an unknown body (runtime skips coercion)", () => {
  const edoc: OpenApiDoc = {
    openapi: "3.0.0",
    paths: {
      "/raw/{id}": {
        post: {
          operationId: "rawOp",
          "x-urban-eject": true,
          parameters: [
            { name: "id", in: "path", required: true, schema: { type: "integer" } },
            { name: "n", in: "query", schema: { type: "integer" } },
          ],
          requestBody: {
            required: true,
            content: { "application/json": { schema: { type: "object", properties: { a: { type: "string" } } } } },
          },
          responses: { "200": {} },
        },
      },
    },
  };
  const out = emitApiBindings(edoc);
  assert.match(out, /"id": string/); // ejected integer path param stays a raw wire string
  assert.match(out, /"n"\?: string \| string\[\]/); // ejected query param stays raw wire
  assert.match(out, /body: unknown;/); // ejected body is unvalidated → unknown
});

test("whole-surface eject (manifest api.eject) types every op as ejected (raw params, unknown body)", () => {
  const sdoc: OpenApiDoc = {
    openapi: "3.0.0",
    paths: {
      "/thing/{id}": {
        post: {
          operationId: "doThing",
          parameters: [
            { name: "id", in: "path", required: true, schema: { type: "integer" } },
            { name: "q", in: "query", required: true, schema: { type: "integer" } },
          ],
          requestBody: {
            required: true,
            content: { "application/json": { schema: { type: "object", properties: { a: { type: "string" } } } } },
          },
          responses: { "200": {} },
        },
      },
    },
  };
  // Without the surface flag the op is fully typed…
  const typed = emitApiBindings(sdoc, false);
  assert.match(typed, /"id": number/);
  assert.match(typed, /"q": number/);
  // …with whole-surface eject it degrades to raw wire + unknown body, matching the runtime.
  const ejected = emitApiBindings(sdoc, true);
  assert.match(ejected, /"id": string/); // raw wire path param
  assert.match(ejected, /"q"\?: string \| string\[\]/); // required query param becomes optional + raw
  assert.match(ejected, /body: unknown;/);
});

test("an ejected required query param is typed optional (runtime does not enforce presence)", () => {
  const edoc: OpenApiDoc = {
    openapi: "3.0.0",
    paths: {
      "/raw": {
        get: {
          operationId: "rawReq",
          "x-urban-eject": true,
          parameters: [{ name: "req", in: "query", required: true, schema: { type: "integer" } }],
          responses: { "200": {} },
        },
      },
    },
  };
  const out = emitApiBindings(edoc);
  assert.match(out, /"req"\?: string \| string\[\]/); // required-but-ejected → optional raw wire
});

test("a component or operationId colliding with a fixed generated name fails the drift gate", () => {
  const cdoc: OpenApiDoc = {
    openapi: "3.0.0",
    components: { schemas: { ApiOperations: { type: "string" } } },
    paths: { "/z": { get: { operationId: "getZ", responses: { "200": {} } } } },
  };
  assert.throws(() => emitApiBindings(cdoc), /duplicate TypeScript type "ApiOperations"/);
});

test("a documented-but-bodyless status is excluded from the response union", () => {
  const rdoc: OpenApiDoc = {
    openapi: "3.1.0",
    components: {
      schemas: { Err: { type: "object", properties: { error: { type: "string" } }, additionalProperties: false } },
    },
    paths: {
      "/x": {
        get: {
          operationId: "getX",
          responses: {
            "204": {}, // documented, no JSON body → not in the union
            default: { content: { "application/json": { schema: { $ref: "#/components/schemas/Err" } } } },
          },
        },
      },
    },
  };
  const out = emitApiBindings(rdoc);
  assert.match(out, /export type GetXResponse = Err;/); // only the schema'd default body
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

test("apiDeriver is registered in the DERIVERS discovery registry", async () => {
  const { DERIVERS, apiDeriver } = await import("../index.ts");
  assert.ok(DERIVERS.includes(apiDeriver), "apiDeriver must be in DERIVERS");
  assert.ok(DERIVERS.some((d) => d.id === "openapi->api-io"));
  // Registry hygiene: no deriver is registered twice and every id is unique.
  const ids = DERIVERS.map((d) => d.id);
  assert.equal(new Set(ids).size, ids.length);
});
