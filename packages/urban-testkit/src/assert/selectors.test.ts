import assert from "node:assert";
import { AssertionError } from "node:assert";
import { test } from "node:test";

import {
  byKey,
  byProcessId,
  type InstanceRow,
  type InstanceSelector,
  readInstances,
  resolveFromInstances,
} from "./selectors.ts";

const rows: InstanceRow[] = [
  { key: "pi-1", state: "ACTIVE", processId: "order" },
  { key: "pi-2", state: "COMPLETED", processId: "order" },
  { key: "pi-3", state: "ACTIVE", processId: "ship" },
];

test("readInstances projects the snapshot instances array, dropping keyless rows", () => {
  const snapshot = {
    instances: [
      { key: "pi-1", state: "ACTIVE", processId: "order" },
      { key: "pi-2", state: "COMPLETED", bpmnProcessId: "order" },
      { state: "ACTIVE" }, // keyless — dropped
      "not-an-object", // non-object — dropped
    ],
  };
  const out = readInstances(snapshot);
  assert.deepEqual(out, [
    { key: "pi-1", state: "ACTIVE", processId: "order" },
    { key: "pi-2", state: "COMPLETED", processId: "order" },
  ]);
});

test("readInstances tolerates a missing instances array", () => {
  assert.deepEqual(readInstances({}), []);
});

test("resolveFromInstances resolves a bare key", () => {
  assert.equal(resolveFromInstances(rows, "pi-2"), "pi-2");
});

test("resolveFromInstances resolves byKey and byProcessId", () => {
  assert.equal(resolveFromInstances(rows, byKey("pi-3")), "pi-3");
  assert.equal(resolveFromInstances(rows, byProcessId("ship")), "pi-3");
});

test("resolveFromInstances defaults to the single ACTIVE instance", () => {
  const single: InstanceRow[] = [
    { key: "pi-1", state: "ACTIVE", processId: "order" },
    { key: "pi-2", state: "COMPLETED", processId: "order" },
  ];
  assert.equal(resolveFromInstances(single), "pi-1");
});

test("resolveFromInstances defaults over the mixed-case wasm snapshot state", () => {
  // The real wasm snapshot spells the lifecycle state mixed-case ("Active" /
  // "Completed"), so the default-ACTIVE path must normalise casing rather than
  // compare against the literal "ACTIVE" — otherwise it finds nothing even when
  // exactly one instance is active.
  const single: InstanceRow[] = [
    { key: "pi-1", state: "Active", processId: "order" },
    { key: "pi-2", state: "Completed", processId: "order" },
  ];
  assert.equal(resolveFromInstances(single), "pi-1");
});

test("resolveFromInstances throws naming the actual instances on ambiguity", () => {
  assert.throws(
    () => resolveFromInstances(rows),
    (err: unknown) => {
      assert.ok(err instanceof AssertionError);
      assert.match(err.message, /2 ACTIVE instances/);
      assert.match(err.message, /pi-1/);
      assert.match(err.message, /pi-3/);
      return true;
    },
  );
});

test("resolveFromInstances throws on an unknown key / processId", () => {
  assert.throws(() => resolveFromInstances(rows, "nope"), AssertionError);
  assert.throws(() => resolveFromInstances(rows, byProcessId("nope")), AssertionError);
});

test("resolveFromInstances throws on ambiguous processId", () => {
  assert.throws(
    () => resolveFromInstances(rows, byProcessId("order")),
    (err: unknown) => {
      assert.ok(err instanceof AssertionError);
      assert.match(err.message, /2 instances with processId "order"/);
      return true;
    },
  );
});

test("resolveFromInstances throws a clear error on an unknown selector kind", () => {
  // A caller crossing a JS / `unknown` boundary can hand us a malformed selector.
  // JSON.parse yields `any`, so this models that runtime shape without an `as` cast.
  const bogus: InstanceSelector = JSON.parse('{"kind":"bogus","processId":"order"}');
  assert.throws(
    () => resolveFromInstances(rows, bogus),
    (err: unknown) => {
      assert.ok(err instanceof AssertionError);
      assert.match(err.message, /unknown selector kind "bogus"/);
      return true;
    },
  );
});

test("resolveFromInstances rejects a byProcessId selector with a non-string processId", () => {
  // A malformed `{ kind: "processId", processId: undefined }` must fail loudly
  // rather than match an instance whose own processId is undefined. JSON has no
  // `undefined`, so drop the key entirely to model the runtime `undefined` shape.
  const undefinedProcessId: InstanceSelector = JSON.parse('{"kind":"processId"}');
  const withUndefinedRow: InstanceRow[] = [{ key: "pi-x", state: "ACTIVE", processId: undefined }];
  assert.throws(
    () => resolveFromInstances(withUndefinedRow, undefinedProcessId),
    (err: unknown) => {
      assert.ok(err instanceof AssertionError);
      assert.match(err.message, /byProcessId requires a string processId/);
      return true;
    },
  );
});
