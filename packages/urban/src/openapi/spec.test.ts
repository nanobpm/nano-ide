import { test } from "node:test";
import assert from "node:assert/strict";
import {
  collectOperations,
  isObjectSchema,
  type OpenApiDoc,
  operationsWithoutId,
  parseSpec,
  resolveSchema,
  toRouteMatcher,
  validateValue,
} from "./spec.ts";

const doc: OpenApiDoc = {
  openapi: "3.0.0",
  components: {
    schemas: {
      Invoice: {
        type: "object",
        properties: { id: { type: "string" }, amount: { type: "integer", minimum: 1 } },
        required: ["id", "amount"],
        additionalProperties: false,
      },
    },
  },
  paths: {
    "/invoices": {
      get: {
        operationId: "listInvoices",
        parameters: [{ name: "limit", in: "query", schema: { type: "integer", minimum: 1, maximum: 100 } }],
        responses: { "200": { content: { "application/json": { schema: { $ref: "#/components/schemas/Invoice" } } } } },
      },
      post: {
        operationId: "createInvoice",
        requestBody: { required: true, content: { "application/json": { schema: { $ref: "#/components/schemas/Invoice" } } } },
        responses: { "201": { content: { "application/json": { schema: { $ref: "#/components/schemas/Invoice" } } } } },
      },
    },
    "/invoices/{id}": {
      get: {
        operationId: "getInvoice",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        responses: { "200": {} },
      },
      delete: { responses: { "204": {} } }, // no operationId — skipped + reported
    },
  },
};

test("parseSpec throws a clear error on non-JSON and non-object", () => {
  assert.throws(() => parseSpec("not json"), /not valid JSON/);
  assert.throws(() => parseSpec("42"), /must be a JSON object/);
});

test("collectOperations returns id-bearing ops in stable (path, method) order", () => {
  const ops = collectOperations(doc);
  assert.deepEqual(
    ops.map((o) => o.operationId),
    ["listInvoices", "createInvoice", "getInvoice"],
  );
  const create = ops.find((o) => o.operationId === "createInvoice");
  assert.equal(create?.method, "post");
  assert.equal(create?.requestBodyRequired, true);
  assert.ok(create?.requestBodySchema);
  const get = ops.find((o) => o.operationId === "getInvoice");
  assert.equal(get?.parameters[0]?.in, "path");
});

test("operationsWithoutId reports the delete with no operationId", () => {
  assert.deepEqual(operationsWithoutId(doc), ["DELETE /invoices/{id}"]);
});

test("resolveSchema follows a local $ref and guards cycles", () => {
  const resolved = resolveSchema(doc, { $ref: "#/components/schemas/Invoice" });
  assert.equal(resolved?.type, "object");
  const cyclic: OpenApiDoc = { openapi: "3.0.0", components: { schemas: { A: { $ref: "#/components/schemas/A" } } }, paths: {} };
  assert.equal(resolveSchema(cyclic, { $ref: "#/components/schemas/A" }), undefined);
});

test("validateValue enforces the JSON-Schema subset via $ref", () => {
  const schema = { $ref: "#/components/schemas/Invoice" };
  assert.deepEqual(validateValue(doc, schema, { id: "i1", amount: 5 }, "body"), []);
  // missing required + wrong type + disallowed extra property
  const issues = validateValue(doc, schema, { amount: "nope", extra: 1 }, "body");
  const paths = issues.map((i) => i.path).sort();
  assert.deepEqual(paths, ["body/amount", "body/extra", "body/id"]);
});

test("validateValue numeric bounds + enum", () => {
  assert.equal(validateValue(doc, { type: "integer", minimum: 1, maximum: 100 }, 5).length, 0);
  assert.equal(validateValue(doc, { type: "integer", maximum: 100 }, 500).length, 1);
  assert.equal(validateValue(doc, { type: "string", enum: ["a", "b"] }, "c").length, 1);
});

test("toRouteMatcher captures path params positionally and boundary-matches", () => {
  const { pattern, paramNames } = toRouteMatcher("/app/api", "/invoices/{id}");
  assert.deepEqual(paramNames, ["id"]);
  const m = pattern.exec("/app/api/invoices/42");
  assert.equal(m?.[1], "42");
  assert.equal(pattern.test("/app/api/invoices/42/extra"), false);
  assert.equal(pattern.test("/app/api/invoices/42/"), true); // optional trailing slash
});

test("isObjectSchema treats typeless property/required/additionalProperties schemas as objects", () => {
  assert.equal(isObjectSchema({ type: "object" }), true);
  assert.equal(isObjectSchema({ properties: { a: { type: "string" } } }), true);
  assert.equal(isObjectSchema({ required: ["a"] }), true);
  assert.equal(isObjectSchema({ additionalProperties: false }), true);
  assert.equal(isObjectSchema({ type: "string" }), false); // explicit non-object type wins
  assert.equal(isObjectSchema({}), false); // no shape keywords → not an object
});

test("validateValue shape-checks typeless object schemas (no type/runtime drift)", () => {
  // A schema with properties/required but no explicit `type: "object"` is emitted as an object
  // by schemaToTs, so the validator must shape-check it too — otherwise invalid bodies pass.
  const schema = { properties: { id: { type: "string" } }, required: ["id"] };
  assert.deepEqual(validateValue(doc, schema, { id: "ok" }, "body"), []);
  const issues = validateValue(doc, schema, {}, "body");
  assert.deepEqual(
    issues.map((i) => i.path),
    ["body/id"],
  );
});

test("validateValue surfaces a malformed pattern as a controlled throw, not an opaque RegExp error", () => {
  assert.throws(
    () => validateValue(doc, { type: "string", pattern: "([" }, "abc", "body"),
    /invalid pattern/,
  );
});

test("a typeless object schema rejects non-object values (42, [])", () => {
  const schema = { properties: { id: { type: "string" } }, required: ["id"] };
  assert.equal(validateValue(doc, schema, 42, "body").length, 1);
  assert.equal(validateValue(doc, schema, [], "body").length, 1);
  assert.equal(validateValue(doc, schema, { id: "x" }, "body").length, 0);
});
