import { test } from "node:test";
import assert from "node:assert/strict";
import {
  collectOperations,
  evaluateSecurity,
  isObjectSchema,
  isSafeOperationId,
  isMutatingMethod,
  type OpenApiDoc,
  type OpenApiSchema,
  operationsWithoutId,
  operationsWithUnsafeId,
  parseSpec,
  resolveSchema,
  responseSchemaForStatus,
  sharedRequestBodySchemas,
  toRouteMatcher,
  undeclaredPathParams,
  undeclaredSecuritySchemes,
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

test("isObjectSchema understands OpenAPI 3.1 nullable type-arrays", () => {
  assert.equal(isObjectSchema({ type: ["object", "null"] }), true); // nullable object is an object
  assert.equal(isObjectSchema({ type: ["string", "null"] }), false); // nullable scalar is not
});

test("validateValue accepts OpenAPI 3.1 nullable type-arrays (type: [T, null])", () => {
  // The 3.1 idiom `type: [T, "null"]` must be treated exactly like 3.0 `nullable: true`: the value
  // type is accepted, an explicit null is accepted, and a wrong type is still rejected.
  const nullableStr: OpenApiSchema = { type: ["string", "null"] };
  assert.deepEqual(validateValue(doc, nullableStr, "hi"), []);
  assert.deepEqual(validateValue(doc, nullableStr, null), []);
  assert.equal(validateValue(doc, nullableStr, 42).length, 1);

  const nullableInt: OpenApiSchema = { type: ["integer", "null"] };
  assert.deepEqual(validateValue(doc, nullableInt, 7), []);
  assert.deepEqual(validateValue(doc, nullableInt, null), []);
  assert.equal(validateValue(doc, nullableInt, "no").length, 1);
});

test("validateValue keeps bounds + multi-type unions under 3.1 type-arrays", () => {
  // String bounds still apply to the string arm of a nullable string.
  const bounded: OpenApiSchema = { type: ["string", "null"], minLength: 2 };
  assert.deepEqual(validateValue(doc, bounded, "ok"), []);
  assert.deepEqual(validateValue(doc, bounded, null), []);
  assert.equal(validateValue(doc, bounded, "x").length, 1); // shorter than minLength

  // A genuine multi-type union (no null) accepts any listed type, rejects others.
  const strOrNum: OpenApiSchema = { type: ["string", "number"] };
  assert.deepEqual(validateValue(doc, strOrNum, "a"), []);
  assert.deepEqual(validateValue(doc, strOrNum, 1), []);
  assert.equal(validateValue(doc, strOrNum, true).length, 1);
  assert.equal(validateValue(doc, strOrNum, null).length, 1); // null not permitted without "null"
});

test("validateValue rejects non-null values for a null-only schema (type: [null] / type: null)", () => {
  // A schema whose only declared type is "null" must accept null and reject everything else — the
  // value-type list is empty, so the type check must fall back to the full `type` list.
  const nullOnlyArr: OpenApiSchema = { type: ["null"] };
  assert.deepEqual(validateValue(doc, nullOnlyArr, null), []);
  assert.equal(validateValue(doc, nullOnlyArr, "x").length, 1);
  assert.equal(validateValue(doc, nullOnlyArr, 0).length, 1);

  const nullOnlyStr: OpenApiSchema = { type: "null" };
  assert.deepEqual(validateValue(doc, nullOnlyStr, null), []);
  assert.equal(validateValue(doc, nullOnlyStr, "x").length, 1);
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

test("validateValue: a failed oneOf discriminant names the shapes and surfaces the closest variant", () => {
  // The Camunda-style discriminated request body: exactly one of two mutually-exclusive variants
  // (mutual exclusion enforced by additionalProperties:false + a distinct required discriminant).
  const byPr: OpenApiSchema = {
    type: "object",
    additionalProperties: false,
    required: ["pr"],
    properties: { pr: { type: "string" }, maxRounds: { type: "integer" } },
  };
  const byUrl: OpenApiSchema = {
    type: "object",
    additionalProperties: false,
    required: ["url"],
    properties: { url: { type: "string" }, maxRounds: { type: "integer" } },
  };
  const start: OpenApiSchema = { oneOf: [byPr, byUrl] };

  // Neither discriminant supplied → matched 0. The summary must NAME the allowed shapes, and the
  // closest variant's own issue must be surfaced (not just the opaque "matched 0").
  const none = validateValue(doc, start, { maxRounds: 3 }, "body");
  assert.ok(none.length > 0, "an empty discriminant is rejected");
  assert.ok(
    none.some((i) => /allowed:.*\{pr\}.*\|.*\{url\}/.test(i.message)),
    `summary names the allowed shapes: ${JSON.stringify(none)}`,
  );
  assert.ok(
    none.some((i) => i.path === "body/pr" && /required/.test(i.message)),
    `closest variant's field issue is surfaced: ${JSON.stringify(none)}`,
  );

  // Both discriminants supplied → with additionalProperties:false, EACH variant rejects the other's
  // field, so this is also "matches none" (the desirable strictness — a body can't smuggle both).
  const both = validateValue(doc, start, { pr: "a/b#1", url: "http://x" }, "body");
  assert.ok(
    both.some((i) => /does not match any of the 2 allowed shapes/.test(i.message)),
    `supplying both discriminants is rejected by the strict variants: ${JSON.stringify(both)}`,
  );

  // Exactly one discriminant → valid.
  assert.equal(validateValue(doc, start, { pr: "a/b#1" }, "body").length, 0);

  // `anyOf` no-match reporting mirrors `oneOf`: name the allowed shapes AND surface the closest
  // variant's issues, so the improved diagnostics are guarded for the union branch too. Here a value
  // matches NEITHER discriminated variant, and `{pr}` is the closest (its own field is the issue).
  const anyStart: OpenApiSchema = { anyOf: [byPr, byUrl] };
  const anyNone = validateValue(doc, anyStart, { maxRounds: 3 }, "body");
  assert.ok(anyNone.length > 0, "a value matching no anyOf variant is rejected");
  assert.ok(
    anyNone.some((i) => /allowed:.*\{pr\}.*\|.*\{url\}/.test(i.message)),
    `anyOf summary names the allowed shapes: ${JSON.stringify(anyNone)}`,
  );
  assert.ok(
    anyNone.some((i) => i.path === "body/pr" && /required/.test(i.message)),
    `anyOf surfaces the closest variant's field issue: ${JSON.stringify(anyNone)}`,
  );

  // The "matched more than one" branch: genuinely overlapping (non-exclusive) variants. A value that
  // satisfies two shapes is ambiguous and must be reported as such.
  const overlapping: OpenApiSchema = { oneOf: [{ type: "integer" }, { type: "integer", minimum: 10 }] };
  const ambiguous = validateValue(doc, overlapping, 20, "n");
  assert.ok(
    ambiguous.some((i) => /must match exactly one of the 2 allowed shapes, but matched 2/.test(i.message)),
    `ambiguous (multi-match) is reported: ${JSON.stringify(ambiguous)}`,
  );
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

test("isMutatingMethod: the HTTP safe verbs (get/head/options) are read-only, everything else mutates", () => {
  // OPTIONS is a CORS/preflight metadata probe — a safe, non-mutating verb (RFC 9110 §9.2.1). It must
  // NOT be flagged mutating, or an `options` operation is wrongly marked destructive in tools/list and
  // captured as a "mutating" fact by the spec↔tool parity snapshot.
  for (const safe of ["get", "head", "options"] as const) {
    assert.equal(isMutatingMethod(safe), false, `${safe} must be treated as read-only`);
  }
  for (const mutating of ["put", "post", "delete", "patch"] as const) {
    assert.equal(isMutatingMethod(mutating), true, `${mutating} must be treated as mutating`);
  }
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

// ── Security (ADR 0059: one HTTP surface, apiKey-guarded webhook operations) ──────────────────

const secured: OpenApiDoc = {
  openapi: "3.0.0",
  components: {
    securitySchemes: {
      webhookKey: {
        type: "apiKey",
        in: "header",
        name: "X-Webhook-Key",
        "x-nano-secret-env": "NANO_WEBHOOK_KEY",
      },
      queryKey: {
        type: "apiKey",
        in: "query",
        name: "key",
        "x-nano-secret-env": "NANO_QUERY_KEY",
      },
    },
  },
  security: [{ webhookKey: [] }], // document-level default
  paths: {
    "/hooks/submit": {
      post: { operationId: "submitHook", responses: { "204": {} } }, // inherits the default
    },
    "/hooks/open": {
      post: { operationId: "openHook", security: [], responses: { "204": {} } }, // opts out
    },
    "/hooks/query": {
      post: {
        operationId: "queryHook",
        security: [{ queryKey: [] }],
        responses: { "204": {} },
      },
    },
  },
};

const noHeader = (): undefined => undefined;
const noQuery = (): undefined => undefined;
const secret = (vars: Record<string, string>) => (v: string): string | undefined => vars[v];

test("collectOperations resolves effective security (op-level wins, explicit [] opts out, doc default inherited)", () => {
  const ops = collectOperations(secured);
  const byId = Object.fromEntries(ops.map((o) => [o.operationId, o]));
  assert.deepEqual(byId.submitHook.security, [{ webhookKey: [] }]); // inherited default
  assert.deepEqual(byId.openHook.security, []); // explicit opt-out
  assert.deepEqual(byId.queryHook.security, [{ queryKey: [] }]); // own requirement
});

test("evaluateSecurity: an open operation (no requirement) is always authorized", () => {
  const open = collectOperations(secured).find((o) => o.operationId === "openHook")!;
  assert.deepEqual(
    evaluateSecurity(secured, open, noHeader, noQuery, secret({})),
    { ok: true },
  );
});

test("evaluateSecurity: a valid apiKey header authorizes; wrong/absent → 401", () => {
  const op = collectOperations(secured).find((o) => o.operationId === "submitHook")!;
  const env = secret({ NANO_WEBHOOK_KEY: "s3cret" });
  // Correct key.
  assert.equal(
    evaluateSecurity(secured, op, (n) => (n === "X-Webhook-Key" ? "s3cret" : undefined), noQuery, env).ok,
    true,
  );
  // Wrong key → 401.
  assert.deepEqual(
    evaluateSecurity(secured, op, () => "nope", noQuery, env),
    { ok: false, status: 401, error: "unauthorized" },
  );
  // Missing key → 401.
  assert.deepEqual(evaluateSecurity(secured, op, noHeader, noQuery, env), {
    ok: false,
    status: 401,
    error: "unauthorized",
  });
});

test("evaluateSecurity: an apiKey in query is read from the query, not the header", () => {
  const op = collectOperations(secured).find((o) => o.operationId === "queryHook")!;
  const env = secret({ NANO_QUERY_KEY: "qk" });
  assert.equal(
    evaluateSecurity(secured, op, noHeader, (n) => (n === "key" ? "qk" : undefined), env).ok,
    true,
  );
  assert.equal(evaluateSecurity(secured, op, noHeader, () => "bad", env).status, 401);
});

test("evaluateSecurity: an unset secret env is a 500 misconfiguration (fail closed, not 401)", () => {
  const op = collectOperations(secured).find((o) => o.operationId === "submitHook")!;
  const decision = evaluateSecurity(secured, op, () => "anything", noQuery, secret({}));
  assert.equal(decision.ok, false);
  assert.equal(decision.status, 500);
  assert.match(decision.error ?? "", /NANO_WEBHOOK_KEY is not set/);
});

test("evaluateSecurity: a requirement naming an undeclared scheme is a 500 misconfiguration", () => {
  const doc: OpenApiDoc = {
    openapi: "3.0.0",
    components: { securitySchemes: {} },
    paths: {
      "/x": { post: { operationId: "x", security: [{ ghost: [] }], responses: { "204": {} } } },
    },
  };
  const op = collectOperations(doc)[0];
  const decision = evaluateSecurity(doc, op, () => "k", noQuery, secret({}));
  assert.equal(decision.status, 500);
  assert.match(decision.error ?? "", /not declared/);
  assert.deepEqual(undeclaredSecuritySchemes(doc), ["ghost (POST /x)"]);
});


test("evaluateSecurity: malformed security entries fail closed as a 500 misconfiguration", () => {
  const doc: OpenApiDoc = {
    openapi: "3.0.0",
    components: {
      securitySchemes: { webhookKey: { type: "apiKey", in: "header", name: "X-Key", "x-nano-secret-env": "KEY" } },
    },
    paths: {
      "/x": { post: { operationId: "x", security: ["webhookKey"], responses: { "204": {} } } },
    },
  };
  const op = collectOperations(doc)[0];
  const decision = evaluateSecurity(doc, op, () => "secret", noQuery, secret({ KEY: "secret" }));
  assert.equal(decision.status, 500);
  assert.match(decision.error ?? "", /malformed security requirement/);
});

test("evaluateSecurity: an unsupported scheme type is a 500 misconfiguration", () => {
  const doc: OpenApiDoc = {
    openapi: "3.0.0",
    components: { securitySchemes: { oauth: { type: "oauth2" } } },
    paths: {
      "/x": { post: { operationId: "x", security: [{ oauth: [] }], responses: { "204": {} } } },
    },
  };
  const op = collectOperations(doc)[0];
  const decision = evaluateSecurity(doc, op, () => "k", noQuery, secret({}));
  assert.equal(decision.status, 500);
  assert.match(decision.error ?? "", /unsupported type "oauth2"/);
});

test("evaluateSecurity: alternative requirements are OR (any one satisfied authorizes)", () => {
  const doc: OpenApiDoc = {
    openapi: "3.0.0",
    components: {
      securitySchemes: {
        a: { type: "apiKey", in: "header", name: "A", "x-nano-secret-env": "A_KEY" },
        b: { type: "apiKey", in: "header", name: "B", "x-nano-secret-env": "B_KEY" },
      },
    },
    paths: {
      "/x": {
        post: { operationId: "x", security: [{ a: [] }, { b: [] }], responses: { "204": {} } },
      },
    },
  };
  const op = collectOperations(doc)[0];
  const env = secret({ A_KEY: "aa", B_KEY: "bb" });
  // Only B presented → still authorized (OR).
  assert.equal(
    evaluateSecurity(doc, op, (n) => (n === "B" ? "bb" : undefined), noQuery, env).ok,
    true,
  );
  // Neither presented → 401.
  assert.equal(evaluateSecurity(doc, op, noHeader, noQuery, env).status, 401);
});

test("responseSchemaForStatus: a documented-but-bodyless status suppresses the default fallback", () => {
  const ops = collectOperations({
    openapi: "3.1.0",
    paths: {
      "/x": {
        get: {
          operationId: "getX",
          responses: {
            "204": {}, // documented, no JSON body
            default: { content: { "application/json": { schema: { type: "object" } } } },
          },
        },
      },
    },
  });
  const entries = ops[0].responseSchemas;
  // 204 IS documented (just bodyless) → no validation, and it must NOT fall through to `default`.
  assert.equal(responseSchemaForStatus(entries, 204), undefined);
  // 500 is undocumented → falls through to `default`.
  assert.equal(responseSchemaForStatus(entries, 500)?.type, "object");
});

test("responseSchemaForStatus: a status-range ('2XX') covers concrete statuses in its class", () => {
  const ops = collectOperations({
    openapi: "3.1.0",
    paths: {
      "/y": {
        get: {
          operationId: "getY",
          responses: {
            "2XX": { content: { "application/json": { schema: { type: "string" } } } },
            default: { content: { "application/json": { schema: { type: "object" } } } },
          },
        },
      },
    },
  });
  const entries = ops[0].responseSchemas;
  assert.equal(entries.map((e) => e.status).join(","), "2XX,default"); // ranges before default
  assert.equal(responseSchemaForStatus(entries, 200)?.type, "string"); // 2XX class → range schema
  assert.equal(responseSchemaForStatus(entries, 404)?.type, "object"); // outside 2XX → default
});

test("sharedRequestBodySchemas: flags a requestBody $ref reused across operations, ignores single-use", () => {
  const jsonRef = (ref: string) => ({ requestBody: { content: { "application/json": { schema: { $ref: ref } } } } });
  const doc: OpenApiDoc = {
    openapi: "3.1.0",
    components: {
      schemas: {
        StartVariables: { type: "object" },
        FeatureAnswer: { type: "object" },
      },
    },
    paths: {
      // Two operations share the SAME loose body schema — the defect fingerprint.
      "/convergence": { post: { operationId: "startConvergenceLoop", ...jsonRef("#/components/schemas/StartVariables") } },
      "/fanout": { post: { operationId: "startPlanFanout", ...jsonRef("#/components/schemas/StartVariables") } },
      // A distinct, single-use body — must NOT be flagged.
      "/feature": { post: { operationId: "answerFeature", ...jsonRef("#/components/schemas/FeatureAnswer") } },
      // An inline (non-$ref) body — no shared identity to compare, must NOT be flagged.
      "/inline": { post: { operationId: "inlineBody", requestBody: { content: { "application/json": { schema: { type: "object" } } } } } },
    },
  };

  const shared = sharedRequestBodySchemas(doc);
  assert.equal(shared.length, 1, `only the reused ref is flagged: ${JSON.stringify(shared)}`);
  assert.equal(shared[0].ref, "#/components/schemas/StartVariables");
  assert.deepEqual(shared[0].operationIds, ["startConvergenceLoop", "startPlanFanout"]); // sorted
});
