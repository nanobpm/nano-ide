import assert from "node:assert/strict";
import { test } from "node:test";
import { CORE_VOCAB } from "./core-vocab.ts";
import {
  computeDiversity,
  correlateRegistry,
  type RegisteredWorker,
  type SeatAssignment,
} from "./diversity.ts";
import { VocabResolver } from "./resolver.ts";

const resolver = new VocabResolver(CORE_VOCAB);

function assignments(entries: Array<[string, SeatAssignment[]]>): Map<string, SeatAssignment[]> {
  return new Map(entries);
}

test("green when distinct families fill a strict role's seats", () => {
  const report = computeDiversity(
    resolver,
    assignments([
      [
        "planning.reviewer",
        [
          { seat: "red", family: "acme" },
          { seat: "blue", family: "globex" },
        ],
      ],
    ]),
  );
  assert.equal(report.status, "green");
  assert.equal(report.roles[0]?.status, "green");
  assert.deepEqual(report.roles[0]?.collidingFamilies, []);
});

test("red when a strict role's seats share a family", () => {
  const report = computeDiversity(
    resolver,
    assignments([
      [
        "planning.reviewer",
        [
          { seat: "red", family: "acme" },
          { seat: "blue", family: "acme" },
        ],
      ],
    ]),
  );
  assert.equal(report.status, "red");
  assert.equal(report.roles[0]?.status, "red");
  assert.deepEqual(report.roles[0]?.collidingFamilies, ["acme"]);
});

test("amber when a warn-default role's seats share a family (no opt-in)", () => {
  // qa.tester has 2 counted seats and does NOT opt into distinct families.
  const report = computeDiversity(
    resolver,
    assignments([
      [
        "qa.tester",
        [
          { seat: "0", family: "acme" },
          { seat: "1", family: "acme" },
        ],
      ],
    ]),
  );
  assert.equal(report.status, "amber");
  assert.equal(report.roles[0]?.status, "amber");
});

test("overall status is the worst across roles (red dominates amber)", () => {
  const report = computeDiversity(
    resolver,
    assignments([
      [
        "qa.tester",
        [
          { seat: "0", family: "acme" },
          { seat: "1", family: "acme" },
        ],
      ],
      [
        "planning.reviewer",
        [
          { seat: "red", family: "globex" },
          { seat: "blue", family: "globex" },
        ],
      ],
    ]),
  );
  assert.equal(report.status, "red");
  assert.equal(report.roles.length, 2);
  // roles are sorted by token
  assert.equal(report.roles[0]?.token, "planning.reviewer");
  assert.equal(report.roles[1]?.token, "qa.tester");
});

test("unknown tokens are ignored", () => {
  const report = computeDiversity(
    resolver,
    assignments([["mystery.role", [{ seat: "red", family: "acme" }]]]),
  );
  assert.equal(report.status, "green");
  assert.equal(report.roles.length, 0);
});

test("correlateRegistry seats registered workers and grades the live family mix", () => {
  const workers: RegisteredWorker[] = [
    { instance: "w-a", capability: { cognition: "planning", family: "acme" } },
    { instance: "w-b", capability: { cognition: "planning", family: "acme" } },
  ];
  // Both planning workers share family "acme"; planning.reviewer is strict → red.
  const report = correlateRegistry(resolver, workers);
  const reviewer = report.roles.find((r) => r.token === "planning.reviewer");
  assert.ok(reviewer !== undefined);
  assert.equal(reviewer?.status, "red");
  assert.equal(report.status, "red");
});

test("correlateRegistry is green when distinct families cover the review seats", () => {
  const workers: RegisteredWorker[] = [
    { instance: "w-a", capability: { cognition: "planning", family: "acme" } },
    { instance: "w-b", capability: { cognition: "planning", family: "globex" } },
  ];
  const report = correlateRegistry(resolver, workers);
  const reviewer = report.roles.find((r) => r.token === "planning.reviewer");
  assert.equal(reviewer?.status, "green");
});

test("correlateRegistry skips workers with no declared family", () => {
  const workers: RegisteredWorker[] = [
    { instance: "w-a", capability: { cognition: "planning" } },
    { instance: "w-b", capability: { cognition: "planning" } },
  ];
  const report = correlateRegistry(resolver, workers);
  assert.equal(report.status, "green");
  assert.equal(report.roles.length, 0);
});

test("correlateRegistry seats deterministically by instance id", () => {
  const workers: RegisteredWorker[] = [
    { instance: "w-b", capability: { cognition: "planning", family: "globex" } },
    { instance: "w-a", capability: { cognition: "planning", family: "acme" } },
  ];
  const report = correlateRegistry(resolver, workers);
  const reviewer = report.roles.find((r) => r.token === "planning.reviewer");
  // Sorted by instance: w-a(acme)->red, w-b(globex)->blue.
  assert.deepEqual(reviewer?.assignments, [
    { seat: "red", family: "acme", instance: "w-a" },
    { seat: "blue", family: "globex", instance: "w-b" },
  ]);
});
