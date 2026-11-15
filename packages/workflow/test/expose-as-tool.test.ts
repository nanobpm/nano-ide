// exposeAsTool: a flow exposed as an MCP tool (nanobpm/nano-ide#620). The start
// event becomes a MESSAGE start carrying Camunda's `io.camunda.tool:*` bindings,
// and Nano's typed `input_N_*` superset is DERIVED from the Start input envelope.
import { test } from "node:test";
import assert from "node:assert/strict";

import { defineFlow, envelope, toBpmn, declarativeToLayoutedBpmn } from "../dist/index.js";

const BookIn = envelope("BookIn", {
  destination: { type: "string", description: "Where to fly" },
  seats: "integer",
  note: { type: "string", optional: true },
  tags: { type: "string", list: true, optional: true },
});

const toolFlow = () =>
  defineFlow("book-trip", { Start: { in: BookIn } }, (w) => {
    w.exposeAsTool({
      name: "book_trip",
      purpose: "Book a trip",
      inputs: "destination & seats",
      whenToUse: "user wants to travel",
      whenNotToUse: "just browsing",
      results: "a booking id",
    });
    w.run("book", async () => ({}));
  });

const prop = (name: string, value: string) =>
  `<zeebe:property name="io.camunda.tool:${name}" value="${value}" />`;

test("exposeAsTool: message start event + bpmn:message", () => {
  const xml = toBpmn(toolFlow());
  assert.match(xml, /<bpmn:startEvent id="Start">[\s\S]*<bpmn:messageEventDefinition messageRef="Msg_Start" \/>\s*<\/bpmn:startEvent>/);
  assert.match(xml, /<bpmn:message id="Msg_Start" name="book-trip:Start" \/>/);
  // The input envelope property is kept alongside the tool properties.
  assert.match(xml, /io\.nanobpm\.dataEnvelope\.in" value="BookIn"/);
});

test("exposeAsTool: emits Camunda io.camunda.tool:* bindings", () => {
  const xml = toBpmn(toolFlow());
  for (const [k, v] of [
    ["name", "book_trip"],
    ["purpose", "Book a trip"],
    ["inputs", "destination &amp; seats"],
    ["when_to_use", "user wants to travel"],
    ["when_not_to_use", "just browsing"],
    ["results", "a booking id"],
  ]) {
    assert.ok(xml.includes(prop(k, v)), `missing ${k}`);
  }
});

test("exposeAsTool: input_N_* derived from the input envelope (1-based, JSON types)", () => {
  const xml = toBpmn(toolFlow());
  const expected = [
    prop("input_1_name", "destination"),
    prop("input_1_type", "string"),
    prop("input_1_description", "Where to fly"),
    prop("input_1_required", "true"),
    prop("input_2_name", "seats"),
    prop("input_2_type", "integer"),
    prop("input_2_required", "true"),
    prop("input_3_name", "note"),
    prop("input_3_type", "string"),
    prop("input_3_required", "false"),
    prop("input_4_name", "tags"),
    prop("input_4_type", "array"),
    prop("input_4_required", "false"),
  ];
  let at = 0;
  for (const e of expected) {
    const i = xml.indexOf(e, at);
    assert.ok(i >= 0, `missing/out of order: ${e}`);
    at = i;
  }
  assert.ok(!xml.includes("input_2_description"));
  assert.ok(!xml.includes("input_0_"));
});

test("exposeAsTool: optional bindings omitted; no input envelope → no input_N_*", () => {
  const xml = toBpmn(
    defineFlow("ping", (w) => {
      w.exposeAsTool({ name: "ping", purpose: "Ping" });
      w.run("pong", async () => ({}));
    }),
  );
  assert.ok(xml.includes(prop("name", "ping")));
  assert.ok(!xml.includes("when_to_use"));
  assert.ok(!xml.includes("input_1_"));
  assert.ok(!xml.includes("dataEnvelope"));
  assert.match(xml, /<bpmn:messageEventDefinition messageRef="Msg_Start" \/>/);
});

test("flows without exposeAsTool are unchanged (none start, no tool props)", () => {
  const xml = toBpmn(
    defineFlow("plain", { Start: { in: BookIn } }, (w) => {
      w.run("a", async () => ({}));
    }),
  );
  assert.ok(!xml.includes("io.camunda.tool"));
  assert.ok(!xml.includes("messageEventDefinition"));
  assert.ok(!xml.includes("Msg_Start"));
});

test("exposeAsTool: layouted model keeps DI for the start event", async () => {
  const xml = await declarativeToLayoutedBpmn(toolFlow());
  assert.match(xml, /<bpmndi:BPMNShape[^>]*bpmnElement="Start"/);
  assert.match(xml, /messageEventDefinition/);
});

test("exposeAsTool: authoring guards", () => {
  assert.throws(
    () => defineFlow("x", (w) => { w.run("a", async () => ({})); w.exposeAsTool({ name: "t", purpose: "p" }); }),
    /must precede every step/,
  );
  assert.throws(
    () => defineFlow("x", (w) => { w.exposeAsTool({ name: "t", purpose: "p" }); w.exposeAsTool({ name: "t", purpose: "p" }); w.run("a", async () => ({})); }),
    /only once/,
  );
  assert.throws(
    () => defineFlow("x", (w) => { w.startOn({ cycle: "R/PT1H" }); w.exposeAsTool({ name: "t", purpose: "p" }); w.run("a", async () => ({})); }),
    /cannot be combined with startOn/,
  );
  assert.throws(
    () => defineFlow("x", (w) => { w.exposeAsTool({ name: "t", purpose: "p" }); w.startOn({ cycle: "R/PT1H" }); w.run("a", async () => ({})); }),
    /startOn\(\) (must be the first|cannot be combined)/,
  );
  assert.throws(
    () => defineFlow("x", (w) => { w.exposeAsTool({ name: " ", purpose: "p" }); w.run("a", async () => ({})); }),
    /non-empty `name`/,
  );
  assert.throws(
    () => defineFlow("x", (w) => { w.exposeAsTool(JSON.parse('{"name":"t"}')); w.run("a", async () => ({})); }),
    /non-empty `purpose`/,
  );
});

test("exposeAsTool: rejects ids that would collide with the generated Msg_Start message", () => {
  // The tool start message is emitted as `<bpmn:message id="Msg_Start">` — a flow
  // id or input-envelope (nano:shape) name of `Msg_Start` would duplicate that id
  // and produce an invalid BPMN document. Rejected at authoring time, not emission.
  assert.throws(
    () =>
      defineFlow("Msg_Start", (w) => {
        w.exposeAsTool({ name: "t", purpose: "p" });
        w.run("a", async () => ({}));
      }),
    /flow id "Msg_Start" collides with the generated start message id/,
  );
  const MsgStartIn = envelope("Msg_Start", { q: "string" });
  assert.throws(
    () =>
      defineFlow("ok", { Start: { in: MsgStartIn } }, (w) => {
        w.exposeAsTool({ name: "t", purpose: "p" });
        w.run("a", async () => ({}));
      }),
    /input envelope "Msg_Start" collides with the generated start message id/,
  );
  // …but the same envelope is fine in a flow that is NOT exposed as a tool.
  const xml = toBpmn(defineFlow("ok", { Start: { in: MsgStartIn } }, (w) => w.run("a", async () => ({}))));
  assert.ok(xml.includes('<nano:shape id="Msg_Start">'));
});

test("exposeAsTool: rejects the reserved `businessId` input field", () => {
  // Nano's MCP tool surface treats `businessId` as reserved metadata (stripped from
  // the process variables before the instance starts), so an envelope field with
  // that name would never reach the flow — its declared input contract would lie.
  const BizIn = envelope("BizIn", { businessId: "string", q: "string" });
  assert.throws(
    () =>
      defineFlow("ok", { Start: { in: BizIn } }, (w) => {
        w.exposeAsTool({ name: "t", purpose: "p" });
        w.run("a", async () => ({}));
      }),
    /input field "businessId" is reserved/,
  );
  // Optional or typed variants are equally reserved.
  const BizOpt = envelope("BizOpt", { businessId: { type: "integer", optional: true } });
  assert.throws(
    () =>
      defineFlow("ok", { Start: { in: BizOpt } }, (w) => {
        w.exposeAsTool({ name: "t", purpose: "p" });
        w.run("a", async () => ({}));
      }),
    /input field "businessId" is reserved/,
  );
  // …but the same envelopes are fine in a flow that is NOT exposed as a tool.
  const xml = toBpmn(defineFlow("ok", { Start: { in: BizIn } }, (w) => w.run("a", async () => ({}))));
  assert.ok(xml.includes('name="businessId" type="string"'));
});

test("envelope: description is carried on the field and validated", () => {
  assert.equal(BookIn.fields[0].description, "Where to fly");
  assert.equal("description" in BookIn.fields[1], false);
  assert.throws(() => envelope("Bad", JSON.parse('{"a":{"type":"string","description":1}}')), /description must be a string/);
});
