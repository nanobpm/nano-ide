// Slice S3 (git/governance) — the WRITE substrate seam.
//
// The write path is deliberately abstracted over a {@link WriteSubstrate}
// interface rather than hard-wired to public git, leaving a clean seam for a
// future PII/mutable or self-hosted backend (the same seam S1's read side keeps
// via `SubstrateBackend`). {@link GitWriteSubstrate} is the default, git-only
// MVP implementation: it composes append-via-commit, branch creation, checkout,
// and merge primitives over a local working copy using an injectable
// {@link GitRunner} (so tests drive a local temp repo without any network).

import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { hardenedGitArgs, redactUrlUserinfo, type GitRunner } from "../binding/index.ts";

const execFileAsync = promisify(execFile);

/** Error thrown when a substrate write/governance git operation fails. */
export class SubstrateWriteError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "SubstrateWriteError";
  }
}

const defaultWriteGitRunner: GitRunner = async (args, cwd) => {
  const hardened = hardenedGitArgs(args);
  try {
    const { stdout } = await execFileAsync("git", hardened, {
      cwd,
      maxBuffer: 64 * 1024 * 1024,
    });
    return stdout;
  } catch (cause) {
    const label = `git ${hardened.map(redactUrlUserinfo).join(" ")}`;
    throw new SubstrateWriteError(`substrate git command failed: ${label}`, { cause });
  }
};

/** The identity a commit/merge is attributed to. */
export interface CommitAuthor {
  readonly name: string;
  readonly email: string;
}

/**
 * The write seam the governance layer composes. A future mutable/PII backend can
 * implement this interface differently (e.g. against a database with real
 * erasure) without the writer or its callers changing. Every method operates on
 * a single logical substrate working copy rooted at {@link rootPath}.
 */
export interface WriteSubstrate {
  /** Absolute path to the substrate working copy. */
  readonly rootPath: string;
  /** Write `content` to `relPath` (relative to {@link rootPath}), creating dirs. */
  writeRecordFile(relPath: string, content: string): Promise<void>;
  /** Read the file at `relPath` as it exists on `ref`, without touching the tree. */
  readFileAtRef(ref: string, relPath: string): Promise<string>;
  /**
   * The substrate-relative paths changed on `branch` relative to its merge-base
   * with `baseRef` — i.e. exactly the set of files a `baseRef`-into-`branch` merge
   * would introduce/modify. Lets a caller assert a merge is limited to expected
   * files before performing it.
   */
  diffPaths(baseRef: string, branch: string): Promise<readonly string[]>;
  /** The name of the currently checked-out branch. */
  currentBranch(): Promise<string>;
  /** Create (or reset) branch `name` at `from` and check it out. */
  createBranch(name: string, from: string): Promise<void>;
  /** Check out an existing branch/ref. */
  checkout(ref: string): Promise<void>;
  /**
   * Recover the shared working copy to a pristine checkout of `ref`: force-checks
   * out `ref` — moving HEAD and discarding ALL tracked modifications across the
   * whole working copy, not only those under `pathspec` — then removes untracked
   * files/dirs UNDER `pathspec`, leaving untracked files OUTSIDE `pathspec`
   * untouched. The broad tracked-file reset is intended: the substrate working
   * copy is a single-writer, serialised recovery seam, so callers must not keep
   * unrelated tracked edits in it across a write that might fail.
   */
  restoreClean(ref: string, pathspec: string): Promise<void>;
  /**
   * Stage the changes UNDER `pathspec` (only) and commit them as `author`;
   * returns the new commit sha. Staging is deliberately scoped to the caller's
   * record path(s) — never a blanket `git add -A` — so an unrelated change
   * elsewhere in the shared working copy can never be swept into a commit that
   * the per-record PII guard only inspected the record content for.
   */
  stageAndCommit(pathspec: string, message: string, author: CommitAuthor): Promise<string>;
  /** Merge `branch` into the current branch as `author`; returns the merge sha. */
  mergeBranch(branch: string, message: string, author: CommitAuthor): Promise<string>;
  /** `true` iff a local branch named `name` exists. */
  branchExists(name: string): Promise<boolean>;
  /**
   * `true` iff `commitish` is an ancestor of (or equal to) `ref` — i.e. landed
   * on it. Both operands are git commit-ish inputs: a raw sha, a branch name, or
   * any other ref resolvable to a commit. `ContextWriter.isRatified` deliberately
   * passes a branch ref (the proposal branch tip) here to bind the check to the
   * real tip rather than a caller-supplied sha, so implementations MUST resolve
   * `commitish` as a general ref, not assume a sha-only input.
   */
  isMerged(commitish: string, ref: string): Promise<boolean>;
}

/**
 * The default git-only write substrate. Composes commit/branch/merge primitives
 * over a local working copy. Commit author identity is passed per-commit via
 * `-c user.name=… -c user.email=…`, so a bare temp repo with no configured user
 * still commits cleanly (and every write path can attribute a bot vs. human
 * author independently).
 */
export class GitWriteSubstrate implements WriteSubstrate {
  readonly rootPath: string;
  readonly #git: GitRunner;

  constructor(rootPath: string, gitRunner: GitRunner = defaultWriteGitRunner) {
    if (!isAbsolute(rootPath)) {
      throw new SubstrateWriteError(`substrate rootPath must be absolute: ${rootPath}`);
    }
    this.rootPath = rootPath;
    this.#git = gitRunner;
  }

  async writeRecordFile(relPath: string, content: string): Promise<void> {
    const target = this.#resolveWithinRoot(relPath);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content, "utf8");
  }

  async readFileAtRef(ref: string, relPath: string): Promise<string> {
    // Read the blob at `ref:relPath` via `git show` — a pure read that never
    // mutates the working tree (no checkout), so a failed read/guard cannot leave
    // the shared working copy on the wrong branch. `#resolveWithinRoot` still
    // rejects any traversal path before it reaches git.
    this.#resolveWithinRoot(relPath);
    return this.#git(["show", "--end-of-options", `${ref}:${relPath}`], this.rootPath);
  }

  async diffPaths(baseRef: string, branch: string): Promise<readonly string[]> {
    // `base...branch` (symmetric-difference range) lists files changed on `branch`
    // since it forked from `baseRef` — precisely what a merge of `branch` would
    // bring onto `baseRef`. `-z` NUL-delimits paths so unusual names never split
    // wrong; `--end-of-options` stops a ref that looks like a flag being parsed.
    const out = await this.#git(
      ["diff", "--name-only", "-z", "--end-of-options", `${baseRef}...${branch}`],
      this.rootPath,
    );
    return out.split("\0").filter((p) => p.length > 0);
  }

  // Resolve a caller-supplied substrate-relative path to an absolute path,
  // refusing anything that escapes the substrate root. Defence in depth: the
  // layout helper already produces traversal-safe paths, but no read/write may
  // ever leave the substrate root regardless of the relPath handed in.
  #resolveWithinRoot(relPath: string): string {
    const target = resolve(this.rootPath, relPath);
    const rel = relative(this.rootPath, target);
    if (rel === "" || rel.startsWith(`..${sep}`) || rel === ".." || isAbsolute(rel)) {
      throw new SubstrateWriteError(`record path escapes the substrate root: ${relPath}`);
    }
    return target;
  }

  async currentBranch(): Promise<string> {
    const out = await this.#git(["rev-parse", "--abbrev-ref", "HEAD"], this.rootPath);
    return out.trim();
  }

  async createBranch(name: string, from: string): Promise<void> {
    // `checkout -B` creates or resets the branch to `from` and checks it out.
    // `--end-of-options` stops an option-style ref from being parsed as a flag.
    await this.#git(["checkout", "-B", name, "--end-of-options", from], this.rootPath);
  }

  async checkout(ref: string): Promise<void> {
    await this.#git(["checkout", "--end-of-options", ref], this.rootPath);
  }

  async restoreClean(ref: string, pathspec: string): Promise<void> {
    // `checkout --force <ref>` moves HEAD to `ref` and discards modifications to ALL
    // tracked files across the working copy (not just under `pathspec`) — the full
    // reset a post-failure recovery of this single-writer working copy wants. `clean
    // -fd` then removes leftover UNTRACKED files/dirs, scoped to `pathspec` (the
    // record layout root) so it never touches untracked files elsewhere. `--` ends
    // option parsing before the pathspec so a path that looks like a flag is never
    // misread as one.
    await this.#git(["checkout", "--force", "--end-of-options", ref], this.rootPath);
    await this.#git(["clean", "-fd", "--", pathspec], this.rootPath);
  }

  async stageAndCommit(
    pathspec: string,
    message: string,
    author: CommitAuthor,
  ): Promise<string> {
    // Stage ONLY the caller's record path(s) — `add -A -- <pathspec>` — never a
    // blanket `git add -A`. A blanket stage would sweep ANY unrelated tracked or
    // untracked change in the shared single-writer working copy into this commit,
    // bypassing the per-record PII guard that inspected the record content alone
    // (and risking committing stray residue outside the record layout). `-A` still
    // captures adds/modifies/deletes, but confined to `pathspec`; `--` ends option
    // parsing so a path that looks like a flag is never misread.
    await this.#git(["add", "-A", "--", pathspec], this.rootPath);
    await this.#git(
      [
        "-c",
        `user.name=${author.name}`,
        "-c",
        `user.email=${author.email}`,
        "commit",
        "--no-gpg-sign",
        "--allow-empty",
        "-m",
        message,
      ],
      this.rootPath,
    );
    return this.#revParse("HEAD");
  }

  async mergeBranch(branch: string, message: string, author: CommitAuthor): Promise<string> {
    // `--no-ff` always records a merge commit, so ratification (a merge) is a
    // distinct, auditable event even when the branch could fast-forward.
    try {
      await this.#git(
        [
          "-c",
          `user.name=${author.name}`,
          "-c",
          `user.email=${author.email}`,
          "merge",
          "--no-ff",
          "--no-gpg-sign",
          "-m",
          message,
          "--end-of-options",
          branch,
        ],
        this.rootPath,
      );
    } catch (cause) {
      // A failed merge (e.g. a content conflict) leaves the working tree in a
      // conflicted MERGE_HEAD state. Abort it best-effort so the shared working
      // copy is clean for the next serialised operation, then surface the cause.
      await this.#git(["merge", "--abort"], this.rootPath).catch(() => {});
      throw cause;
    }
    return this.#revParse("HEAD");
  }

  async branchExists(name: string): Promise<boolean> {
    try {
      await this.#git(["show-ref", "--verify", "--quiet", `refs/heads/${name}`], this.rootPath);
      return true;
    } catch {
      return false;
    }
  }

  async isMerged(commitish: string, ref: string): Promise<boolean> {
    try {
      // `--end-of-options` (as every other ref-passing call in this file) stops an
      // option-style `commitish`/`ref` (e.g. a caller-supplied baseBranch override)
      // from being parsed as a `git merge-base` flag rather than a revision.
      await this.#git(
        ["merge-base", "--is-ancestor", "--end-of-options", commitish, ref],
        this.rootPath,
      );
      return true;
    } catch {
      return false;
    }
  }

  async #revParse(ref: string): Promise<string> {
    // `git rev-parse` echoes `--end-of-options` back as output, so it is omitted
    // here; `ref` on this path is always an internally-produced value (`HEAD`).
    const out = await this.#git(["rev-parse", ref], this.rootPath);
    return out.trim();
  }
}

/** Join a substrate-relative path onto an absolute root (POSIX-in, native-out). */
export function substratePath(root: string, relPath: string): string {
  return join(root, relPath);
}
