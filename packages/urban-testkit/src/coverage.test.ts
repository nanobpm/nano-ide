// Unit tests for the surface-coverage core (issue #157, S4; issue #189).
//
// The core is pure and surface-agnostic (no engine/runtime import), so these tests pin
// its contract directly: declared vs exercised bookkeeping, the report shape (missing /
// unexpected / complete), and the `assertFullCoverage` gate's throw-vs-pass behaviour.

import { test } from "node:test";
import assert from "node:assert/strict";
import { SurfaceCoverage } from "./coverage.ts";

test("SurfaceCoverage: a declared, un-exercised element is reported missing and incomplete", () => {
  const cov = new SurfaceCoverage({ operations: ["listTasks", "createTask"] });
  cov.record("operations", "listTasks");

  const report = cov.report();
  assert.equal(report.complete, false);
  const ops = report.surfaces.find((s) => s.surface === "operations");
  assert.ok(ops, "operations surface is reported");
  assert.deepEqual(ops.declared, ["createTask", "listTasks"], "declared is sorted");
  assert.deepEqual(ops.exercised, ["listTasks"]);
  assert.deepEqual(ops.missing, ["createTask"]);
  assert.deepEqual(ops.unexpected, []);
  assert.equal(ops.complete, false);
});

test("SurfaceCoverage: exercising every declared element makes the surface complete", () => {
  const cov = new SurfaceCoverage({ workers: ["order.pack", "order.ship"] });
  cov.record("workers", "order.pack");
  cov.record("workers", "order.ship");

  const report = cov.report();
  assert.equal(report.complete, true);
  const workers = report.surfaces.find((s) => s.surface === "workers");
  assert.ok(workers);
  assert.deepEqual(workers.missing, []);
  assert.equal(workers.complete, true);
});

test("SurfaceCoverage: a hit on an undeclared element is reported unexpected, not missing", () => {
  const cov = new SurfaceCoverage({ workers: ["order.pack"] });
  cov.record("workers", "order.pack");
  // A system/internal job type the manifest never declared.
  cov.record("workers", "internal.sweep");

  const workers = cov.report().surfaces.find((s) => s.surface === "workers");
  assert.ok(workers);
  assert.deepEqual(workers.missing, [], "declared set is fully exercised");
  assert.deepEqual(workers.unexpected, ["internal.sweep"]);
  assert.equal(workers.complete, true, "unexpected hits do NOT make a surface incomplete");
});

test("SurfaceCoverage.assertFullCoverage throws naming exactly the un-exercised elements", () => {
  const cov = new SurfaceCoverage({
    operations: ["listTasks", "createTask", "deleteTask"],
    workers: ["order.pack"],
  });
  cov.record("operations", "listTasks");
  cov.record("workers", "order.pack");

  assert.throws(
    () => cov.assertFullCoverage(),
    (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.match(err.message, /Coverage incomplete/);
      assert.match(err.message, /operations: 2 un-exercised → createTask, deleteTask/);
      // The fully-covered workers surface must NOT appear in the failure.
      assert.doesNotMatch(err.message, /workers:/);
      return true;
    },
  );
});

test("SurfaceCoverage.assertFullCoverage passes silently when every surface is complete", () => {
  const cov = new SurfaceCoverage({ operations: ["listTasks"] });
  cov.record("operations", "listTasks");
  assert.doesNotThrow(() => cov.assertFullCoverage());
});

test("SurfaceCoverage.assertFullCoverage can gate a subset of surfaces", () => {
  const cov = new SurfaceCoverage({
    operations: ["listTasks"], // exercised
    workers: ["order.pack"], // NOT exercised
  });
  cov.record("operations", "listTasks");

  // Gating only the covered surface passes despite the workers gap.
  assert.doesNotThrow(() => cov.assertFullCoverage({ surfaces: ["operations"] }));
  // Gating the uncovered surface fails.
  assert.throws(() => cov.assertFullCoverage({ surfaces: ["workers"] }), /workers: 1 un-exercised/);
});

test("SurfaceCoverage.assertFullCoverage rejects an unknown surface name (test bug)", () => {
  const cov = new SurfaceCoverage({ operations: ["listTasks"] });
  assert.throws(
    () => cov.assertFullCoverage({ surfaces: ["nope"] }),
    /unknown surface\(s\) nope/,
  );
});

test("SurfaceCoverage.declareSurface is additive and preserves prior exercises", () => {
  const cov = new SurfaceCoverage();
  cov.declareSurface("operations", ["a", "b"]);
  cov.record("operations", "a");
  // Re-declare with an overlapping + new id; must not drop the recorded "a".
  cov.declareSurface("operations", ["b", "c"]);

  const ops = cov.report().surfaces.find((s) => s.surface === "operations");
  assert.ok(ops);
  assert.deepEqual(ops.declared, ["a", "b", "c"]);
  assert.deepEqual(ops.exercised, ["a"]);
  assert.deepEqual(ops.missing, ["b", "c"]);
});

test("SurfaceCoverage lists a declared-but-never-hit surface as an empty, incomplete surface", () => {
  const cov = new SurfaceCoverage({ operations: ["only"] });
  const report = cov.report();
  assert.deepEqual(cov.surfaces(), ["operations"]);
  const ops = report.surfaces[0];
  assert.equal(ops.surface, "operations");
  assert.deepEqual(ops.exercised, []);
  assert.deepEqual(ops.missing, ["only"]);
  assert.equal(report.complete, false);
});
