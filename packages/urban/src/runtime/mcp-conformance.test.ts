import assert from "node:assert/strict";
import { test } from "node:test";

import { collectOperations, parseSpec } from "../openapi/spec.ts";
import {
  type BodyNormalizer,
  CONSUMER_SPECS,
  findSpecConformanceViolations,
  loadConsumerSpec,
  runConsumerConformance,
} from "./mcp-conformance.ts";
import { normalizeBodyArg, structuredBodyKind, effectiveRequestBodySchema } from "./core/modules/mcp.ts";

// The whole corpus conforms: every projected tool in every vendored real consumer spec is
// self-contained (P0 #502) and every object-body op round-trips through the real transport (P1 #503).
test("consumer conformance corpus projects only conformant MCP tools", () => {
  const results = runConsumerConformance();
  assert.ok(results.length > 0, "expected at least one vendored consumer spec");
  for (const { label, violations } of results) {
    assert.deepEqual(violations, [], `${label} should project conformant tools, got:\n${violations.join("\n")}`);
  }
});

// Guard against a VACUOUS pass: the vendored spec must actually contain the shape the projection
// previously broke on — projected, non-excluded, structured-body operations — or the round-trip
// property below never runs and the guard proves nothing.
test("nano-workforce spec actually exercises the structured-body projection path", () => {
  const spec = CONSUMER_SPECS.find((s) => s.label === "nano-workforce");
  assert.ok(spec, "nano-workforce must be in the corpus");
  const doc = loadConsumerSpec(spec);
  const structured = collectOperations(doc).filter(
    (op) => !op.mcpExcluded && structuredBodyKind(effectiveRequestBodySchema(op, doc)) !== undefined,
  );
  assert.ok(
    structured.length > 0,
    "expected nano-workforce to project at least one non-excluded object/array-body tool",
  );
});

// The pinned ref recorded in code is the single source of truth; keep it a 40-hex commit SHA so a
// refresh cannot land a mutable ref (branch/tag) that would make the guard non-deterministic.
test("every consumer spec is pinned to a concrete commit SHA", () => {
  for (const spec of CONSUMER_SPECS) {
    assert.match(spec.ref, /^[0-9a-f]{40}$/, `${spec.label} ref must be a full commit SHA, got ${spec.ref}`);
  }
});

// Negative — REINTRODUCED DOUBLE-ENCODING: a transport that leaves a pre-encoded string body a
// string (the pre-P1 #503 behaviour) must make the conformance guard FAIL on the real spec.
test("a reintroduced double-encoding path fails conformance", () => {
  const spec = CONSUMER_SPECS.find((s) => s.label === "nano-workforce");
  assert.ok(spec);
  const doc = loadConsumerSpec(spec);

  const doubleEncoding: BodyNormalizer = (_op, args) => ({ ok: true, args }); // never parses a string body

  const violations = findSpecConformanceViolations(spec.label, doc, doubleEncoding);
  assert.ok(violations.length > 0, "double-encoding transport must be caught");
  assert.ok(
    violations.some((v) => v.includes("double-encoding path was reintroduced")),
    `expected a double-encoding violation, got:\n${violations.join("\n")}`,
  );
});

// Positive control: with the REAL transport the same spec conforms — so the negative test above is
// detecting the injected regression, not a pre-existing failure.
test("the real transport conforms on the same spec", () => {
  const spec = CONSUMER_SPECS.find((s) => s.label === "nano-workforce");
  assert.ok(spec);
  const doc = loadConsumerSpec(spec);
  assert.deepEqual(findSpecConformanceViolations(spec.label, doc, normalizeBodyArg), []);
});

// Negative — REINTRODUCED $ref LEAK: a body whose `$ref` cannot be made self-contained (dangling
// component) must fail the guard rather than leak an opaque `#/components/...` pointer to a client.
test("an unresolvable $ref body fails conformance", () => {
  const doc = parseSpec(`
openapi: 3.0.0
info: { title: leak, version: "1" }
paths:
  /widgets:
    post:
      operationId: createWidget
      requestBody:
        required: true
        content:
          application/json:
            schema: { $ref: "#/components/schemas/DoesNotExist" }
      responses:
        "200": { description: ok }
components:
  schemas: {}
`);
  const violations = findSpecConformanceViolations("leak-fixture", doc);
  assert.ok(violations.length > 0, "an unresolvable $ref body must be caught");
  assert.ok(
    violations.some((v) => v.includes("projection failed")),
    `expected a projection-failure violation, got:\n${violations.join("\n")}`,
  );
});

// Negative — a `body` that projects WITHOUT an explicit `type` (P0's other property) is caught: a
// client cannot tell it is an object/array and mis-encodes the argument.
test("a body schema without an explicit type fails conformance", () => {
  const doc = parseSpec(`
openapi: 3.0.0
info: { title: untyped, version: "1" }
paths:
  /widgets:
    post:
      operationId: createWidget
      requestBody:
        required: true
        content:
          application/json:
            schema:
              properties:
                name: { type: string }
      responses:
        "200": { description: ok }
`);
  const violations = findSpecConformanceViolations("untyped-fixture", doc);
  assert.ok(
    violations.some((v) => v.includes("no explicit `type`")),
    `expected an explicit-type violation, got:\n${violations.join("\n")}`,
  );
});
