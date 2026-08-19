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
import { type CommitAuthor, GitWriteSubstrate, type WriteSubstrate } from "./substrate.ts";
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

/**
 * A minimal in-memory {@link WriteSubstrate} that fails at a chosen step, used to
 * prove the writer restores the shared working tree to its resolved base after a
 * mid-operation failure (without needing to force a real git failure).
 */
class FailingSubstrate implements WriteSubstrate {
  readonly rootPath = "/virtual/substrate";
  readonly restored: string[] = [];
  #current = "main";
  readonly #failAt: "stageAndCommit";

  constructor(failAt: "stageAndCommit") {
    this.#failAt = failAt;
  }

  get current(): string {
    return this.#current;
  }

  async writeRecordFile(_relPath: string, _content: string): Promise<void> {}
  async readFileAtRef(_ref: string, _relPath: string): Promise<string> {
    return "{}";
  }
  async diffPaths(_baseRef: string, _branch: string): Promise<readonly string[]> {
    return [];
  }
  async currentBranch(): Promise<string> {
    return this.#current;
  }
  async createBranch(name: string, _from: string): Promise<void> {
    this.#current = name;
  }
  async checkout(ref: string): Promise<void> {
    this.#current = ref;
  }
  async stageAndCommit(
    _pathspec: string,
    _message: string,
    _author: CommitAuthor,
  ): Promise<string> {
    if (this.#failAt === "stageAndCommit") {
      throw new Error("simulated commit failure");
    }
    return "commit-sha";
  }
  async mergeBranch(_branch: string, _message: string, _author: CommitAuthor): Promise<string> {
    return "merge-sha";
  }
  async branchExists(_name: string): Promise<boolean> {
    return true;
  }
  async isMerged(_commitish: string, _ref: string): Promise<boolean> {
    return false;
  }
  async restoreClean(ref: string, _pathspec: string): Promise<void> {
    this.#current = ref;
    this.restored.push(ref);
  }
}

/**
 * Wraps a REAL {@link GitWriteSubstrate} but makes `mergeBranch` throw, so a
 * ratifying merge fails AFTER its `checkout(base)` has already moved the shared
 * working tree. Every other step (including the `restoreClean` cleanup) runs
 * against the real repo, and `restored` records whether the `finally` cleanup
 * fired — proving `ratify` restores the tree like `appendRecord`/`proposePrior`.
 */
class MergeFailingSubstrate implements WriteSubstrate {
  readonly restored: string[] = [];
  readonly #inner: GitWriteSubstrate;

  constructor(inner: GitWriteSubstrate) {
    this.#inner = inner;
  }

  get rootPath(): string {
    return this.#inner.rootPath;
  }
  writeRecordFile(relPath: string, content: string): Promise<void> {
    return this.#inner.writeRecordFile(relPath, content);
  }
  readFileAtRef(ref: string, relPath: string): Promise<string> {
    return this.#inner.readFileAtRef(ref, relPath);
  }
  diffPaths(baseRef: string, branch: string): Promise<readonly string[]> {
    return this.#inner.diffPaths(baseRef, branch);
  }
  currentBranch(): Promise<string> {
    return this.#inner.currentBranch();
  }
  createBranch(name: string, from: string): Promise<void> {
    return this.#inner.createBranch(name, from);
  }
  checkout(ref: string): Promise<void> {
    return this.#inner.checkout(ref);
  }
  stageAndCommit(pathspec: string, message: string, author: CommitAuthor): Promise<string> {
    return this.#inner.stageAndCommit(pathspec, message, author);
  }
  async mergeBranch(
    _branch: string,
    _message: string,
    _author: CommitAuthor,
  ): Promise<string> {
    throw new Error("simulated merge failure");
  }
  branchExists(name: string): Promise<boolean> {
    return this.#inner.branchExists(name);
  }
  isMerged(commitish: string, ref: string): Promise<boolean> {
    return this.#inner.isMerged(commitish, ref);
  }
  async restoreClean(ref: string, pathspec: string): Promise<void> {
    this.restored.push(ref);
    await this.#inner.restoreClean(ref, pathspec);
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

test("stageAndCommit stages ONLY the given pathspec — no blanket `git add -A` PII-guard bypass", async () => {
  const dir = await makeSubstrate();
  const substrate = new GitWriteSubstrate(dir);
  const relPath = `${LAYOUT_ROOT}/epic/issue-303/scoped-1.json`;
  await substrate.writeRecordFile(relPath, '{"id":"scoped-1"}\n');
  // A stray, unrelated file the per-record PII guard never inspected. A blanket
  // `git add -A` would sweep it (and any PII in it) into the commit; scoped
  // staging must leave it untracked.
  await writeFile(join(dir, "STRAY_UNGUARDED.txt"), "ssn 123-45-6789\n", "utf8");

  const author: CommitAuthor = { name: "bot", email: "bot@nanobpm.local" };
  const sha = await substrate.stageAndCommit(relPath, "context(test): scoped stage", author);

  // Only the record path is in the commit...
  const committed = await git(dir, "show", "--name-only", "--format=", sha);
  const files = committed.split("\n").filter((line) => line.length > 0);
  assert.deepEqual(files, [relPath], "only the record path may be committed");
  // ...and the unguarded stray file was NOT swept in; it stays untracked.
  const status = await git(dir, "status", "--porcelain", "--", "STRAY_UNGUARDED.txt");
  assert.equal(status, "?? STRAY_UNGUARDED.txt", "stray file must remain untracked");
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

test("proposePrior builds a git-ref-valid branch for an id git would otherwise reject (e.g. a `.lock` suffix)", async () => {
  const dir = await makeSubstrate();
  const writer = new ContextWriter({ localPath: dir, ref: "main" });

  // A schema-valid (non-empty-string) id whose sanitized segment would end in
  // `.lock` — a suffix git reserves for its lock files and rejects in a refname.
  // sanitizeRef must normalise it so the proposal branch is a name git accepts.
  const proposal = await writer.proposePrior(
    record({ id: "foo.lock", provenance: "agent-retro", authority: "hypothesis" }),
  );

  assert.ok(proposal.branch.startsWith("context/proposal/"));
  // git itself must accept the generated branch name.
  await git(dir, "check-ref-format", "--branch", proposal.branch);
  // No path component of the ref ends in `.lock`.
  assert.ok(
    !proposal.branch.split("/").some((seg) => seg.endsWith(".lock")),
    "no ref component may end in `.lock`",
  );
  // The proposal still round-trips through ratify onto the base branch.
  await writer.ratify(proposal);
  assert.ok(await exists(join(dir, proposal.path)), "ratified `.lock`-id record must be on main");
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

test("ratify derives the merge message from the guarded record id, not the caller-controlled proposalId", async () => {
  const dir = await makeSubstrate();
  const writer = new ContextWriter({ localPath: dir, ref: "main" });

  const proposal = await writer.proposePrior(
    record({ id: "retro-msg", provenance: "agent-retro", authority: "hypothesis" }),
  );

  // A caller mutates the plain-object handle to smuggle PII (and a newline) into
  // the field ratify previously interpolated into the merge commit message — a
  // bypass of the mandatory PII guard, which only inspects record CONTENT.
  const tainted = { ...proposal, proposalId: "inject\nleak jane.doe@example.com" };

  const ratified = await writer.ratify(tainted);

  // The merge message is derived from the guarded record.id, so the injected
  // content never reaches the commit trailer.
  const message = await git(dir, "log", "-1", "--format=%B", ratified.mergeCommit);
  assert.ok(message.includes("retro-msg"), "message must carry the guarded record id");
  assert.ok(
    !message.includes("jane.doe@example.com"),
    "injected PII must not reach the merge message",
  );
  assert.ok(!message.includes("inject"), "injected proposalId content must not reach the message");
});

test("isRatified REFUSES a proposal whose baseBranch was retargeted off the writer's resolved base", async () => {
  const dir = await makeSubstrate();
  const writer = new ContextWriter({ localPath: dir, ref: "main" });

  const proposal = await writer.proposePrior(
    record({ id: "retro-isr", provenance: "agent-retro", authority: "hypothesis" }),
  );

  // The proposal is UNratified onto main, but its commit is an ancestor of its own
  // branch. A caller mutates the handle to claim that branch as the base, which —
  // without the base-binding guard — would make the untrusted-base ancestry check
  // report the hypothesis as ratified.
  await git(dir, "branch", "rogue-base", proposal.branch);

  await assert.rejects(
    () => writer.isRatified({ ...proposal, baseBranch: "rogue-base" }),
    GovernanceError,
  );
  // The honest query still reports the truth: not ratified onto the resolved base.
  assert.equal(await writer.isRatified(proposal), false);
});

test("isRatified IGNORES a forged proposal.commit and checks the real branch tip", async () => {
  const dir = await makeSubstrate();
  const writer = new ContextWriter({ localPath: dir, ref: "main" });

  const proposal = await writer.proposePrior(
    record({ id: "retro-forge", provenance: "agent-retro", authority: "hypothesis" }),
  );

  // ATTACK: the proposal branch is genuinely UNmerged, but a consumer forges the
  // plain-object handle's `commit` to point at base's own HEAD — a commit that IS an
  // ancestor of `main`. A `commit`-trusting ancestry check would report this unmerged
  // hypothesis as ratified. The check must instead derive from the real branch tip.
  const baseHead = await git(dir, "rev-parse", "main");
  assert.equal(
    await writer.isRatified({ ...proposal, commit: baseHead }),
    false,
    "a forged commit must not make an unmerged proposal read as ratified",
  );

  // A genuine ratification flips the honest answer to true — proving the branch-tip
  // check is not merely rejecting everything.
  await writer.ratify(proposal);
  assert.equal(await writer.isRatified(proposal), true);
});

test("isRatified reads false for a branch outside the proposal namespace or absent", async () => {
  const dir = await makeSubstrate();
  const writer = new ContextWriter({ localPath: dir, ref: "main" });

  const proposal = await writer.proposePrior(
    record({ id: "retro-ns", provenance: "agent-retro", authority: "hypothesis" }),
  );

  // A branch that is fully merged into main but lives OUTSIDE the proposal namespace
  // must never read as a ratified proposal, even though its tip is an ancestor of base.
  await git(dir, "branch", "rogue-merged", "main");
  assert.equal(await writer.isRatified({ ...proposal, branch: "rogue-merged" }), false);

  // A non-existent branch is, by definition, not a ratified proposal.
  assert.equal(await writer.isRatified({ ...proposal, branch: "context/proposal/ghost" }), false);
});

test("appendRecord restores the working tree to base after a mid-operation failure", async () => {
  const substrate = new FailingSubstrate("stageAndCommit");
  const writer = new ContextWriter({ localPath: "/virtual", ref: "main" }, { substrate });

  await assert.rejects(
    () => writer.appendRecord(record({ id: "midfail" })),
    /simulated commit failure/,
  );

  // The `finally` cleanup returned the shared working tree to the resolved base, so
  // the next serialised operation does not inherit the aborted write's branch.
  assert.equal(substrate.current, "main");
  assert.deepEqual(substrate.restored, ["main"]);
});

test("proposePrior restores the working tree to base after a mid-operation failure", async () => {
  const substrate = new FailingSubstrate("stageAndCommit");
  const writer = new ContextWriter({ localPath: "/virtual", ref: "main" }, { substrate });

  await assert.rejects(
    () =>
      writer.proposePrior(
        record({ id: "midfail", provenance: "agent-retro", authority: "hypothesis" }),
      ),
    /simulated commit failure/,
  );

  assert.equal(substrate.current, "main");
  assert.deepEqual(substrate.restored, ["main"]);
});

test("ratify restores the working tree to base after a merge failure", async () => {
  const dir = await makeSubstrate();
  // A real proposal on its bot branch, created via the normal path.
  const proposer = new ContextWriter({ localPath: dir, ref: "main" });
  const proposal = await proposer.proposePrior(
    record({ id: "retro-mergefail", provenance: "agent-retro", authority: "hypothesis" }),
  );

  // Ratify through a substrate whose merge fails AFTER checkout(base) has moved the
  // shared tree — the exact window where a missing `finally` would strand it.
  const substrate = new MergeFailingSubstrate(new GitWriteSubstrate(dir));
  const writer = new ContextWriter({ localPath: dir, ref: "main" }, { substrate });

  await assert.rejects(() => writer.ratify(proposal), /simulated merge failure/);

  // The `finally` cleanup fired (like appendRecord/proposePrior) so the next
  // serialised op inherits a clean tree on the resolved base, not a half-merged one.
  assert.deepEqual(substrate.restored, ["main"]);
  assert.equal(await git(dir, "rev-parse", "--abbrev-ref", "HEAD"), "main");
  assert.equal(await git(dir, "status", "--porcelain"), "");
});

test("commit subject line is capped so an unbounded id cannot bloat the message", async () => {
  const dir = await makeSubstrate();
  const writer = new ContextWriter({ localPath: dir, ref: "main" });

  // The schema only requires `id` to be a non-empty string, so an accidental or
  // adversarial extremely long id must not produce a huge commit subject.
  const longId = "x".repeat(500);
  const result = await writer.appendRecord(record({ id: longId }));

  const subject = await git(dir, "log", "-1", "--format=%s", result.mergeCommit);
  assert.ok(subject.length < 200, `commit subject must stay bounded, got ${subject.length}`);
  assert.ok(subject.includes("…"), "an over-long id must be truncated with an ellipsis");
  assert.ok(!subject.includes("x".repeat(200)), "the full over-long id must not reach the subject");
});

test("restoreClean discards untracked record residue and returns to the base branch", async () => {
  const dir = await makeSubstrate();
  const substrate = new GitWriteSubstrate(dir);

  // Simulate a failed write: parked on a stray branch with an untracked record file
  // left behind under the layout root.
  await git(dir, "checkout", "-b", "stray");
  const residue = `${LAYOUT_ROOT}/epic/issue-303/residue.json`;
  await substrate.writeRecordFile(residue, "{}\n");
  assert.ok(await exists(join(dir, residue)), "residue should exist before cleanup");

  await substrate.restoreClean("main", LAYOUT_ROOT);

  assert.equal(await git(dir, "rev-parse", "--abbrev-ref", "HEAD"), "main");
  assert.ok(
    !(await exists(join(dir, residue))),
    "untracked residue under the layout root must be cleaned",
  );
  assert.equal(await git(dir, "status", "--porcelain"), "");
  // Unrelated tracked files are untouched.
  assert.ok(await exists(join(dir, "README.md")));
});

test("appendRecord sanitises a newline-bearing id so it cannot inject commit-message lines", async () => {
  const dir = await makeSubstrate();
  const writer = new ContextWriter({ localPath: dir, ref: "main" });

  // `id` is schema-validated only as a non-empty string, so a newline passes. A
  // raw interpolation would split the subject and inject a forged trailer into
  // both the append commit and its merge.
  const result = await writer.appendRecord(
    record({ id: "good-id\nInjected-Trailer: malicious-value" }),
  );

  const commitMsg = await git(dir, "log", "-1", "--format=%B", result.commit);
  const mergeMsg = await git(dir, "log", "-1", "--format=%B", result.mergeCommit);
  for (const [label, msg] of [
    ["commit", commitMsg],
    ["merge", mergeMsg],
  ] as const) {
    assert.ok(msg.includes("good-id"), `${label} message must carry the id`);
    assert.ok(
      !msg.split("\n").some((l) => l.trimStart().startsWith("Injected-Trailer:")),
      `${label} message must not carry the injected content as a standalone trailer`,
    );
    // The whole subject collapsed to a single line — no injected extra lines.
    assert.equal(
      msg.split("\n").filter((l) => l.trim() !== "").length,
      1,
      `${label} message must be a single non-empty line`,
    );
  }
});

test("proposePrior sanitises a newline-bearing id in the hypothesis commit message", async () => {
  const dir = await makeSubstrate();
  const writer = new ContextWriter({ localPath: dir, ref: "main" });

  const proposal = await writer.proposePrior(
    record({
      id: "retro-nl\nInjected-Trailer: malicious-value",
      provenance: "agent-retro",
      authority: "hypothesis",
    }),
  );

  const commitMsg = await git(dir, "log", "-1", "--format=%B", proposal.branch);
  assert.ok(commitMsg.includes("retro-nl"), "propose message must carry the id");
  assert.ok(
    !commitMsg.split("\n").some((l) => l.trimStart().startsWith("Injected-Trailer:")),
    "propose message must not carry the injected content as a standalone trailer",
  );
  assert.equal(
    commitMsg.split("\n").filter((l) => l.trim() !== "").length,
    1,
    "propose message must be a single non-empty line",
  );

  // Ratify re-reads the guarded record; its merge subject must sanitise the id too.
  const ratified = await writer.ratify(proposal);
  const mergeMsg = await git(dir, "log", "-1", "--format=%B", ratified.mergeCommit);
  assert.ok(mergeMsg.includes("retro-nl"), "ratify merge must carry the id");
  assert.ok(
    !mergeMsg.split("\n").some((l) => l.trimStart().startsWith("Injected-Trailer:")),
    "ratify merge must not carry the injected content as a standalone trailer",
  );
  assert.equal(
    mergeMsg.split("\n").filter((l) => l.trim() !== "").length,
    1,
    "ratify merge message must be a single non-empty line",
  );
});
