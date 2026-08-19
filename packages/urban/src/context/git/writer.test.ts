// Slice S3 (git/governance) — integration tests for the write + governance
// layer. Every test drives a LOCAL temporary git repository as the substrate;
// nothing touches the network.

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { promisify } from "node:util";
import { PiiGuardError } from "../pii/index.ts";
import type { MemoryRecord } from "../schema/index.ts";
import { LAYOUT_ROOT } from "./layout.ts";
import { ContextWriter, GovernanceError } from "./writer.ts";

const execFileAsync = promisify(execFile);
const TEMP_ROOTS: string[] = [];

after(async () => {
  await Promise.all(TEMP_ROOTS.map((dir) => rm(dir, { recursive: true, force: true })));
});

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd });
  return stdout.trim();
}

/** Create a temp git repo with an initial commit on `main` as the substrate. */
async function makeSubstrate(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "s3-substrate-"));
  TEMP_ROOTS.push(dir);
  await git(dir, "init");
  await writeFile(join(dir, "README.md"), "# context substrate\n", "utf8");
  await git(dir, "add", "-A");
  await git(
    dir,
    "-c",
    "user.name=seed",
    "-c",
    "user.email=seed@nanobpm.local",
    "commit",
    "--no-gpg-sign",
    "-m",
    "seed",
  );
  // Normalise the default branch name to `main` regardless of git's default.
  await git(dir, "branch", "-M", "main");
  return dir;
}

function record(overrides: Partial<MemoryRecord>): MemoryRecord {
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

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

test("appendRecord persists a measured fact on the base branch", async () => {
  const dir = await makeSubstrate();
  const writer = new ContextWriter({ localPath: dir, ref: "main" });

  const result = await writer.appendRecord(record({ id: "measured-1" }));

  assert.equal(result.branch, "main");
  assert.equal(result.ratified, true);
  assert.equal(result.path, `${LAYOUT_ROOT}/epic/issue-303/measured-1.json`);

  // The record file is on the base branch working tree...
  const onDisk = join(dir, result.path);
  assert.ok(await exists(onDisk), "record file should exist on main");
  const parsed = JSON.parse(await readFile(onDisk, "utf8"));
  assert.equal(parsed.id, "measured-1");
  assert.equal(parsed.provenance, "measured");

  // ...and the merge landed a real commit.
  const head = await git(dir, "rev-parse", "HEAD");
  assert.equal(head, result.mergeCommit);
});

test("baseBranch defaults to the resolved handle's ref, not the checked-out branch", async () => {
  const dir = await makeSubstrate();
  // Diverge the working copy onto another branch...
  await git(dir, "checkout", "-b", "scratch");
  // ...but the handle was resolved (by S1) against `main`.
  const writer = new ContextWriter({ localPath: dir, ref: "main" });

  const result = await writer.appendRecord(record({ id: "on-main" }));

  // The record lands on the S1-resolved ref (main), never the checked-out branch.
  assert.equal(result.branch, "main");
  assert.equal(await git(dir, "rev-parse", "main"), result.mergeCommit);
});

test("appendRecord REJECTS an agent-retro record (must go through governance)", async () => {
  const dir = await makeSubstrate();
  const writer = new ContextWriter({ localPath: dir, ref: "main" });

  await assert.rejects(
    () =>
      writer.appendRecord(
        record({
          id: "retro-1",
          provenance: "agent-retro",
          authority: "hypothesis",
        }),
      ),
    GovernanceError,
  );

  // Nothing was committed — governance rejected the agent-retro record via
  // GovernanceError (in #assertDirectlyAppendable, ahead of the PII guard),
  // before any git write.
  assert.ok(!(await exists(join(dir, `${LAYOUT_ROOT}/epic/issue-303/retro-1.json`))));
});

test("proposePrior writes an UNMERGED bot proposal; ratify merges it", async () => {
  const dir = await makeSubstrate();
  const writer = new ContextWriter({ localPath: dir, ref: "main" });

  const proposal = await writer.proposePrior(
    record({ id: "retro-2", provenance: "agent-retro", authority: "hypothesis" }),
  );

  assert.equal(proposal.ratified, false);
  assert.equal(proposal.baseBranch, "main");
  assert.ok(proposal.branch.startsWith("context/proposal/"));

  // The proposal is NOT on main yet — it is an unratified hypothesis.
  assert.equal(await writer.isRatified(proposal), false);
  assert.ok(
    !(await exists(join(dir, proposal.path))),
    "unratified proposal must not appear on the base branch",
  );
  // ...but it IS committed on the proposal branch (work is preserved).
  const onBranch = await git(dir, "show", `${proposal.branch}:${proposal.path}`);
  assert.ok(onBranch.includes("retro-2"));

  // Ratify == merge the bot PR.
  const ratified = await writer.ratify(proposal);
  assert.equal(ratified.baseBranch, "main");
  assert.equal(await writer.isRatified(proposal), true);
  assert.ok(await exists(join(dir, proposal.path)), "ratified record must be on main");

  // The record's authority is still a hypothesis — ratification accepts it onto
  // the line, it never forges it into an authoritative fact.
  const parsed = JSON.parse(await readFile(join(dir, proposal.path), "utf8"));
  assert.equal(parsed.provenance, "agent-retro");
  assert.equal(parsed.authority, "hypothesis");
});

test("DEFAULT write path rejects a PII-carrying record (guard active by construction)", async () => {
  const dir = await makeSubstrate();
  // NO special guard wiring — the mandatory S6 guard must be active by default.
  const writer = new ContextWriter({ localPath: dir, ref: "main" });

  const pii = record({
    id: "pii-1",
    provenance: "human",
    mode: "normative",
    authority: "hypothesis",
    statement: "escalate to the on-call at jane.doe@example.com immediately",
  });

  await assert.rejects(() => writer.appendRecord(pii), PiiGuardError);

  // The mandatory PII guard is present in the default registry...
  assert.ok(writer.guards.length >= 1);
  // ...and no commit was made — PII is rejected BEFORE any write.
  assert.ok(!(await exists(join(dir, `${LAYOUT_ROOT}/epic/issue-303/pii-1.json`))));

  // The proposal path is guarded identically.
  await assert.rejects(
    () =>
      writer.proposePrior(
        record({
          id: "pii-2",
          provenance: "agent-retro",
          authority: "hypothesis",
          statement: "reach the owner on 415-555-0132 about the retro",
        }),
      ),
    PiiGuardError,
  );
});

test("clean content still passes the default guard", async () => {
  const dir = await makeSubstrate();
  const writer = new ContextWriter({ localPath: dir, ref: "main" });
  const result = await writer.appendRecord(
    record({ id: "clean-1", statement: "the retry budget is three attempts" }),
  );
  assert.ok(await exists(join(dir, result.path)));
});

test("ratify RE-RUNS the mandatory PII guard against the proposal branch content", async () => {
  const dir = await makeSubstrate();
  const writer = new ContextWriter({ localPath: dir, ref: "main" });

  // A clean proposal lands on its bot branch (passes the guard at propose time).
  const proposal = await writer.proposePrior(
    record({ id: "retro-tamper", provenance: "agent-retro", authority: "hypothesis" }),
  );

  // Simulate a proposal branch created/amended OUTSIDE proposePrior: overwrite the
  // proposed record with PII-carrying content and commit it on the proposal branch.
  await git(dir, "checkout", proposal.branch);
  const tampered = record({
    id: "retro-tamper",
    provenance: "agent-retro",
    authority: "hypothesis",
    statement: "page the owner at jane.doe@example.com about the retro",
  });
  await writeFile(join(dir, proposal.path), `${JSON.stringify(tampered, null, 2)}\n`, "utf8");
  await git(dir, "add", "-A");
  await git(
    dir,
    "-c",
    "user.name=attacker",
    "-c",
    "user.email=attacker@nanobpm.local",
    "commit",
    "--no-gpg-sign",
    "-m",
    "tamper: inject PII",
  );
  await git(dir, "checkout", "main");

  // Ratify must re-guard the proposal content and REFUSE to merge the PII record.
  await assert.rejects(() => writer.ratify(proposal), PiiGuardError);

  // The PII record never reached the authoritative line.
  assert.equal(await writer.isRatified(proposal), false);
  assert.ok(
    !(await exists(join(dir, proposal.path))),
    "a PII-carrying proposal must never be ratified onto the base branch",
  );
  // The working tree is left clean for the next operation (no dangling merge).
  assert.equal(await git(dir, "status", "--porcelain"), "");
});

test("ratify REJECTS a proposal branch that smuggles extra changes past the single-file guard", async () => {
  const dir = await makeSubstrate();
  const writer = new ContextWriter({ localPath: dir, ref: "main" });

  const proposal = await writer.proposePrior(
    record({ id: "retro-smuggle", provenance: "agent-retro", authority: "hypothesis" }),
  );

  // Amend the proposal branch to ALSO add an unrelated, PII-carrying record that a
  // single-file re-guard of `proposal.path` would never inspect — the merge would
  // otherwise land it on the authoritative line UNGUARDED.
  await git(dir, "checkout", proposal.branch);
  const smuggled = record({
    id: "smuggled",
    provenance: "agent-retro",
    authority: "hypothesis",
    statement: "page the owner at jane.doe@example.com now",
  });
  const smuggledPath = `${LAYOUT_ROOT}/epic/issue-303/smuggled.json`;
  await writeFile(join(dir, smuggledPath), `${JSON.stringify(smuggled, null, 2)}\n`, "utf8");
  await git(dir, "add", "-A");
  await git(
    dir,
    "-c",
    "user.name=attacker",
    "-c",
    "user.email=attacker@nanobpm.local",
    "commit",
    "--no-gpg-sign",
    "-m",
    "smuggle: add extra unguarded record",
  );
  await git(dir, "checkout", "main");

  // ratify must refuse: the branch↔base diff is not limited to the one proposed file.
  await assert.rejects(() => writer.ratify(proposal), GovernanceError);

  // Neither the proposed nor the smuggled record reached the authoritative line.
  assert.equal(await writer.isRatified(proposal), false);
  assert.ok(
    !(await exists(join(dir, smuggledPath))),
    "a smuggled extra file must never be ratified onto the base branch",
  );
  assert.ok(!(await exists(join(dir, proposal.path))));
  assert.equal(await git(dir, "status", "--porcelain"), "");
});

test("ratify REJECTS a proposal whose on-disk path mismatches the record's canonical layout", async () => {
  const dir = await makeSubstrate();
  const writer = new ContextWriter({ localPath: dir, ref: "main" });

  const proposal = await writer.proposePrior(
    record({ id: "retro-path", provenance: "agent-retro", authority: "hypothesis" }),
  );

  // Amend the record at the SAME path but with a different id, so its canonical
  // layout path (recordRelativePath) no longer matches `proposal.path`. The content
  // is clean (passes the PII guard), isolating the canonical-path defence.
  await git(dir, "checkout", proposal.branch);
  const moved = record({
    id: "different-id",
    provenance: "agent-retro",
    authority: "hypothesis",
  });
  await writeFile(join(dir, proposal.path), `${JSON.stringify(moved, null, 2)}\n`, "utf8");
  await git(dir, "add", "-A");
  await git(
    dir,
    "-c",
    "user.name=x",
    "-c",
    "user.email=x@nanobpm.local",
    "commit",
    "--no-gpg-sign",
    "-m",
    "swap id under the same path",
  );
  await git(dir, "checkout", "main");

  await assert.rejects(() => writer.ratify(proposal), GovernanceError);
  assert.equal(await writer.isRatified(proposal), false);
  assert.equal(await git(dir, "status", "--porcelain"), "");
});

test("ratify REFUSES a branch outside the proposal namespace", async () => {
  const dir = await makeSubstrate();
  const writer = new ContextWriter({ localPath: dir, ref: "main" });

  const proposal = await writer.proposePrior(
    record({ id: "retro-ns", provenance: "agent-retro", authority: "hypothesis" }),
  );

  // Re-point the proposal handle at an arbitrary, non-proposal branch.
  await git(dir, "branch", "rogue", proposal.branch);
  await assert.rejects(
    () => writer.ratify({ ...proposal, branch: "rogue" }),
    GovernanceError,
  );
  assert.equal(await git(dir, "status", "--porcelain"), "");
});

test("ratify REFUSES a proposal whose baseBranch was retargeted off the writer's resolved base", async () => {
  const dir = await makeSubstrate();
  // The writer is bound (by S1) to `main` as its resolved base.
  const writer = new ContextWriter({ localPath: dir, ref: "main" });

  const proposal = await writer.proposePrior(
    record({ id: "retro-rebase", provenance: "agent-retro", authority: "hypothesis" }),
  );

  // A real branch the caller tries to steer the merge onto instead of `main`.
  await git(dir, "branch", "rogue-base", "main");

  // Mutate the plain-object handle to point at a different base than the writer
  // resolved. ratify must refuse — the merge target is the writer's own base, not
  // whatever the (untrusted) handle carries.
  await assert.rejects(
    () => writer.ratify({ ...proposal, baseBranch: "rogue-base" }),
    GovernanceError,
  );

  assert.equal(await writer.isRatified(proposal), false);
  assert.ok(
    !(await exists(join(dir, proposal.path))),
    "a proposal retargeted off the resolved base must never be ratified",
  );
  assert.equal(await git(dir, "status", "--porcelain"), "");
});

test("concurrent proposals use separate branches without clobbering", async () => {
  const dir = await makeSubstrate();
  const writer = new ContextWriter({ localPath: dir, ref: "main" });

  const [p1, p2] = await Promise.all([
    writer.proposePrior(
      record({ id: "conc-a", provenance: "agent-retro", authority: "hypothesis" }),
    ),
    writer.proposePrior(
      record({ id: "conc-b", provenance: "agent-retro", authority: "hypothesis" }),
    ),
  ]);

  assert.notEqual(p1.branch, p2.branch);

  await writer.ratify(p1);
  await writer.ratify(p2);

  // Both records survived the concurrent writes + merges.
  assert.ok(await exists(join(dir, p1.path)));
  assert.ok(await exists(join(dir, p2.path)));
});
