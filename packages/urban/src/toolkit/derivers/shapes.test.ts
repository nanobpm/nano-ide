import { test } from "node:test";
import assert from "node:assert/strict";
import {
  emitDomainModelJson,
  resolveShapes,
  scanModelShapes,
  type ShapeDecl,
} from "./shapes.ts";
import type { DomainTypeRegistry, SourceSchema } from "./domain.ts";

// The fuse + its drift guards, ported byte-for-byte from the console's `resolveShapes` /
// `emitDomainModelJson` tests (server domain_types_test.ts) — the toolkit is now the single source
// of truth for the IDE's shape fuse (host dry-out nano-bpm#576), so these lock the same behaviour.

test("emitDomainModelJson fuses tables, manifest types, shapes, and metadata", () => {
  const json = emitDomainModelJson({
    sources: [
      {
        source: "app",
        tables: [
          {
            name: "orders",
            kind: "table",
            columns: [{ name: "id", type: "INTEGER", notNull: true, primaryKey: true }],
            indexes: [],
            foreignKeys: [],
          },
        ],
      },
    ],
    default: "app",
    manifestTypes: { Order: { fields: { item: { type: "string" } } } },
    shapes: [
      {
        decl: { id: "ApprovedOrder", process: "orders", ops: [] },
        def: { fields: { item: { type: "string" }, approved: { type: "boolean" } } },
      },
    ],
    meta: [{ process: "orders", key: "classification", value: "internal" }],
    diagnostics: [],
  });
  const model = JSON.parse(json);
  assert.equal(model.version, 1);
  assert.equal(model.default, "app");
  assert.equal(typeof model.inputsHash, "string");
  assert.equal(model.inputsHash.length > 0, true);
  const byId = new Map<string, { kind: string; provenance: string }>(
    model.entities.map((e: { id: string; kind: string; provenance: string }) => [e.id, e]),
  );
  assert.equal(byId.get("app.orders")?.kind, "table");
  assert.equal(byId.get("app.orders")?.provenance, "db:app.orders");
  assert.equal(byId.get("Order")?.kind, "type");
  assert.equal(byId.get("Order")?.provenance, "manifest:Order");
  assert.equal(byId.get("ApprovedOrder")?.kind, "shape");
  assert.equal(byId.get("ApprovedOrder")?.provenance, "model:orders");
  assert.deepEqual(model.meta, [{ process: "orders", key: "classification", value: "internal" }]);
});

test("emitDomainModelJson inputsHash is stable across calls and shifts on any change", () => {
  const base = {
    sources: [],
    manifestTypes: { Order: { fields: { item: { type: "string" } } } },
    shapes: [],
    meta: [{ key: "owner", value: "sre" }],
    diagnostics: [],
  };
  const a = JSON.parse(emitDomainModelJson({ ...base }));
  const b = JSON.parse(emitDomainModelJson({ ...base }));
  assert.equal(a.inputsHash, b.inputsHash); // deterministic
  const changed = JSON.parse(
    emitDomainModelJson({ ...base, meta: [{ key: "owner", value: "ops" }] }),
  );
  assert.equal(changed.inputsHash !== a.inputsHash, true); // staleness detectable
});

test("resolveShapes reifies an all-extend shape into a flat domain type", () => {
  const shapes: ShapeDecl[] = [
    {
      id: "PrReviewRoundIn",
      name: "PR review round — input",
      ops: [
        { op: "extend", name: "prUrl", type: "string" },
        { op: "extend", name: "prNumber", type: "integer" },
        { op: "extend", name: "answer", type: "string", optional: true },
        { op: "extend", name: "labels", type: "string", list: true },
      ],
    },
  ];
  const { types, diagnostics } = resolveShapes(shapes, {}, []);
  assert.deepEqual(diagnostics, []);
  assert.deepEqual(types.PrReviewRoundIn, {
    name: "PR review round — input",
    fields: {
      prUrl: { type: "string" },
      prNumber: { type: "integer" },
      answer: { type: "string", optional: true },
      labels: { type: "string", list: true },
    },
  });
});

test("resolveShapes drift-guards a shape id colliding with a manifest type", () => {
  const shapes: ShapeDecl[] = [
    { id: "Order", ops: [{ op: "extend", name: "item", type: "string" }] },
  ];
  const manifest: DomainTypeRegistry = { Order: { fields: { item: { type: "string" } } } };
  const { types, diagnostics } = resolveShapes(shapes, manifest, []);
  assert.deepEqual(Object.keys(types), []); // shape omitted — no silent shadow
  assert.equal(diagnostics.length, 1);
  assert.equal(diagnostics[0].kind, "same-id-collision");
  assert.equal(diagnostics[0].severity, "error");
  assert.equal(diagnostics[0].shape, "Order");
});

test("resolveShapes treats a qualified-alias carry of the colliding leaf as composed", () => {
  // The shape id `orders` collides with the `app.orders` leaf, but it composes that same leaf via
  // its unambiguous `app.orders` alias. Since both ids point at the one entity, this is a legitimate
  // compose — not a same-id shadow — so no collision is raised.
  const sources: SourceSchema[] = [
    {
      source: "app",
      tables: [
        {
          name: "orders",
          kind: "table",
          columns: [{ name: "id", type: "INTEGER", notNull: true, primaryKey: true }],
          indexes: [],
          foreignKeys: [],
        },
      ],
    },
  ];
  const shapes: ShapeDecl[] = [{ id: "orders", ops: [{ op: "carry", ref: "app.orders" }] }];
  const { types, diagnostics } = resolveShapes(shapes, {}, sources);
  assert.equal(
    diagnostics.some((d) => d.kind === "same-id-collision"),
    false,
  );
  assert.ok(types.orders); // the shape resolves rather than being omitted
  assert.deepEqual(Object.keys(types.orders.fields), ["id"]);
});

test("resolveShapes rejects a duplicate shape id as a fuse-identity collision", () => {
  const shapes: ShapeDecl[] = [
    { id: "Dup", ops: [{ op: "extend", name: "a", type: "string" }] },
    { id: "Dup", ops: [{ op: "extend", name: "b", type: "string" }] },
  ];
  const { types, diagnostics } = resolveShapes(shapes, {}, []);
  assert.deepEqual(Object.keys(types), []); // both omitted
  assert.equal(diagnostics.length, 1);
  assert.equal(diagnostics[0].kind, "duplicate-id");
  assert.equal(diagnostics[0].severity, "error");
});

test("resolveShapes flags an extend whose type is neither scalar nor a fused entity", () => {
  const shapes: ShapeDecl[] = [
    { id: "Bad", ops: [{ op: "extend", name: "ref", type: "NoSuchType" }] },
  ];
  const { types, diagnostics } = resolveShapes(shapes, {}, []);
  assert.deepEqual(Object.keys(types), []); // broken shape omitted
  assert.equal(diagnostics.length, 1);
  assert.equal(diagnostics[0].kind, "unresolved-reference");
  assert.equal(diagnostics[0].severity, "error");
});

test("resolveShapes returns an empty resolution for no shapes", () => {
  const { types, diagnostics } = resolveShapes(
    [],
    { Order: { fields: { item: { type: "string" } } } },
    [],
  );
  assert.deepEqual(types, {});
  assert.deepEqual(diagnostics, []);
});

// --- scanModelShapes: the standalone-`urban gen` port of the `nano:shape` XML scan --------------

const SHAPES_BPMN = `<?xml version="1.0"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"
  xmlns:nano="http://nanobpm.io/schema/nano/1.0">
  <bpmn:process id="p1">
    <bpmn:extensionElements>
      <nano:shapes>
        <nano:shape id="ReviewIn" name="Review — input">
          <nano:extend name="prUrl" type="string" />
          <nano:extend name="round" type="integer" />
          <nano:extend name="answer" type="string" optional="true" />
        </nano:shape>
        <nano:shape id="Composed">
          <nano:carry ref="ReviewIn" />
          <nano:project ref="Customer" fields="tier, region" via="Order.customerId" />
          <nano:reference name="lines" ref="OrderLine" spread="false" list="true" />
        </nano:shape>
        <nano:shape name="no-id-dropped"><nano:carry ref="ReviewIn" /></nano:shape>
      </nano:shapes>
    </bpmn:extensionElements>
  </bpmn:process>
</bpmn:definitions>`;

test("scanModelShapes lifts nano:shape declarations with ops in author order", () => {
  const shapes = scanModelShapes(SHAPES_BPMN);
  // The id-less shape is dropped; the two identified shapes survive, process-tagged.
  assert.deepEqual(shapes.map((s) => s.id), ["ReviewIn", "Composed"]);
  assert.equal(shapes[0].process, "p1");
  assert.equal(shapes[0].name, "Review — input");
  assert.deepEqual(shapes[0].ops, [
    { op: "extend", name: "prUrl", type: "string", optional: false, list: false },
    { op: "extend", name: "round", type: "integer", optional: false, list: false },
    { op: "extend", name: "answer", type: "string", optional: true, list: false },
  ]);
  assert.deepEqual(shapes[1].ops, [
    { op: "carry", ref: "ReviewIn" },
    { op: "project", ref: "Customer", fields: ["tier", "region"], via: "Order.customerId" },
    { op: "reference", name: "lines", ref: "OrderLine", spread: false, list: true },
  ]);
});

test("scanModelShapes → resolveShapes round-trips an all-extend envelope into DomainTypes", () => {
  const shapes = scanModelShapes(SHAPES_BPMN).filter((s) => s.id === "ReviewIn");
  const { types, diagnostics } = resolveShapes(shapes, {}, []);
  assert.deepEqual(diagnostics, []);
  assert.deepEqual(types.ReviewIn.fields, {
    prUrl: { type: "string" },
    round: { type: "integer" },
    answer: { type: "string", optional: true },
  });
});

test("scanModelShapes drops an op missing a required attribute", () => {
  const xml = `<bpmn:process id="p"><bpmn:extensionElements><nano:shapes>
    <nano:shape id="S">
      <nano:extend name="ok" type="string" />
      <nano:extend name="noType" />
      <nano:carry />
    </nano:shape>
  </nano:shapes></bpmn:extensionElements></bpmn:process>`;
  const [s] = scanModelShapes(xml);
  assert.deepEqual(s.ops, [{ op: "extend", name: "ok", type: "string", optional: false, list: false }]);
});
