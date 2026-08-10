import { test } from "node:test";
import assert from "node:assert/strict";
import {
  collectOperations,
  isObjectSchema,
  isSafeOperationId,
  type OpenApiDoc,
  type OpenApiSchema,
  operationsWithoutId,
  operationsWithUnsafeId,
  parseSpec,
  resolveSchema,
  toRouteMatcher,
  undeclaredPathParams,
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

test("parseSpec throws a clear error on non-object and unparseable input", () => {
  // A bare scalar parses (as JSON or YAML) but is not a document object.
  assert.throws(() => parseSpec("42"), /must be an object/);
  // Unbalanced/garbage that is neither valid JSON nor valid YAML.
  assert.throws(() => parseSpec("{ : ]["), /not valid YAML or JSON/);
});

test("parseSpec includes both JSON and YAML diagnostics when neither parser accepts the input", () => {
  assert.throws(
    () => parseSpec("{ : ]["),
    /JSON parse error:.*YAML parse error:/,
  );
});

test("parseSpec parses a YAML OpenAPI document (ADR 0059 authoring format)", () => {
  const yaml = [
    "openapi: 3.0.0",
    "info:",
    "  title: Demo",
    "  version: 1.0.0",
    "paths:",
    "  /invoices:",
    "    post:",
    "      operationId: createInvoice",
    "      requestBody:",
    "        required: true",
    "        content:",
    "          application/json:",
    "            schema:",
    "              $ref: '#/components/schemas/Invoice'",
    "      responses:",
    "        '201':",
    "          description: created",
    "components:",
    "  schemas:",
    "    Invoice:",
    "      type: object",
    "      required: [id, amount]",
    "      properties:",
    "        id: { type: string }",
    "        amount: { type: integer, minimum: 1 }",
    "",
  ].join("\n");
  const parsed = parseSpec(yaml);
  assert.equal(parsed.openapi, "3.0.0");
  const ops = collectOperations(parsed);
  assert.deepEqual(
    ops.map((o) => o.operationId),
    ["createInvoice"],
  );
  // The $ref resolves against the YAML-authored components, same as a JSON spec.
  const resolved = resolveSchema(parsed, { $ref: "#/components/schemas/Invoice" });
  assert.equal(resolved?.type, "object");
  assert.deepEqual(resolved?.required, ["id", "amount"]);
});

test("parseSpec still parses JSON (accepted interchange format)", () => {
  const parsed = parseSpec(JSON.stringify(doc));
  assert.equal(parsed.openapi, "3.0.0");
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

test("collectOperations dedups path- and op-level params by (name, in), op-level winning", () => {
  // OpenAPI: a param is identified by (name, in); an op-level param overrides the path-level one of
  // the same identity — it must never appear twice, or the emitted params/query binding would carry
  // two colliding fields and runtime extraction would be ambiguous.
  const dedupDoc: OpenApiDoc = {
    openapi: "3.0.0",
    paths: {
      "/items/{id}": {
        // Path-level: id is (loosely) optional here; op-level tightens it to required.
        parameters: [
          { name: "id", in: "path", required: false, schema: { type: "string" } },
          { name: "trace", in: "query", schema: { type: "string" } },
        ],
        get: {
          operationId: "getItem",
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "integer" } }],
          responses: { "200": {} },
        },
      },
    },
  };
  const op = collectOperations(dedupDoc).find((o) => o.operationId === "getItem");
  assert.ok(op);
  const ids = op.parameters.filter((p) => p.in === "path" && p.name === "id");
  assert.equal(ids.length, 1, "the (id, path) param must collapse to one");
  // Op-level wins: required + integer schema, not the path-level optional string.
  assert.equal(ids[0]?.required, true);
  assert.equal(ids[0]?.schema?.type, "integer");
  // First-seen position is preserved: id (from path-level) before the query param.
  assert.deepEqual(
    op.parameters.map((p) => `${p.in}:${p.name}`),
    ["path:id", "query:trace"],
  );
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

test("validateValue supports OpenAPI 3.0 boolean exclusiveMinimum/Maximum and 3.1 numeric form", () => {
  // 3.0 boolean form: exclusiveMinimum: true makes `minimum` exclusive
  assert.equal(validateValue(doc, { type: "integer", minimum: 1, exclusiveMinimum: true }, 1).length, 1);
  assert.equal(validateValue(doc, { type: "integer", minimum: 1, exclusiveMinimum: true }, 2).length, 0);
  assert.equal(validateValue(doc, { type: "integer", maximum: 10, exclusiveMaximum: true }, 10).length, 1);
  // inclusive by default
  assert.equal(validateValue(doc, { type: "integer", minimum: 1 }, 1).length, 0);
  // 3.1 numeric form still works
  assert.equal(validateValue(doc, { type: "integer", exclusiveMinimum: 1 }, 1).length, 1);
  assert.equal(validateValue(doc, { type: "integer", exclusiveMinimum: 1 }, 2).length, 0);
});
test("validateValue compares enum/const structurally (object/array members, not by reference)", () => {
  // Parsed request values are never `===` to the schema's object/array members, so `===` would
  // reject even a structurally-identical value. Deep equality is required for correctness.
  const objEnum = { type: "object", enum: [{ kind: "a", n: 1 }] };
  assert.equal(validateValue(doc, objEnum, { kind: "a", n: 1 }).length, 0);
  assert.equal(validateValue(doc, objEnum, { kind: "b", n: 1 }).length, 1);
  const arrConst = { const: [1, 2, 3] };
  assert.equal(validateValue(doc, arrConst, [1, 2, 3]).length, 0);
  assert.equal(validateValue(doc, arrConst, [1, 2]).length, 1);
  // primitives still work
  assert.equal(validateValue(doc, { type: "string", enum: ["a", "b"] }, "a").length, 0);
});

test("toRouteMatcher escapes RegExp metacharacters in the base (literal path prefix)", () => {
  const { pattern } = toRouteMatcher("/app/api(v2)", "/invoices/{id}");
  // The parentheses in the base must match literally, not act as a regex group.
  assert.equal(pattern.test("/app/api(v2)/invoices/42"), true);
  assert.equal(pattern.test("/app/apiv2/invoices/42"), false);
  // A dot in the base must not match an arbitrary character.
  const { pattern: p2 } = toRouteMatcher("/v1.0", "/ping");
  assert.equal(p2.test("/v1.0/ping"), true);
  assert.equal(p2.test("/v1x0/ping"), false);
});

test("validateValue enforces allOf (intersection), anyOf/oneOf (union) — matching schemaToTs", () => {
  // allOf: value must satisfy every subschema (intersection).
  const all: OpenApiSchema = { allOf: [{ type: "object", properties: { a: { type: "string" } }, required: ["a"] }, { type: "object", properties: { b: { type: "integer" } }, required: ["b"] }] };
  assert.equal(validateValue(doc, all, { a: "x", b: 1 }).length, 0);
  assert.ok(validateValue(doc, all, { a: "x" }).length > 0); // missing b
  // anyOf: at least one subschema must match.
  const any: OpenApiSchema = { anyOf: [{ type: "string" }, { type: "integer" }] };
  assert.equal(validateValue(doc, any, "x").length, 0);
  assert.equal(validateValue(doc, any, 5).length, 0);
  assert.ok(validateValue(doc, any, true).length > 0);
  // oneOf: exactly one subschema must match.
  const one: OpenApiSchema = { oneOf: [{ type: "integer" }, { type: "integer", minimum: 10 }] };
  assert.equal(validateValue(doc, one, 5).length, 0); // integer but <10 → matches only the first
  assert.ok(validateValue(doc, one, 20).length > 0); // matches BOTH → not exactly one
  assert.ok(validateValue(doc, one, "x").length > 0); // matches NEITHER
});

test("undeclaredPathParams flags path-template params with no declared parameter", () => {
  const drift: OpenApiDoc = {
    openapi: "3.0.0",
    paths: {
      "/users/{userId}/posts/{postId}": {
        get: {
          operationId: "getUserPost",
          parameters: [{ name: "userId", in: "path", required: true, schema: { type: "string" } }],
          responses: { "200": {} },
        },
      },
    },
  };
  assert.deepEqual(undeclaredPathParams(drift), ["GET /users/{userId}/posts/{postId} {postId}"]);
  // A fully-declared spec reports nothing.
  assert.deepEqual(undeclaredPathParams(doc), []);
});

test("isSafeOperationId rejects path separators and traversal; collectOperations skips them", () => {
  assert.equal(isSafeOperationId("getInvoice"), true);
  assert.equal(isSafeOperationId("get.invoice-v2"), true);
  assert.equal(isSafeOperationId("../secret"), false);
  assert.equal(isSafeOperationId("a/b"), false);
  assert.equal(isSafeOperationId("a\\b"), false);
  assert.equal(isSafeOperationId(".."), false);
  const evil: OpenApiDoc = {
    openapi: "3.0.0",
    paths: {
      "/x": { get: { operationId: "../../etc/passwd", responses: { "200": {} } } },
      "/y": { get: { operationId: "safeOp", responses: { "200": {} } } },
    },
  };
  assert.deepEqual(collectOperations(evil).map((o) => o.operationId), ["safeOp"]);
  assert.deepEqual(operationsWithUnsafeId(evil), ["GET /x (../../etc/passwd)"]);
});

test("object validation uses own-property checks (prototype keys don't satisfy required or bypass additionalProperties)", () => {
  // A prototype key must NOT satisfy `required` (own-property semantics).
  const req = { type: "object", properties: { toString: { type: "string" } }, required: ["toString"] };
  assert.equal(validateValue(doc, req, {}).length, 1); // `toString` inherited, not provided
  assert.equal(validateValue(doc, req, { toString: "x" }).length, 0);
  // A prototype-named key in the payload must be rejected under additionalProperties:false.
  const closed = { type: "object", properties: { id: { type: "string" } }, additionalProperties: false };
  const issues = validateValue(doc, closed, { id: "x", toString: "evil" });
  assert.ok(issues.some((i) => i.message === "is not an allowed property"));
});

test("validateValue handles null: typeless object rejects it; nullable/type-null/enum-null/const-null allow it", () => {
  // A typeless object schema (properties/required imply object) must reject null.
  const objSchema: OpenApiSchema = { properties: { id: { type: "string" } }, required: ["id"] };
  assert.equal(validateValue(doc, objSchema, null).length, 1);
  // A typed schema rejects null unless nullable / type: "null".
  assert.equal(validateValue(doc, { type: "string" }, null).length, 1);
  assert.equal(validateValue(doc, { type: "string", nullable: true }, null).length, 0);
  assert.equal(validateValue(doc, { type: "null" }, null).length, 0);
  // enum/const gate null explicitly.
  assert.equal(validateValue(doc, { enum: [null, "a"] }, null).length, 0);
  assert.equal(validateValue(doc, { enum: ["a", "b"] }, null).length, 1);
  assert.equal(validateValue(doc, { const: null }, null).length, 0);
  assert.equal(validateValue(doc, { const: "a" }, null).length, 1);
  // A truly empty schema allows anything, including null.
  assert.equal(validateValue(doc, {}, null).length, 0);
});
