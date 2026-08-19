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
import { hardenedGitArgs, type GitRunner } from "../binding/index.ts";

const execFileAsync = promisify(execFile);

/** Error thrown when a substrate write/governance git operation fails. */
export class SubstrateWriteError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "SubstrateWriteError";
  }
}

/** Redact URL userinfo (`user:pass@host` → `***@host`) from a git argv token. */
const redactUrlUserinfo = (arg: string): string => arg.replace(/(\/\/)[^/@\s]+@/g, "$1***@");

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
  /** The name of the currently checked-out branch. */
  currentBranch(): Promise<string>;
  /** Create (or reset) branch `name` at `from` and check it out. */
  createBranch(name: string, from: string): Promise<void>;
  /** Check out an existing branch/ref. */
  checkout(ref: string): Promise<void>;
  /** Stage all changes and commit them as `author`; returns the new commit sha. */
  stageAndCommit(message: string, author: CommitAuthor): Promise<string>;
  /** Merge `branch` into the current branch as `author`; returns the merge sha. */
  mergeBranch(branch: string, message: string, author: CommitAuthor): Promise<string>;
  /** `true` iff a local branch named `name` exists. */
  branchExists(name: string): Promise<boolean>;
  /** `true` iff `commit` is an ancestor of (or equal to) `ref` — i.e. landed on it. */
  isMerged(commit: string, ref: string): Promise<boolean>;
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
    const target = resolve(this.rootPath, relPath);
    // Defence in depth: the layout helper already produces traversal-safe paths,
    // but never let a caller-supplied relPath escape the substrate root.
    const rel = relative(this.rootPath, target);
    if (rel === "" || rel.startsWith(`..${sep}`) || rel === ".." || isAbsolute(rel)) {
      throw new SubstrateWriteError(`record path escapes the substrate root: ${relPath}`);
    }
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content, "utf8");
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

  async stageAndCommit(message: string, author: CommitAuthor): Promise<string> {
    await this.#git(["add", "-A"], this.rootPath);
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

  async isMerged(commit: string, ref: string): Promise<boolean> {
    try {
      await this.#git(["merge-base", "--is-ancestor", commit, ref], this.rootPath);
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
