import assert from "node:assert/strict";
import { test } from "node:test";

import { FakeDocument, FakeElement } from "./fake-dom.ts";
import { renderCockpit } from "./render.ts";
import { type CockpitView, cockpitView } from "./view.ts";

function view(): CockpitView {
  return cockpitView({
    status: "red",
    missing: ["planning.plan#blue"],
    networks: [
      {
        network: "ci",
        tokens: [{ token: "ci.build", supply: 2, instances: ["ci-a", "ci-b"], satisfied: true }],
        missing: [],
      },
      {
        network: "planning",
        tokens: [
          { token: "planning.plan#blue", supply: 0, instances: [], satisfied: false },
          { token: "planning.plan#red", supply: 1, instances: ["plan-a"], satisfied: true },
        ],
        missing: ["planning.plan#blue"],
      },
    ],
    diversity: { status: "green", roles: [] },
    nonAgentic: ["send-email"],
  });
}

test("renders one section per network with a demand×supply row per token", () => {
  const doc = new FakeDocument();
  const host = new FakeElement("body");
  renderCockpit(host, doc, view());

  const networks = host.byClass("cockpit-network");
  assert.deepEqual(
    networks.map((n) => n.getAttribute("data-network")),
    ["ci", "planning"],
  );
  const tokens = host.byClass("cockpit-token");
  assert.deepEqual(
    tokens.map((t) => t.getAttribute("data-token")),
    ["ci.build", "planning.plan#blue", "planning.plan#red"],
  );
});

test("token tables use valid <thead>/<tbody> structure (rows are never direct <table> children)", () => {
  const doc = new FakeDocument();
  const host = new FakeElement("body");
  renderCockpit(host, doc, view());

  const tables = host.byClass("cockpit-tokens");
  assert.ok(tables.length >= 1, "at least one token table is rendered");
  for (const table of tables) {
    // A <table> must only contain section elements (<thead>/<tbody>), never a bare <tr>.
    assert.deepEqual(
      table.children.map((c) => c.tagName),
      ["thead", "tbody"],
      "table children are the section wrappers, not rows",
    );
    const [thead, tbody] = table.children;
    assert.deepEqual(
      thead?.children.map((c) => c.tagName),
      ["tr"],
      "the header row lives inside <thead>",
    );
    for (const row of tbody?.children ?? []) {
      assert.equal(row.tagName, "tr", "every data row lives inside <tbody>");
    }
  }
});

test("a missing agent type renders a RED token, a RED network and a red missing light", () => {
  const doc = new FakeDocument();
  const host = new FakeElement("body");
  renderCockpit(host, doc, view());

  const missingTok = host.byData("token", "planning.plan#blue")[0];
  assert.equal(missingTok?.getAttribute("data-status"), "red");
  const planning = host.byData("network", "planning")[0];
  assert.equal(planning?.getAttribute("data-status"), "red");

  const lights = host.byClass("cockpit-light").filter((l) => l.getAttribute("data-light-id")?.startsWith("missing:"));
  assert.equal(lights.length, 1);
  assert.equal(lights[0]?.getAttribute("data-status"), "red");
  assert.match(lights[0]?.text() ?? "", /planning\.plan#blue/);
});

test("the overall status and diversity light render in the header", () => {
  const doc = new FakeDocument();
  const host = new FakeElement("body");
  renderCockpit(host, doc, view());
  assert.equal(host.byClass("cockpit")[0]?.getAttribute("data-status"), "red");
  const badge = host.byData("badge-id", "overall")[0];
  assert.equal(badge?.getAttribute("data-status"), "red");
  const diversity = host.byData("light-id", "diversity")[0];
  assert.equal(diversity?.getAttribute("data-status"), "green");
});

test("clicking a worker chip drills into that instance's relay stream", () => {
  const doc = new FakeDocument();
  const host = new FakeElement("body");
  const drilled: string[] = [];
  renderCockpit(host, doc, view(), { onDrill: (stream) => drilled.push(stream) });

  const chip = host.byData("stream", "ci-a")[0];
  assert.ok(chip instanceof FakeElement);
  chip.dispatch("click");
  assert.deepEqual(drilled, ["ci-a"]);
});

test("re-rendering replaces prior content (idempotent refresh)", () => {
  const doc = new FakeDocument();
  const host = new FakeElement("body");
  renderCockpit(host, doc, view());
  renderCockpit(host, doc, view());
  assert.equal(host.children.length, 1, "host holds exactly one cockpit root after re-render");
  assert.equal(host.byClass("cockpit-network").length, 2);
});

test("embedded and standalone render identically — same view, same host subset ⇒ same DOM", () => {
  const doc = new FakeDocument();
  const standaloneHost = new FakeElement("body");
  const embeddedHost = new FakeElement("div");
  const v = view();
  renderCockpit(standaloneHost, doc, v);
  renderCockpit(embeddedHost, doc, v);

  const shape = (root: FakeElement): unknown => ({
    tag: root.tagName,
    cls: root.className,
    attrs: [...root.attributes.entries()].sort(),
    text: root.textContent,
    children: root.children.map(shape),
  });
  const standaloneRoot = standaloneHost.children[0];
  const embeddedRoot = embeddedHost.children[0];
  assert.ok(standaloneRoot !== undefined && embeddedRoot !== undefined);
  assert.deepEqual(shape(standaloneRoot), shape(embeddedRoot));
});

test("non-agentic task types render in a footer", () => {
  const doc = new FakeDocument();
  const host = new FakeElement("body");
  renderCockpit(host, doc, view());
  assert.match(host.byClass("cockpit-nonagentic")[0]?.text() ?? "", /send-email/);
});
