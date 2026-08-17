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
  // An attachment for an instance with no recorded edge yet is PRESERVED as an unattached node,
  // never silently dropped — attachments are an extension point and must survive the projection.
  const orphan = tree.nodes.find((n) => n.instanceKey === "missing");
  assert.ok(orphan, "attachment for an un-stitched instance must materialise its node");
  assert.deepEqual(orphan.attachments, [{ nodeKey: "missing", kind: "task", ref: "t-1" }]);
  assert.equal(orphan.edgeType, undefined);
  assert.equal(orphan.children.length, 0);
});

test("buildLineageTree: a stray orphan attachment does not shadow a MINTED root's real parentless instance", () => {
  // Defect-class guard: materialising attachment-only nodes must not reintroduce the phantom-root
  // bug. A minted (synthetic) rootRequestKey with an orphan attachment adds a second parentless
  // node; the tree must still root at the real recorded instance, not the empty synthetic phantom.
  const edges: LineageEdge[] = [
    { rootRequestKey: "req-UUID", instanceKey: "inst-root", edgeType: "weak" },
    { rootRequestKey: "req-UUID", instanceKey: "inst-child", causedByInstanceKey: "inst-root", edgeType: "strong" },
  ];
  const tree = buildLineageTree("req-UUID", edges, [{ nodeKey: "inst-orphan", kind: "note", ref: "n-1" }]);
  assert.equal(tree.root.instanceKey, "inst-root");
  assert.deepEqual(tree.root.children.map((c) => c.instanceKey), ["inst-child"]);
  assert.equal(tree.nodes.some((n) => n.instanceKey === "req-UUID"), false);
  // The orphan attachment is preserved (unattached), and the synthetic key never leaks as a node.
  const orphan = tree.nodes.find((n) => n.instanceKey === "inst-orphan");
  assert.ok(orphan, "orphan attachment node must be preserved");
  assert.deepEqual(orphan.attachments, [{ nodeKey: "inst-orphan", kind: "note", ref: "n-1" }]);
});

test("buildLineageTree roots a MINTED (synthetic) rootRequestKey at the parentless instance, not a phantom", () => {
  // A genuine top-level request MINTS a UUID `rootRequestKey` that is NOT any instance key
  // (`deriveLineage` with no ambient job). The real root instance carries that key with no
  // cause, and its descendants hang off the instance. The tree must be rooted at the real
  // parentless instance — never at an empty synthetic node while the real root floats detached.
  const edges: LineageEdge[] = [
    { rootRequestKey: "req-UUID", instanceKey: "inst-root", edgeType: "weak" },
    { rootRequestKey: "req-UUID", instanceKey: "inst-child", causedByInstanceKey: "inst-root", edgeType: "weak" },
    { rootRequestKey: "req-UUID", instanceKey: "inst-grand", causedByInstanceKey: "inst-child", edgeType: "strong" },
  ];
  const tree = buildLineageTree("req-UUID", edges);
  assert.equal(tree.root.instanceKey, "inst-root");
  assert.deepEqual(tree.root.children.map((c) => c.instanceKey), ["inst-child"]);
  assert.deepEqual(tree.root.children[0].children.map((c) => c.instanceKey), ["inst-grand"]);
  // The synthetic correlation key must not leak into the flat view as a phantom node.
  assert.equal(tree.nodes.some((n) => n.instanceKey === "req-UUID"), false);
  assert.equal(tree.nodes.length, 3);
});

test("buildLineageTree keeps a lone real root (parentless, no descendants) as the tree root", () => {
  // Guard the fallback boundary: a real root instance whose key IS the rootRequestKey and which
  // has no descendants must stay the root — it must not be mistaken for a replaceable phantom.
  const edges: LineageEdge[] = [{ rootRequestKey: "root", instanceKey: "root", edgeType: "weak" }];
  const tree = buildLineageTree("root", edges);
  assert.equal(tree.root.instanceKey, "root");
  assert.equal(tree.root.children.length, 0);
  assert.equal(tree.nodes.length, 1);
});

test("buildLineageTree keeps the synthetic root when no edges exist at all", () => {
  const tree = buildLineageTree("req-UUID", []);
  assert.equal(tree.root.instanceKey, "req-UUID");
  assert.equal(tree.root.children.length, 0);
  assert.deepEqual(tree.nodes.map((n) => n.instanceKey), ["req-UUID"]);
});
