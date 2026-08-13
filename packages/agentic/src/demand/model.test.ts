import assert from "node:assert/strict";
import { test } from "node:test";

import { CORE_VOCAB, VocabResolver, type RegisteredWorker } from "../vocab/index.ts";
import type { VocabDocument } from "../protocol/index.ts";

import { computeDemandSupply, toDemandPayloads } from "./model.ts";
import type { TaskDefinitionLeaf } from "./taskdef.ts";

const resolver = new VocabResolver(CORE_VOCAB);

// A minimal vocab with a single warn-default, multi-seat role and NO strict
// (`seatsDistinctFamily`) role — so a same-family collision grades AMBER, not RED.
// The core vocab can't express this (every multi-seat cognition also carries a
// strict `reviewer` role), so the diversity-fold cases use this instead.
const AMBER_VOCAB: VocabDocument = {
  version: 1,
  networks: {
    build: {
      roles: {
        worker: { requires: ["cognition=build"], seats: 2 },
      },
    },
  },
};
const amberResolver = new VocabResolver(AMBER_VOCAB);

function leaf(taskType: string, process = "p", elementId = "e"): TaskDefinitionLeaf {
  return { taskType, process, elementId };
}

function worker(instance: string, cognition: string, family: string, weight?: number): RegisteredWorker {
  return { instance, capability: { cognition, family, ...(weight === undefined ? {} : { weight }) } };
}

test("reports demand×supply per network and flags a missing agent type", () => {
  // Deployed model demands three tokens across two networks.
  const taskDefinitions = [leaf("planning.planner"), leaf("qa.tester"), leaf("ci.runner")];
  // Live registry supplies planning + qa, but nobody serves ci.
  const workers = [worker("w-plan", "planning", "gpt"), worker("w-qa", "qa", "claude")];

  const report = computeDemandSupply({ taskDefinitions, workers, resolver });

  assert.deepEqual(
    report.networks.map((n) => n.network),
    ["ci", "planning", "qa"],
  );

  const ci = report.networks.find((n) => n.network === "ci");
  assert.ok(ci);
  assert.deepEqual(ci.missing, ["ci.runner"]);
  assert.equal(ci.tokens[0].supply, 0);
  assert.equal(ci.tokens[0].satisfied, false);

  const planning = report.networks.find((n) => n.network === "planning");
  assert.ok(planning);
  assert.deepEqual(planning.missing, []);
  assert.equal(planning.tokens[0].token, "planning.planner");
  assert.equal(planning.tokens[0].satisfied, true);
  assert.deepEqual(planning.tokens[0].instances, ["w-plan"]);

  // The missing agent type is surfaced at the top level and drives the SLO red.
  assert.deepEqual(report.missing, ["ci.runner"]);
  assert.equal(report.status, "red");
});

test("all demand satisfied → SLO green when diversity is also green", () => {
  const taskDefinitions = [leaf("planning.planner"), leaf("ci.runner")];
  const workers = [worker("w-plan", "planning", "gpt"), worker("w-ci", "ci", "claude")];

  const report = computeDemandSupply({ taskDefinitions, workers, resolver });

  assert.deepEqual(report.missing, []);
  assert.equal(report.diversity.status, "green");
  assert.equal(report.status, "green");
});

test("supply counts every registered worker that serves a token", () => {
  const taskDefinitions = [leaf("implementation.junior")];
  const workers = [
    worker("w-a", "implementation", "gpt"),
    worker("w-b", "implementation", "claude"),
    worker("w-c", "qa", "gpt"),
  ];

  const report = computeDemandSupply({ taskDefinitions, workers, resolver });
  const token = report.networks[0].tokens[0];
  assert.equal(token.token, "implementation.junior");
  // Both implementation workers serve implementation.junior; the qa worker does not.
  assert.equal(token.supply, 2);
  assert.deepEqual(token.instances, ["w-a", "w-b"]);
});

test("a requires-gated token is missing when no worker clears the gate", () => {
  // implementation.senior requires weight>=4; the only implementation worker is weight 2.
  const taskDefinitions = [leaf("implementation.senior")];
  const workers = [worker("w-jr", "implementation", "gpt", 2)];

  const report = computeDemandSupply({ taskDefinitions, workers, resolver });
  assert.deepEqual(report.missing, ["implementation.senior"]);

  // Raise the worker's weight and the same token becomes supplied.
  const stronger = computeDemandSupply({
    taskDefinitions,
    workers: [worker("w-sr", "implementation", "gpt", 5)],
    resolver,
  });
  assert.deepEqual(stronger.missing, []);
});

test("the diversity SLO folds into the overall status (amber warn-default)", () => {
  // Two workers of the SAME family fill the two `build.worker` seats: a
  // warn-default collision → AMBER. Demand is fully supplied, so missing is green.
  const taskDefinitions = [leaf("build.worker")];
  const workers = [worker("w-a", "build", "gpt"), worker("w-b", "build", "gpt")];

  const report = computeDemandSupply({ taskDefinitions, workers, resolver: amberResolver });
  assert.deepEqual(report.missing, []);
  assert.equal(report.diversity.status, "amber");
  assert.equal(report.status, "amber");
});

test("a missing agent type is RED even if diversity is only amber", () => {
  const taskDefinitions = [leaf("build.worker"), leaf("ci.runner")];
  const workers = [worker("w-a", "build", "gpt"), worker("w-b", "build", "gpt")];

  const report = computeDemandSupply({ taskDefinitions, workers, resolver: amberResolver });
  assert.deepEqual(report.missing, ["ci.runner"]);
  assert.equal(report.diversity.status, "amber");
  assert.equal(report.status, "red");
});

test("buckets a bare (network-less) token under its own name", () => {
  const report = computeDemandSupply({
    taskDefinitions: [leaf("decide")],
    workers: [],
    resolver,
  });
  assert.deepEqual(
    report.networks.map((n) => n.network),
    ["decide"],
  );
  assert.deepEqual(report.networks[0].missing, ["decide"]);
});

test("distinct demand: a token demanded by many elements is one entry", () => {
  const report = computeDemandSupply({
    taskDefinitions: [leaf("qa.tester", "p1", "e1"), leaf("qa.tester", "p2", "e2")],
    workers: [worker("w", "qa", "gpt")],
    resolver,
  });
  const qa = report.networks.find((n) => n.network === "qa");
  assert.ok(qa);
  assert.equal(qa.tokens.length, 1);
  assert.equal(qa.tokens[0].supply, 1);
});

test("non-routing-token task types are surfaced but excluded from accounting", () => {
  const report = computeDemandSupply({
    taskDefinitions: [leaf("planning.planner"), leaf("legacy:job#bad#token")],
    workers: [worker("w", "planning", "gpt")],
    resolver,
  });
  assert.deepEqual(report.nonAgentic, ["legacy:job#bad#token"]);
  assert.deepEqual(
    report.networks.map((n) => n.network),
    ["planning"],
  );
  assert.deepEqual(report.missing, []);
});

test("the report is deterministic: lists sorted regardless of input order", () => {
  const a = computeDemandSupply({
    taskDefinitions: [leaf("qa.tester"), leaf("ci.runner"), leaf("planning.planner")],
    workers: [worker("z", "qa", "gpt"), worker("a", "qa", "claude")],
    resolver,
  });
  const b = computeDemandSupply({
    taskDefinitions: [leaf("planning.planner"), leaf("qa.tester"), leaf("ci.runner")],
    workers: [worker("a", "qa", "claude"), worker("z", "qa", "gpt")],
    resolver,
  });
  assert.deepEqual(a, b);
});

test("toDemandPayloads projects one demand payload per network", () => {
  const report = computeDemandSupply({
    taskDefinitions: [leaf("planning.planner"), leaf("ci.runner")],
    workers: [worker("w-plan", "planning", "gpt")],
    resolver,
  });
  const payloads = toDemandPayloads(report);
  assert.deepEqual(payloads, [
    { network: "ci", missing: ["ci.runner"] },
    { network: "planning", missing: [] },
  ]);
});
