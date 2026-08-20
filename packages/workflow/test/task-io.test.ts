// Unit + validation tests for the general service-task `<zeebe:ioMapping>` on
// `w.task` / `w.run` (issue #405): an optional `{ io: { input?, output? } }`
// declaring arbitrary variable mappings on a plain external/local service task,
// reusing the SHARED ioMapping shape (`HumanIoMapping` / `HumanIoEntry`) that
// `w.human` already uses — no parallel type. The emitter produces a single,
// correctly-ordered `<zeebe:ioMapping>` after `taskDefinition`
// (and after `linkedResources` when a prompt is present), and merges an explicit
// `io.input` with a `prompt.append` into ONE mapping. Run against `dist`.
import { test } from "node:test";
import assert from "node:assert/strict";

import { defineFlow, envelope, toBpmn } from "../dist/index.js";
import type { HumanIoMapping } from "../dist/index.js";

// Slice out a single serviceTask element by id (mirrors task-prompt.test.ts).
function serviceTask(xml: string, id: string): string {
  const start = xml.indexOf(`<bpmn:serviceTask id="${id}"`);
  assert.notEqual(start, -1, `serviceTask id="${id}" not found`);
  const end = xml.indexOf("</bpmn:serviceTask>", start);
  assert.notEqual(end, -1, `closing </bpmn:serviceTask> for id="${id}" not found`);
  return xml.slice(start, end + "</bpmn:serviceTask>".length);
}

// Count non-overlapping occurrences of a substring.
function count(hay: string, needle: string): number {
  let n = 0;
  let i = hay.indexOf(needle);
  while (i !== -1) {
    n++;
    i = hay.indexOf(needle, i + needle.length);
  }
  return n;
}

// --- Emission -------------------------------------------------------------

test("task io: emits a single zeebe:ioMapping with the declared input entries", () => {
  const flow = defineFlow("io-demo", (w) => {
    w.task("record-conformance-ack", {
      jobType: "pr.conformance-ack",
      io: {
        input: [
          { source: "=planKey", target: "planKey" },
          { source: "=if (is defined(note)) then note else null", target: "note" },
        ],
      },
    });
  });
  const el = serviceTask(toBpmn(flow), "record-conformance-ack");
  assert.match(el, /<zeebe:taskDefinition type="pr.conformance-ack" \/>/);
  assert.match(el, /<zeebe:ioMapping>/);
  assert.match(el, /<zeebe:input source="=planKey" target="planKey" \/>/);
  assert.match(
    el,
    /<zeebe:input source="=if \(is defined\(note\)\) then note else null" target="note" \/>/,
  );
  assert.equal(count(el, "<zeebe:ioMapping>"), 1);
  // No prompt → no linkedResources.
  assert.doesNotMatch(el, /linkedResource/);
});

test("task io: the ioMapping is emitted AFTER the taskDefinition (golden element order)", () => {
  const el = serviceTask(
    toBpmn(
      defineFlow("io-demo", (w) => {
        w.task("t", { jobType: "svc:t", io: { input: [{ source: "=x", target: "x" }] } });
      }),
    ),
    "t",
  );
  assert.ok(
    el.indexOf("<zeebe:taskDefinition") < el.indexOf("<zeebe:ioMapping>"),
    "taskDefinition must precede ioMapping",
  );
});

test("task io: output-only mapping emits <zeebe:output> and no <zeebe:input>", () => {
  const el = serviceTask(
    toBpmn(
      defineFlow("io-demo", (w) => {
        w.task("t", { jobType: "svc:t", io: { output: [{ source: "=result", target: "outcome" }] } });
      }),
    ),
    "t",
  );
  assert.match(el, /<zeebe:output source="=result" target="outcome" \/>/);
  assert.doesNotMatch(el, /<zeebe:input/);
});

test("task io: input mappings precede output mappings within the single ioMapping", () => {
  const el = serviceTask(
    toBpmn(
      defineFlow("io-demo", (w) => {
        w.task("t", {
          jobType: "svc:t",
          io: { input: [{ source: "=a", target: "a" }], output: [{ source: "=b", target: "b" }] },
        });
      }),
    ),
    "t",
  );
  assert.equal(count(el, "<zeebe:ioMapping>"), 1);
  assert.ok(el.indexOf("<zeebe:input") < el.indexOf("<zeebe:output"), "inputs precede outputs");
});

test("task io: XML metacharacters in a FEEL mapping are escaped", () => {
  const el = serviceTask(
    toBpmn(
      defineFlow("io-demo", (w) => {
        w.task("t", { jobType: "svc:t", io: { input: [{ source: '=a < b and c = "x"', target: "r" }] } });
      }),
    ),
    "t",
  );
  assert.match(el, /source="=a &lt; b and c = &quot;x&quot;"/);
});

test("task io: absent io preserves the plain service task (no ioMapping)", () => {
  const el = serviceTask(
    toBpmn(defineFlow("io-demo", (w) => { w.task("t", { jobType: "svc:t" }); })),
    "t",
  );
  assert.doesNotMatch(el, /ioMapping/);
});

test("task io: an empty io object emits NO ioMapping (nothing to map)", () => {
  const emptyIo: HumanIoMapping = JSON.parse("{}");
  const el = serviceTask(
    toBpmn(defineFlow("io-demo", (w) => { w.task("t", { jobType: "svc:t", io: emptyIo }); })),
    "t",
  );
  assert.doesNotMatch(el, /ioMapping/);
});

// --- Merge with prompt.append --------------------------------------------

test("task io + prompt.append: merge into ONE ioMapping (explicit inputs then appendPrompt)", () => {
  const el = serviceTask(
    toBpmn(
      defineFlow("io-demo", (w) => {
        w.task("agent", {
          jobType: "senior:x",
          prompt: { resourceId: "x.md", append: "=extraContext" },
          io: { input: [{ source: "=planKey", target: "planKey" }] },
        });
      }),
    ),
    "agent",
  );
  // Exactly one ioMapping, carrying BOTH the explicit input and the appendPrompt input.
  assert.equal(count(el, "<zeebe:ioMapping>"), 1);
  assert.match(el, /<zeebe:input source="=planKey" target="planKey" \/>/);
  assert.match(el, /<zeebe:input source="=extraContext" target="appendPrompt" \/>/);
  // Explicit input precedes the appended prompt input.
  assert.ok(
    el.indexOf('target="planKey"') < el.indexOf('target="appendPrompt"'),
    "explicit io.input precedes the appendPrompt input",
  );
  // linkedResources precedes the (single) ioMapping.
  assert.ok(
    el.indexOf("<zeebe:linkedResources>") < el.indexOf("<zeebe:ioMapping>"),
    "linkedResources precedes ioMapping",
  );
});

test("task io + prompt (no append): the io mapping stands alone after linkedResources", () => {
  const el = serviceTask(
    toBpmn(
      defineFlow("io-demo", (w) => {
        w.task("agent", {
          jobType: "senior:x",
          prompt: { resourceId: "x.md" },
          io: { output: [{ source: "=y", target: "y" }] },
        });
      }),
    ),
    "agent",
  );
  assert.equal(count(el, "<zeebe:ioMapping>"), 1);
  assert.match(el, /<zeebe:linkedResource resourceId="x.md"/);
  assert.match(el, /<zeebe:output source="=y" target="y" \/>/);
  assert.doesNotMatch(el, /appendPrompt/);
});

// --- run() service tasks --------------------------------------------------

test("run io: a locally-hosted service task also accepts an ioMapping", () => {
  const el = serviceTask(
    toBpmn(
      defineFlow("io-demo", (w) => {
        w.run("compute", async () => ({}), { io: { input: [{ source: "=n", target: "n" }] } });
      }),
    ),
    "compute",
  );
  assert.match(el, /<zeebe:taskDefinition type="io-demo:compute" \/>/);
  assert.match(el, /<zeebe:input source="=n" target="n" \/>/);
  assert.ok(el.indexOf("<zeebe:taskDefinition") < el.indexOf("<zeebe:ioMapping>"));
});

test("run io: absent io preserves the plain service task (no ioMapping)", () => {
  const el = serviceTask(
    toBpmn(defineFlow("io-demo", (w) => { w.run("compute", async () => ({})); })),
    "compute",
  );
  assert.doesNotMatch(el, /ioMapping/);
});

// --- io alongside data envelopes -----------------------------------------

test("task io: coexists with lifted data-envelope properties (properties then ioMapping)", () => {
  const In = envelope("In", { planKey: "string" });
  const el = serviceTask(
    toBpmn(
      defineFlow("io-demo", { record: { in: In } }, (w) => {
        w.task("record", { jobType: "pr.record", io: { input: [{ source: "=planKey", target: "planKey" }] } });
      }),
    ),
    "record",
  );
  assert.match(el, /<zeebe:property name="io\.nanobpm\.dataEnvelope\.in" value="In" \/>/);
  assert.match(el, /<zeebe:ioMapping>/);
  assert.ok(
    el.indexOf("<zeebe:properties>") < el.indexOf("<zeebe:ioMapping>"),
    "envelope properties precede ioMapping",
  );
});

// --- Validation -----------------------------------------------------------

test("task io: rejects a non-object io", () => {
  const bad = JSON.parse('{"jobType":"svc:t","io":"oops"}');
  assert.throws(() => defineFlow("x", (w) => { w.task("t", bad); }), /task\("t"\) \{ io \} must be an object/);
  const arr = JSON.parse('{"jobType":"svc:t","io":[]}');
  assert.throws(() => defineFlow("x", (w) => { w.task("t", arr); }), /\{ io \} must be an object/);
});

test("task io: rejects a malformed / blank entry (would emit a meaningless attribute)", () => {
  const missingTarget = JSON.parse('{"jobType":"svc:t","io":{"input":[{"source":"=x"}]}}');
  assert.throws(() => defineFlow("x", (w) => { w.task("t", missingTarget); }), /io\.input entries must be/);
  const blankSource = JSON.parse('{"jobType":"svc:t","io":{"output":[{"source":"  ","target":"r"}]}}');
  assert.throws(() => defineFlow("x", (w) => { w.task("t", blankSource); }), /io\.output entries must be/);
  const notArray = JSON.parse('{"jobType":"svc:t","io":{"input":"nope"}}');
  assert.throws(() => defineFlow("x", (w) => { w.task("t", notArray); }), /io\.input must be an array/);
});

test("run io: rejects a malformed io entry too (shared validator)", () => {
  const badIo: HumanIoMapping = JSON.parse('{"input":[{"target":"n"}]}');
  assert.throws(
    () => defineFlow("x", (w) => { w.run("c", async () => ({}), { io: badIo }); }),
    /run\("c"\) io\.input entries must be/,
  );
});
