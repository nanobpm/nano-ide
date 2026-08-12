import assert from "node:assert/strict";
import { test } from "node:test";

import type { DemandSupplyReport } from "@nanobpm/agentic-demand";
import type { DiversityReport } from "@nanobpm/agentic-vocab";

import { cockpitView } from "./view.ts";

const greenDiversity: DiversityReport = { status: "green", roles: [] };

const amberDiversity: DiversityReport = {
  status: "amber",
  roles: [
    {
      token: "planning.plan",
      seatsDistinctFamily: false,
      assignments: [
        { seat: "red", family: "acme", instance: "a" },
        { seat: "blue", family: "acme", instance: "b" },
      ],
      collidingFamilies: ["acme"],
      status: "amber",
    },
  ],
};

function report(overrides: Partial<DemandSupplyReport> = {}): DemandSupplyReport {
  return {
    networks: [],
    missing: [],
    diversity: greenDiversity,
    status: "green",
    nonAgentic: [],
    ...overrides,
  };
}

test("a fully-served, green report yields a green view with no missing lights", () => {
  const view = cockpitView(
    report({
      networks: [
        {
          network: "ci",
          tokens: [{ token: "ci.build", supply: 2, instances: ["a", "b"], satisfied: true }],
          missing: [],
        },
      ],
    }),
  );

  assert.equal(view.status, "green");
  assert.equal(view.missing.length, 0);
  assert.equal(view.missingLights.length, 0);
  assert.equal(view.networks[0]?.status, "green");
  assert.equal(view.networks[0]?.tokens[0]?.status, "green");
  assert.equal(view.diversityLight.status, "green");
});

test("a missing agent type lights the token, the row and the report RED", () => {
  const view = cockpitView(
    report({
      status: "red",
      missing: ["planning.plan#blue"],
      networks: [
        {
          network: "planning",
          tokens: [
            { token: "planning.plan#blue", supply: 0, instances: [], satisfied: false },
            { token: "planning.plan#red", supply: 1, instances: ["a"], satisfied: true },
          ],
          missing: ["planning.plan#blue"],
        },
      ],
    }),
  );

  assert.equal(view.status, "red");
  assert.equal(view.networks[0]?.status, "red");
  const [missingTok, servedTok] = view.networks[0]?.tokens ?? [];
  assert.equal(missingTok?.status, "red");
  assert.equal(servedTok?.status, "green");

  assert.equal(view.missingLights.length, 1);
  assert.equal(view.missingLights[0]?.id, "missing:planning.plan#blue");
  assert.equal(view.missingLights[0]?.label, "planning.plan#blue");
  assert.equal(view.missingLights[0]?.status, "red");
});

test("the diversity SLO is surfaced as a light with the colliding family in the detail", () => {
  const view = cockpitView(report({ status: "amber", diversity: amberDiversity }));

  assert.equal(view.status, "amber");
  assert.equal(view.diversity, amberDiversity);
  assert.equal(view.diversityLight.status, "amber");
  assert.match(view.diversityLight.detail ?? "", /planning\.plan/);
  assert.match(view.diversityLight.detail ?? "", /acme/);
});

test("non-agentic task types pass through unchanged for operator visibility", () => {
  const view = cockpitView(report({ nonAgentic: ["send-email", "resize-image"] }));
  assert.deepEqual(view.nonAgentic, ["send-email", "resize-image"]);
});

test("the derivation is pure — the same report yields a deep-equal view", () => {
  const input = report({
    status: "red",
    missing: ["qa.review#blue"],
    networks: [
      {
        network: "qa",
        tokens: [{ token: "qa.review#blue", supply: 0, instances: [], satisfied: false }],
        missing: ["qa.review#blue"],
      },
    ],
  });
  assert.deepEqual(cockpitView(input), cockpitView(input));
});
