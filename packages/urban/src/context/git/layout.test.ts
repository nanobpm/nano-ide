// Slice S3 (git/governance) — unit tests for the path/namespace layout helper.

import assert from "node:assert/strict";
import { test } from "node:test";
import type { MemoryRecord } from "../schema/index.ts";
import {
  LAYOUT_ROOT,
  UNSCOPED_BUCKET,
  isRecordPath,
  recordDir,
  recordRelativePath,
  sanitizeSegment,
  scopeDir,
} from "./layout.ts";

function record(overrides: Partial<MemoryRecord>): MemoryRecord {
  const base: MemoryRecord = {
    schemaVersion: 1,
    id: "rec-1",
    scope: "epic",
    mode: "empirical",
    provenance: "measured",
    authority: "authoritative",
    statement: "a measured fact",
    createdAt: "2026-01-01T00:00:00Z",
  };
  return { ...base, ...overrides };
}

test("scopeDir / recordDir partition by scope and scopeRef", () => {
  assert.equal(scopeDir("epic"), `${LAYOUT_ROOT}/epic`);
  assert.equal(recordDir("epic", "issue-303"), `${LAYOUT_ROOT}/epic/issue-303`);
  // No scopeRef → the shared bucket.
  assert.equal(recordDir("corpus"), `${LAYOUT_ROOT}/corpus/${UNSCOPED_BUCKET}`);
});

test("recordRelativePath is deterministic and scoped", () => {
  const r = record({ scope: "epic", scopeRef: "issue-303", id: "rec-42" });
  assert.equal(recordRelativePath(r), `${LAYOUT_ROOT}/epic/issue-303/rec-42.json`);
  // Same record → same path (idempotent write target).
  assert.equal(recordRelativePath(r), recordRelativePath({ ...r }));
});

test("records without scopeRef land in the shared bucket", () => {
  const r = record({ scope: "corpus", id: "global-1" });
  assert.equal(recordRelativePath(r), `${LAYOUT_ROOT}/corpus/${UNSCOPED_BUCKET}/global-1.json`);
});

test("sanitizeSegment neutralises path traversal and separators", () => {
  // A traversal attempt can never produce a `..` or a separator.
  const nasty = sanitizeSegment("../../etc/passwd");
  assert.ok(!nasty.includes("/"));
  assert.ok(!nasty.includes(".."));
  assert.notEqual(nasty, "");
  // A clean value is preserved verbatim.
  assert.equal(sanitizeSegment("rec-1"), "rec-1");
});

test("distinct lossy ids never collide onto one segment", () => {
  const a = sanitizeSegment("a/b");
  const b = sanitizeSegment("a\\b");
  assert.notEqual(a, b);
});

test("a traversal id cannot escape the layout root", () => {
  const r = record({ scope: "epic", scopeRef: "../../escape", id: "../../../root" });
  const path = recordRelativePath(r);
  assert.ok(path.startsWith(`${LAYOUT_ROOT}/epic/`));
  assert.ok(!path.includes(".."));
});

test("isRecordPath selects record files under the layout root", () => {
  assert.equal(isRecordPath("records/epic/issue-303/rec-42.json"), true);
  assert.equal(isRecordPath("./records/corpus/_/global-1.json"), true);
  assert.equal(isRecordPath("records\\epic\\x\\r.json"), true);
  assert.equal(isRecordPath("records/epic/x/notes.md"), false);
  assert.equal(isRecordPath("other/epic/x/r.json"), false);
  assert.equal(isRecordPath("records/../secrets/r.json"), false);
});

test("sanitizeSegment eliminates internal '..' sequences", () => {
  // An internal `..` (e.g. "a..b") must not survive: `isRecordPath` rejects any
  // path containing "..", so a record whose id/scopeRef carried one would be
  // invisible to retrieval/CI. It is disambiguated with a hash, never dropped.
  const seg = sanitizeSegment("a..b");
  assert.ok(!seg.includes(".."));
  assert.notEqual(seg, sanitizeSegment("a.b"));
});

test("a sanitised scopeRef can never collide with UNSCOPED_BUCKET", () => {
  // A raw scopeRef of exactly "_" must NOT map onto the shared unscoped bucket,
  // otherwise a scoped record and an unscoped record share a directory.
  const seg = sanitizeSegment(UNSCOPED_BUCKET);
  assert.notEqual(seg, UNSCOPED_BUCKET);
  assert.notEqual(
    recordDir("epic", UNSCOPED_BUCKET),
    recordDir("epic"),
  );
});

test("every recordRelativePath output is a valid isRecordPath (no writer/scan drift)", () => {
  // The writer's output and the retrieval/CI scanner must agree by construction:
  // any path recordRelativePath emits must be selected by isRecordPath, for even
  // adversarial ids/scopeRefs.
  const adversarial = ["a..b", "..", ".", "_", "../../escape", "", "  ", "a/b\\c"];
  for (const scopeRef of adversarial) {
    for (const id of adversarial) {
      const path = recordRelativePath(record({ scope: "epic", scopeRef, id }));
      assert.equal(isRecordPath(path), true, `not a record path: ${path}`);
    }
  }
});
