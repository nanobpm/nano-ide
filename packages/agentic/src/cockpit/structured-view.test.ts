import assert from "node:assert/strict";
import { test } from "node:test";

import { type TranscriptEvent, deriveView } from "../transcript/index.ts";

import { FakeDocument, FakeElement } from "./fake-dom.ts";
import { createStructuredSink, renderStructured } from "./structured-view.ts";

function fixture(): { host: FakeElement; doc: FakeDocument } {
  return { host: new FakeElement("div"), doc: new FakeDocument() };
}

test("renderStructured renders derived turns, messages and tool cards (not raw JSON)", () => {
  const { host, doc } = fixture();
  const events: TranscriptEvent[] = [
    { kind: "turn", offset: 0, index: 0 },
    { kind: "message", offset: 1, role: "user", text: "run the build" },
    { kind: "message", offset: 2, role: "assistant", text: "on it" },
    { kind: "tool-call", offset: 3, name: "shell", callId: "c1", args: { cmd: "build" } },
    { kind: "tool-result", offset: 4, callId: "c1", ok: true, content: "done" },
    { kind: "lifecycle", offset: 5, phase: "completed" },
  ];
  renderStructured(host, doc, deriveView(events));

  const root = host.byClass("cockpit-structured")[0];
  assert.ok(root, "a structured root is rendered");
  assert.equal(root.getAttribute("data-lifecycle"), "completed");

  const messages = host.byClass("cockpit-structured-message");
  assert.equal(messages.length, 2);
  assert.equal(messages[0]?.getAttribute("data-role"), "user");
  assert.match(messages[0]?.text() ?? "", /run the build/);

  const tool = host.byClass("cockpit-structured-tool")[0];
  assert.ok(tool, "the tool card is rendered");
  assert.equal(tool.getAttribute("data-tool"), "shell");
  assert.equal(tool.getAttribute("data-state"), "ok");
  assert.match(tool.text(), /done/);
});

test("renderStructured replaces prior content (idempotent re-render)", () => {
  const { host, doc } = fixture();
  renderStructured(host, doc, deriveView([{ kind: "message", offset: 0, role: "assistant", text: "one" }]));
  renderStructured(host, doc, deriveView([{ kind: "message", offset: 0, role: "assistant", text: "two" }]));
  assert.equal(host.byClass("cockpit-structured").length, 1, "no duplicated roots after a re-render");
  assert.equal(host.byClass("cockpit-structured-message").length, 1);
  assert.match(host.byClass("cockpit-structured-message")[0]?.text() ?? "", /two/);
});

test("createStructuredSink accumulates events and re-derives the view on each one", () => {
  const { host, doc } = fixture();
  const sink = createStructuredSink(host, doc);
  // An empty view is present up-front, before any event.
  assert.equal(host.byClass("cockpit-structured").length, 1);
  assert.equal(host.byClass("cockpit-structured-message").length, 0);

  sink.event({ kind: "message", offset: 0, role: "assistant", text: "first" });
  sink.event({ kind: "message", offset: 1, role: "assistant", text: "second" });
  const messages = host.byClass("cockpit-structured-message");
  assert.equal(messages.length, 2, "both accumulated events are folded into the view");
  assert.match(messages[1]?.text() ?? "", /second/);
});

test("createStructuredSink.dispose clears the accumulated log and the DOM", () => {
  const { host, doc } = fixture();
  const sink = createStructuredSink(host, doc);
  sink.event({ kind: "message", offset: 0, role: "assistant", text: "hi" });
  sink.dispose();
  assert.equal(host.children.length, 0, "the structured host is emptied on dispose");
});
