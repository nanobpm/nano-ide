// Slice S4 (retrieval) — tests for the git read source. These write record
// files straight onto disk under the S3 layout (no git needed) to prove the
// source selects/parses/skips correctly and reads namespaces cheaply.

import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { recordRelativePath } from "../git/index.ts";
import type { MemoryRecord } from "../schema/index.ts";
import { GitRecordSource, RecordSourceError } from "./source.ts";

const TEMP_ROOTS: string[] = [];

after(async () => {
  await Promise.all(TEMP_ROOTS.map((dir) => rm(dir, { recursive: true, force: true })));
});

async function makeRoot(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "s4-source-"));
  TEMP_ROOTS.push(dir);
  return dir;
}

function rec(overrides: Partial<MemoryRecord>): MemoryRecord {
  const base: MemoryRecord = {
    schemaVersion: 1,
    id: "rec-1",
    scope: "epic",
    scopeRef: "issue-303",
    mode: "empirical",
    provenance: "measured",
    authority: "authoritative",
    statement: "the measured throughput was 42 rps",
    createdAt: "2026-01-01T00:00:00Z",
  };
  return { ...base, ...overrides };
}

/** Write a record onto disk at its canonical S3 layout path. */
async function put(root: string, record: MemoryRecord): Promise<string> {
  const relPath = recordRelativePath(record);
  const abs = join(root, relPath);
  await mkdir(dirname(abs), { recursive: true });
  await writeFile(abs, JSON.stringify(record, null, 2), "utf8");
  return relPath;
}

test("constructor rejects a relative substrate root", () => {
  assert.throws(() => new GitRecordSource("relative/path"), RecordSourceError);
});

test("list() on an empty / missing store is [] (cold read degrades gracefully)", async () => {
  const root = await makeRoot();
  const source = new GitRecordSource(root);
  assert.deepEqual(await source.list(), []);
  assert.deepEqual(await source.list({ scope: "epic", scopeRef: "nope" }), []);
});

test("list() reads every record under the layout, in deterministic path order", async () => {
  const root = await makeRoot();
  await put(root, rec({ id: "b", scope: "epic", scopeRef: "issue-303" }));
  await put(root, rec({ id: "a", scope: "repo", scopeRef: undefined, provenance: "human", mode: "normative", authority: "authoritative" }));
  const source = new GitRecordSource(root);
  const all = await source.list();
  assert.equal(all.length, 2);
  // Sorted by substrate-relative path.
  assert.deepEqual([...all].map((s) => s.path), [...all].map((s) => s.path).sort());
  const ids = all.map((s) => s.record.id).sort();
  assert.deepEqual(ids, ["a", "b"]);
});

test("list(selector) reads only one namespace partition", async () => {
  const root = await makeRoot();
  await put(root, rec({ id: "x", scope: "epic", scopeRef: "issue-303" }));
  await put(root, rec({ id: "y", scope: "epic", scopeRef: "issue-999" }));
  await put(root, rec({ id: "z", scope: "repo", scopeRef: "nano-ide", provenance: "human", mode: "normative" }));
  const source = new GitRecordSource(root);

  const ns = await source.list({ scope: "epic", scopeRef: "issue-303" });
  assert.deepEqual(ns.map((s) => s.record.id), ["x"]);

  const scopeWide = await source.list({ scope: "epic" });
  assert.deepEqual(scopeWide.map((s) => s.record.id).sort(), ["x", "y"]);
});

test("non-record and corrupt files under the layout are skipped, not fatal", async () => {
  const root = await makeRoot();
  await put(root, rec({ id: "good" }));
  // A corrupt JSON file at a record-looking path.
  const badPath = join(root, "records", "epic", "issue-303", "broken.json");
  await mkdir(dirname(badPath), { recursive: true });
  await writeFile(badPath, "{ not json", "utf8");
  // A valid JSON file that is NOT a valid record.
  const notRecord = join(root, "records", "epic", "issue-303", "notarecord.json");
  await writeFile(notRecord, JSON.stringify({ hello: "world" }), "utf8");
  // A non-json file is ignored by isRecordPath.
  await writeFile(join(root, "records", "epic", "issue-303", "README.md"), "hi", "utf8");

  const source = new GitRecordSource(root);
  const all = await source.list();
  assert.deepEqual(all.map((s) => s.record.id), ["good"]);
});

test("read() returns a single record by layout path, undefined when absent/invalid", async () => {
  const root = await makeRoot();
  const relPath = await put(root, rec({ id: "solo" }));
  const source = new GitRecordSource(root);

  const found = await source.read(relPath);
  assert.equal(found?.record.id, "solo");

  assert.equal(await source.read("records/epic/issue-303/missing.json"), undefined);
  // A path outside the layout is rejected.
  assert.equal(await source.read("../escape.json"), undefined);
  assert.equal(await source.read("secrets.json"), undefined);
});
