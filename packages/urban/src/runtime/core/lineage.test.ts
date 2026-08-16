import { test } from "node:test";
import assert from "node:assert/strict";
import {
  applyAmbientLineage,
  buildLineageTree,
  deriveLineage,
  type LineageEdge,
  LINEAGE_KEY,
  LINEAGE_NAMESPACE,
  mintRootRequestKey,
  readLineage,
  writeLineage,
} from "./lineage.ts";
import { __resetExecStoreForTests, installExecStore, runInJobContext } from "./execContext.ts";
import { createNodeHost } from "../adapters/node.ts";
import { isRecord } from "./guards.ts";

function lineageOf(variables: Record<string, unknown>): unknown {
  const ns = variables[LINEAGE_NAMESPACE];
  return isRecord(ns) ? ns[LINEAGE_KEY] : undefined;
}

test("readLineage extracts a well-formed envelope and rejects malformed ones", () => {
  assert.deepEqual(
    readLineage({ _urban: { lineage: { rootRequestKey: "r1", causedByInstanceKey: "c1" } } }),
    { rootRequestKey: "r1", causedByInstanceKey: "c1" },
  );
  // A bare root (no cause) is a valid fresh root.
  assert.deepEqual(readLineage({ _urban: { lineage: { rootRequestKey: "r1" } } }), {
    rootRequestKey: "r1",
    causedByInstanceKey: undefined,
  });
  // Blank/absent rootRequestKey → not a valid envelope.
  assert.equal(readLineage({ _urban: { lineage: { rootRequestKey: "" } } }), undefined);
  assert.equal(readLineage({ _urban: { lineage: {} } }), undefined);
  assert.equal(readLineage({ _urban: {} }), undefined);
  assert.equal(readLineage({}), undefined);
  assert.equal(readLineage(undefined), undefined);
});

test("writeLineage never mutates input and preserves other _urban.* keys", () => {
  const input = { keep: 1, _urban: { other: "x" } };
  const out = writeLineage(input, { rootRequestKey: "r1", causedByInstanceKey: "c1" });
  assert.deepEqual(input, { keep: 1, _urban: { other: "x" } }, "input is not mutated");
  assert.equal(out.keep, 1);
  assert.deepEqual(out._urban, { other: "x", lineage: { rootRequestKey: "r1", causedByInstanceKey: "c1" } });
});

test("writeLineage drops an absent causedByInstanceKey (a fresh root is { rootRequestKey })", () => {
  const out = writeLineage({}, { rootRequestKey: "r1" });
  assert.deepEqual(lineageOf(out), { rootRequestKey: "r1" });
});

test("deriveLineage propagates an ambient root and sets causedByInstanceKey", () => {
  assert.deepEqual(deriveLineage({ rootRequestKey: "root-1", instanceKey: "inst-5" }), {
    rootRequestKey: "root-1",
    causedByInstanceKey: "inst-5",
  });
});

test("deriveLineage treats an ambient instance with no envelope as its own root", () => {
  assert.deepEqual(deriveLineage({ instanceKey: "inst-9" }), {
    rootRequestKey: "inst-9",
    causedByInstanceKey: "inst-9",
  });
});

test("deriveLineage mints a fresh root when there is no ambient job at all", () => {
  assert.deepEqual(deriveLineage(undefined, () => "minted-1"), { rootRequestKey: "minted-1" });
});

test("mintRootRequestKey returns a non-empty, unique-ish value", () => {
  const a = mintRootRequestKey();
  const b = mintRootRequestKey();
  assert.equal(typeof a, "string");
  assert.notEqual(a, "");
  assert.notEqual(a, b);
});

test("applyAmbientLineage: an explicit caller envelope always wins (untouched)", () => {
  const explicit = { _urban: { lineage: { rootRequestKey: "explicit", causedByInstanceKey: "x" } } };
  const out = applyAmbientLineage(explicit, {
    ambient: { rootRequestKey: "ambient-root", instanceKey: "ambient-inst" },
  });
  assert.deepEqual(lineageOf(out), { rootRequestKey: "explicit", causedByInstanceKey: "x" });
});

test("applyAmbientLineage: propagates the ambient root and stamps the cause", () => {
  const out = applyAmbientLineage(
    { payload: 1 },
    { ambient: { rootRequestKey: "root-A", instanceKey: "inst-B" } },
  );
  assert.equal(out.payload, 1);
  assert.deepEqual(lineageOf(out), { rootRequestKey: "root-A", causedByInstanceKey: "inst-B" });
});

test("applyAmbientLineage: mints a fresh root for a genuine top-level request", () => {
  const out = applyAmbientLineage({}, { ambient: undefined, mintRootRequestKey: () => "fresh-1" });
  assert.deepEqual(lineageOf(out), { rootRequestKey: "fresh-1" });
});

test("applyAmbientLineage reads the real ambient job context (runInJobContext)", () => {
  __resetExecStoreForTests();
  const host = createNodeHost({ cwd: process.cwd(), log: () => {} });
  installExecStore(() => host.createAsyncStore?.());
  try {
    const out = runInJobContext({ instanceKey: "pi-1", rootRequestKey: "root-1", jobType: "w" }, () =>
      applyAmbientLineage({ a: 1 }),
    );
    assert.deepEqual(lineageOf(out), { rootRequestKey: "root-1", causedByInstanceKey: "pi-1" });
  } finally {
    __resetExecStoreForTests();
  }
});

test("buildLineageTree stitches a fan-out tree from weak edges", () => {
  const edges: LineageEdge[] = [
    { rootRequestKey: "root", instanceKey: "root", edgeType: "weak" },
    { rootRequestKey: "root", instanceKey: "child-1", causedByInstanceKey: "root", edgeType: "weak" },
    { rootRequestKey: "root", instanceKey: "child-2", causedByInstanceKey: "root", edgeType: "weak" },
    { rootRequestKey: "root", instanceKey: "grand-1", causedByInstanceKey: "child-1", edgeType: "weak" },
  ];
  const tree = buildLineageTree("root", edges);
  assert.equal(tree.root.instanceKey, "root");
  assert.deepEqual(tree.root.children.map((c) => c.instanceKey).sort(), ["child-1", "child-2"]);
  const child1 = tree.root.children.find((c) => c.instanceKey === "child-1");
  assert.deepEqual(child1?.children.map((c) => c.instanceKey), ["grand-1"]);
  assert.equal(tree.nodes.length, 4);
});

test("buildLineageTree: a strong (engine) edge supersedes a weak edge on the same node", () => {
  const edges: LineageEdge[] = [
    { rootRequestKey: "root", instanceKey: "child", causedByInstanceKey: "root", edgeType: "weak" },
    { rootRequestKey: "root", instanceKey: "child", causedByInstanceKey: "root", edgeType: "strong" },
  ];
  const tree = buildLineageTree("root", edges);
  const child = tree.nodes.find((n) => n.instanceKey === "child");
  assert.equal(child?.edgeType, "strong");
});

test("buildLineageTree ignores edges from other roots and hangs attachments on their node", () => {
  const edges: LineageEdge[] = [
    { rootRequestKey: "root", instanceKey: "child", causedByInstanceKey: "root", edgeType: "weak" },
    { rootRequestKey: "other", instanceKey: "stranger", causedByInstanceKey: "other", edgeType: "weak" },
  ];
  const tree = buildLineageTree("root", edges, [
    { nodeKey: "child", kind: "pull_request", ref: "owner/repo#1", label: "PR 1" },
    { nodeKey: "missing", kind: "task", ref: "t-1" },
  ]);
  assert.equal(tree.nodes.some((n) => n.instanceKey === "stranger"), false);
  const child = tree.root.children[0];
  assert.equal(child.instanceKey, "child");
  assert.deepEqual(child.attachments, [{ nodeKey: "child", kind: "pull_request", ref: "owner/repo#1", label: "PR 1" }]);
});
