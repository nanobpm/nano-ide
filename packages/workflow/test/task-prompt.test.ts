// Unit + derivation-parity tests for the agent PROMPT BINDING on `w.task`
// (epic #314, S4/#319): an optional `{ prompt }` option binds an LLM prompt
// resource to the external worker via a `zeebe:linkedResource`
// (`resourceType="GenericScript" linkName="prompt"`), alongside the existing
// `zeebe:taskDefinition` capability token. The no-prompt path must be unchanged
// (no `linkedResources`). Run against the built `dist` artifacts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { defineFlow, envelope, toBpmn } from "../dist/index.js";
import { assertDerivationParity, deploySmoke } from "../dist/test-support/index.js";
import { Gateway, resolveServerBin } from "./server.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const NWF = join(HERE, "fixtures", "nwf");

// Slice out a single serviceTask element by id, so an assertion about one task's
// extension elements is not confused by another task's.
function serviceTask(xml: string, id: string): string {
  const start = xml.indexOf(`<bpmn:serviceTask id="${id}"`);
  assert.notEqual(start, -1, `serviceTask id="${id}" not found`);
  const end = xml.indexOf("</bpmn:serviceTask>", start);
  assert.notEqual(end, -1, `serviceTask id="${id}" has no closing tag`);
  return xml.slice(start, end + "</bpmn:serviceTask>".length);
}

test("task without a prompt: taskDefinition preserved, NO linkedResources emitted", () => {
  const flow = defineFlow("agent-demo", (w) => {
    w.task("plain", { jobType: "senior:plain" });
  });
  const el = serviceTask(toBpmn(flow), "plain");
  assert.match(el, /<zeebe:taskDefinition type="senior:plain" \/>/);
  assert.doesNotMatch(el, /linkedResource/);
  assert.doesNotMatch(el, /ioMapping/);
});

test("task with a prompt: emits BOTH taskDefinition AND the linkedResource prompt binding", () => {
  const flow = defineFlow("agent-demo", (w) => {
    w.task("agent", { jobType: "senior:review", prompt: { resourceId: "review.md" } });
  });
  const el = serviceTask(toBpmn(flow), "agent");
  assert.match(el, /<zeebe:taskDefinition type="senior:review" \/>/);
  assert.match(el, /<zeebe:linkedResources>/);
  // bindingType defaults to "latest"; resourceType/linkName are fixed.
  assert.match(
    el,
    /<zeebe:linkedResource resourceId="review\.md" bindingType="latest" resourceType="GenericScript" linkName="prompt" \/>/,
  );
  // No `append` given → no ioMapping.
  assert.doesNotMatch(el, /ioMapping/);
});

test("task prompt: bindingType override + append emits a zeebe:ioMapping appendPrompt input", () => {
  const flow = defineFlow("agent-demo", (w) => {
    w.task("agent", {
      jobType: "senior:x",
      prompt: { resourceId: "x.md", bindingType: "deployment", append: "=extraContext" },
    });
  });
  const el = serviceTask(toBpmn(flow), "agent");
  assert.match(
    el,
    /<zeebe:linkedResource resourceId="x\.md" bindingType="deployment" resourceType="GenericScript" linkName="prompt" \/>/,
  );
  assert.match(el, /<zeebe:ioMapping>/);
  assert.match(el, /<zeebe:input source="=extraContext" target="appendPrompt" \/>/);
});

test("task prompt: works with the derived (default) job type — the capability token is not required", () => {
  const flow = defineFlow("agent-demo", (w) => {
    w.task("derive", { prompt: { resourceId: "p.md" } });
  });
  const el = serviceTask(toBpmn(flow), "derive");
  assert.match(el, /<zeebe:taskDefinition type="agent-demo:derive" \/>/);
  assert.match(el, /<zeebe:linkedResource resourceId="p\.md"/);
});

test("task prompt: a task's data envelopes still lift alongside the prompt binding", () => {
  const AgentIn = envelope("AgentIn", { planKey: "string" });
  const flow = defineFlow(
    "agent-demo",
    { agent: { in: AgentIn } },
    (w) => {
      w.task("agent", { jobType: "senior:review", prompt: { resourceId: "r.md" } });
    },
  );
  const el = serviceTask(toBpmn(flow), "agent");
  assert.match(el, /<zeebe:property name="io\.nanobpm\.dataEnvelope\.in" value="AgentIn" \/>/);
  assert.match(el, /<zeebe:linkedResource resourceId="r\.md"/);
});

test("task prompt: rejects an empty/missing resourceId with a helpful message", () => {
  assert.throws(
    () => defineFlow("x", (w) => w.task("a", { prompt: { resourceId: "" } })),
    /prompt\.resourceId must be a non-empty string/,
  );
  assert.throws(
    () => defineFlow("x", (w) => w.task("a", { prompt: JSON.parse("{}") })),
    /prompt\.resourceId must be a non-empty string/,
  );
});

test("task prompt: a null / non-object prompt fails with a helpful Error, not a TypeError", () => {
  // A caller bypassing the types (e.g. `JSON.parse("null")`) must not blow up
  // dereferencing `prompt.resourceId`; it gets the authoring error instead.
  assert.throws(
    () => defineFlow("x", (w) => w.task("a", { prompt: JSON.parse("null") })),
    /prompt must be an object with a resourceId/,
  );
  assert.throws(
    () => defineFlow("x", (w) => w.task("a", { prompt: JSON.parse("42") })),
    /prompt must be an object with a resourceId/,
  );
});

test("task prompt: rejects an empty bindingType / append override", () => {
  assert.throws(
    () => defineFlow("x", (w) => w.task("a", { prompt: { resourceId: "r.md", bindingType: "" } })),
    /prompt\.bindingType must be a non-empty string/,
  );
  assert.throws(
    () => defineFlow("x", (w) => w.task("a", { prompt: { resourceId: "r.md", append: "" } })),
    /prompt\.append must be a non-empty string/,
  );
  // Whitespace-only values validate against the trimmed form, so they're rejected too.
  assert.throws(
    () => defineFlow("x", (w) => w.task("a", { prompt: { resourceId: "  " } })),
    /prompt\.resourceId must be a non-empty string/,
  );
  assert.throws(
    () => defineFlow("x", (w) => w.task("a", { prompt: { resourceId: "r.md", bindingType: "  " } })),
    /prompt\.bindingType must be a non-empty string/,
  );
  assert.throws(
    () => defineFlow("x", (w) => w.task("a", { prompt: { resourceId: "r.md", append: "  " } })),
    /prompt\.append must be a non-empty string/,
  );
});

test("task prompt: trims surrounding whitespace before emitting resource attributes", () => {
  const flow = defineFlow("agent-demo", (w) => {
    w.task("agent", {
      jobType: "senior:x",
      prompt: { resourceId: "retro.md ", bindingType: " latest ", append: " =ctx " },
    });
  });
  const el = serviceTask(toBpmn(flow), "agent");
  assert.match(
    el,
    /<zeebe:linkedResource resourceId="retro\.md" bindingType="latest" resourceType="GenericScript" linkName="prompt" \/>/,
  );
  assert.match(el, /<zeebe:input source="=ctx" target="appendPrompt" \/>/);
});

test("task prompt: survives as the single MI body of forEach (linkedResources + MI on one serviceTask)", () => {
  // forEach's single-service-task fast-path must lift the MI characteristics
  // THROUGH the task's own emit handler, so a prompt-bound agent task fanned out
  // over a collection keeps its `zeebe:linkedResources` instead of silently
  // dropping it (the shape nano-workforce uses for a per-item agent task).
  const flow = defineFlow("agent-demo", (w) => {
    w.forEach("plan.items", "item", (b) =>
      b.task("agent", { jobType: "senior:review", prompt: { resourceId: "review.md", append: "=item" } }),
    );
  });
  const el = serviceTask(toBpmn(flow), "agent");
  assert.match(
    el,
    /<zeebe:linkedResource resourceId="review\.md" bindingType="latest" resourceType="GenericScript" linkName="prompt" \/>/,
  );
  assert.match(el, /<zeebe:input source="=item" target="appendPrompt" \/>/);
  // MI is lifted directly onto the same serviceTask (the flat fast-path shape,
  // not an embedded sub-process).
  assert.match(el, /<bpmn:multiInstanceLoopCharacteristics isSequential="false">/);
  assert.match(el, /inputCollection="=plan\.items" inputElement="item"/);
});

// ── Derivation parity against the hand-authored golden ───────────────────────
// The `retro` model's `synthesize` step is an agent service task carrying the
// linkedResource prompt binding (plus an `appendPrompt` ioMapping input); the
// whole model derives structurally identical to the vendored golden.
const RetroGatherIn = envelope("RetroGatherIn", { planKey: "string" });
const RetroRecordIn = envelope("RetroRecordIn", {
  planKey: "string",
  retroLearnings: { type: "integer", optional: true },
  status: { type: "string", optional: true },
  pr: { type: "string", optional: true },
  summary: { type: "string", optional: true },
});

const retro = defineFlow(
  "retro",
  { gather: { in: RetroGatherIn }, record: { in: RetroRecordIn } },
  (w) => {
    w.task("gather", { jobType: "pr.retro-gather" });
    w.task("synthesize", {
      jobType: "senior:retro",
      prompt: { resourceId: "retro.md", bindingType: "latest", append: "=retroDigest" },
    });
    w.task("record", { jobType: "pr.retro-record" });
  },
);

test("assertDerivationParity: the retro agent flow derives identically to its golden", () => {
  assertDerivationParity(retro, join(NWF, "retro.bpmn"));
});

// Deploy-smoke: prove the derived agent model (with its linkedResource) is
// accepted by a real engine when one is available; skips cleanly otherwise.
const skip = resolveServerBin() ? false : "no gateway binary built (set SERVER_BIN or `make debug`)";

test("deploySmoke: the derived retro agent model deploys to a live engine", { skip }, async () => {
  const scratch = join(HERE, `.smoke-prompt-${process.pid}`);
  const gw = await Gateway.create(scratch);
  try {
    const res = await deploySmoke(retro, { baseUrl: gw.baseUrl, transport: "rest" });
    assert.equal(res.skipped, false);
    assert.equal(res.deployed, true);
    assert.ok(res.result && typeof res.result === "object");
  } finally {
    await gw.stop();
  }
});
