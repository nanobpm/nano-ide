// Slice S4 (retrieval) — integration tests. The substrate is populated via S3's
// REAL write path (ContextWriter over a local temp git repo); nothing touches
// the network. This proves retrieval reads the exact layout S3 writes and that
// the derived cache is a correct, disposable projection of git.

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { promisify } from "node:util";
import { ContextWriter } from "../git/index.ts";
import type { MemoryRecord } from "../schema/index.ts";
import { ContextRetriever } from "./retriever.ts";

const execFileAsync = promisify(execFile);
const TEMP_ROOTS: string[] = [];

after(async () => {
  await Promise.all(TEMP_ROOTS.map((dir) => rm(dir, { recursive: true, force: true })));
});

async function git(cwd: string, ...args: string[]): Promise<void> {
  await execFileAsync("git", args, { cwd });
}

/** A temp git repo with an initial commit on `main`, used as the substrate. */
async function makeSubstrate(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "s4-substrate-"));
  TEMP_ROOTS.push(dir);
  await git(dir, "init");
  await writeFile(join(dir, "README.md"), "# context substrate\n", "utf8");
  await git(dir, "add", "-A");
  await git(dir, "-c", "user.name=seed", "-c", "user.email=seed@nanobpm.local", "commit", "--no-gpg-sign", "-m", "seed");
  await git(dir, "branch", "-M", "main");
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

/** Populate a fresh substrate with a mix of records via S3's write path. */
async function seededSubstrate(): Promise<{ dir: string; writer: ContextWriter }> {
  const dir = await makeSubstrate();
  const writer = new ContextWriter({ localPath: dir, ref: "main" });
  await writer.appendRecord(rec({ id: "epic-measured", scope: "epic", scopeRef: "issue-303", statement: "the measured throughput was 42 rps" }));
  await writer.appendRecord(rec({ id: "epic-human", scope: "epic", scopeRef: "issue-303", provenance: "human", mode: "normative", authority: "authoritative", statement: "prefer explicit errors over silent fallbacks" }));
  await writer.appendRecord(rec({ id: "epic-other-ns", scope: "epic", scopeRef: "issue-999", provenance: "instance", mode: "empirical", authority: "authoritative", statement: "instance run observed a retry storm" }));
  await writer.appendRecord(rec({ id: "repo-norm", scope: "repo", scopeRef: "nano-ide", provenance: "human", mode: "normative", authority: "authoritative", statement: "all writes go through governance" }));
  await writer.appendRecord(rec({ id: "corpus-fact", scope: "corpus", scopeRef: undefined, provenance: "measured", mode: "empirical", authority: "authoritative", statement: "throughput baseline across the corpus" }));
  return { dir, writer };
}

test("retrieves all records written via the S3 write path", async () => {
  const { dir } = await seededSubstrate();
  const retriever = new ContextRetriever({ localPath: dir, ref: "main" });
  const all = await retriever.all();
  assert.deepEqual(all.map((s) => s.record.id).sort(), [
    "corpus-fact",
    "epic-human",
    "epic-measured",
    "epic-other-ns",
    "repo-norm",
  ]);
});

test("is correct on a COLD cache (reads through to git without warming)", async () => {
  const { dir } = await seededSubstrate();
  const retriever = new ContextRetriever({ localPath: dir, ref: "main" });
  assert.equal(retriever.cache.isWarm, false);

  // A path-scoped query on a cold cache reads just that partition and does NOT
  // warm the whole index — retrieval is correct before any rebuild.
  const ns = await retriever.byNamespace("epic", "issue-303");
  assert.deepEqual(ns.map((s) => s.record.id).sort(), ["epic-human", "epic-measured"]);
  assert.equal(retriever.cache.isWarm, false);
});

test("structured / path-scoped query by scope + namespace", async () => {
  const { dir } = await seededSubstrate();
  const retriever = new ContextRetriever({ localPath: dir, ref: "main" });

  const oneNs = await retriever.query({ scope: "epic", scopeRef: "issue-303" });
  assert.deepEqual(oneNs.map((s) => s.record.id).sort(), ["epic-human", "epic-measured"]);
  assert.equal(retriever.cache.isWarm, false, "single-namespace query must not force a full build");

  const wholeScope = await retriever.query({ scope: "epic" });
  assert.deepEqual(wholeScope.map((s) => s.record.id).sort(), ["epic-human", "epic-measured", "epic-other-ns"]);
});

test("frontmatter filtering on typed record fields (OR-sets, ANDed clauses)", async () => {
  const { dir } = await seededSubstrate();
  const retriever = new ContextRetriever({ localPath: dir, ref: "main" });

  const humans = await retriever.query({ provenance: "human" });
  assert.deepEqual(humans.map((s) => s.record.id).sort(), ["epic-human", "repo-norm"]);

  const measuredOrInstance = await retriever.query({ provenance: ["measured", "instance"] });
  assert.deepEqual(measuredOrInstance.map((s) => s.record.id).sort(), ["corpus-fact", "epic-measured", "epic-other-ns"]);

  const normativeHumansInEpic = await retriever.query({ scope: "epic", mode: "normative", provenance: "human" });
  assert.deepEqual(normativeHumansInEpic.map((s) => s.record.id), ["epic-human"]);
});

test("text search across record bodies, composable with filters", async () => {
  const { dir } = await seededSubstrate();
  const retriever = new ContextRetriever({ localPath: dir, ref: "main" });

  const throughput = await retriever.search("throughput");
  assert.deepEqual(throughput.map((s) => s.record.id).sort(), ["corpus-fact", "epic-measured"]);

  const throughputMeasuredInEpic = await retriever.search("throughput", { scope: "epic" });
  assert.deepEqual(throughputMeasuredInEpic.map((s) => s.record.id), ["epic-measured"]);
});

test("limit caps the result set", async () => {
  const { dir } = await seededSubstrate();
  const retriever = new ContextRetriever({ localPath: dir, ref: "main" });
  const limited = await retriever.query({ limit: 2 });
  assert.equal(limited.length, 2);
});

test("the derived cache is disposable: invalidate/rebuild re-projects from git", async () => {
  const { dir, writer } = await seededSubstrate();
  const retriever = new ContextRetriever({ localPath: dir, ref: "main" });

  // Warm the cache with the current store.
  const before = await retriever.all();
  assert.equal(retriever.cache.isWarm, true);
  const beforeCount = before.length;

  // Land a new record via the S3 write path AFTER warming.
  await writer.appendRecord(rec({ id: "late-arrival", scope: "epic", scopeRef: "issue-303", statement: "measured tail latency dropped" }));

  // The warm cache still serves the old projection (it is a snapshot, not live).
  assert.equal((await retriever.all()).length, beforeCount);

  // Invalidate → the next read re-projects from git and sees the new record.
  retriever.invalidate();
  assert.equal(retriever.cache.isWarm, false);
  const after = await retriever.all();
  assert.equal(after.length, beforeCount + 1);
  assert.ok(after.some((s) => s.record.id === "late-arrival"));

  // rebuild() is an eager equivalent.
  await retriever.rebuild();
  assert.equal(retriever.cache.isWarm, true);
});

test("get() reads a single record by its S3 layout path", async () => {
  const { dir } = await seededSubstrate();
  const retriever = new ContextRetriever({ localPath: dir, ref: "main" });
  const all = await retriever.all();
  const target = all.find((s) => s.record.id === "repo-norm");
  assert.ok(target);
  const fetched = await retriever.get(target.path);
  assert.equal(fetched?.record.id, "repo-norm");
});

test("a ratified agent-retro prior is retrievable; provenance/authority survive the round-trip", async () => {
  const dir = await makeSubstrate();
  const writer = new ContextWriter({ localPath: dir, ref: "main" });
  // agent-retro cannot be appended directly — it must be proposed then ratified.
  const proposal = await writer.proposePrior(
    rec({ id: "hypothesis-1", scope: "epic", scopeRef: "issue-303", provenance: "agent-retro", mode: "normative", authority: "hypothesis", statement: "hypothesis: batching reduces retries" }),
  );
  await writer.ratify(proposal);

  const retriever = new ContextRetriever({ localPath: dir, ref: "main" });
  const priors = await retriever.query({ provenance: "agent-retro" });
  assert.deepEqual(priors.map((s) => s.record.id), ["hypothesis-1"]);
  // The schema invariant is preserved on read: an agent-retro prior is never authoritative.
  assert.equal(priors[0]?.record.authority, "hypothesis");
});
