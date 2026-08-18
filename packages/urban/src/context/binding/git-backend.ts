// Slice S1 (binding) — the default git substrate backend: clone on first use,
// fetch + re-pin to `ref` thereafter. No write/commit/PR logic lives here (that
// is S3); this only materialises a working copy pinned to the requested ref.

import { execFile } from "node:child_process";
import { mkdir, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import type { ContextIdentity } from "./identity.ts";
import type {
  ResolvedContextHandle,
  SubstrateBackend,
  SubstrateResolveOptions,
} from "./backend.ts";

const execFileAsync = promisify(execFile);

/** Runs a git subcommand. Injectable so tests can stub git without a network. */
export type GitRunner = (args: readonly string[], cwd?: string) => Promise<string>;

/** Error thrown when a git operation fails during resolution. */
export class SubstrateResolveError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "SubstrateResolveError";
  }
}

const defaultGitRunner: GitRunner = async (args, cwd) => {
  try {
    const { stdout } = await execFileAsync("git", [...args], {
      cwd,
      maxBuffer: 64 * 1024 * 1024,
    });
    return stdout;
  } catch (cause) {
    const label = `git ${args.join(" ")}`;
    throw new SubstrateResolveError(`substrate git command failed: ${label}`, { cause });
  }
};

async function isDir(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

/**
 * True iff `path` exists (as any filesystem entry). Used to detect a git working
 * copy by its `.git` marker, which is a *directory* for a normal clone but a
 * *file* (pointing at the real gitdir) for a worktree or submodule — so a plain
 * directory check would wrongly treat a valid worktree as un-cloned.
 */
async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * The default, git-only substrate backend. Clones the substrate on first use
 * and, on subsequent resolutions, fetches and re-pins the working copy to the
 * requested ref (branch tip, tag, or SHA) without clobbering unrelated state.
 */
export class GitSubstrateBackend implements SubstrateBackend {
  readonly #git: GitRunner;

  constructor(gitRunner: GitRunner = defaultGitRunner) {
    this.#git = gitRunner;
  }

  async materialise(
    identity: ContextIdentity,
    options: SubstrateResolveOptions,
  ): Promise<ResolvedContextHandle> {
    const { localPath } = options;
    const refresh = options.refresh ?? true;
    const alreadyCloned = await pathExists(join(localPath, ".git"));

    if (!alreadyCloned) {
      // A pre-existing, non-git directory at `localPath` would make `git clone`
      // fail with an opaque wrapped error — detect it and report clearly.
      if (await isDir(localPath)) {
        throw new SubstrateResolveError(
          `substrate path already exists but is not a git working copy: ${localPath}`,
        );
      }
      await mkdir(dirname(localPath), { recursive: true });
      // `--` separates options from operands so a `repo` starting with `-`
      // (untrusted manifest input) can't be parsed as a git option.
      await this.#git(["clone", "--", identity.repo, localPath]);
      await this.#pin(localPath, identity.ref);
    } else if (refresh) {
      await this.#git(["fetch", "--tags", "--prune", "--force", "origin"], localPath);
      await this.#pin(localPath, identity.ref);
    }

    return { identity, localPath, repo: identity.repo, ref: identity.ref };
  }

  /**
   * Pin the working copy to `ref`. If `ref` names a remote branch, pin to the
   * fetched remote tip (so a refresh moves the branch forward); otherwise treat
   * `ref` as a tag or SHA and check it out detached.
   */
  async #pin(cwd: string, ref: string): Promise<void> {
    const remoteBranch = await this.#hasRef(cwd, `origin/${ref}`);
    if (remoteBranch) {
      await this.#git(["checkout", "--force", "-B", ref, `origin/${ref}`], cwd);
    } else {
      // `--detach` pins to the exact commit rather than attaching to any local
      // branch that happens to share `ref`'s name; `--end-of-options` stops an
      // option-style `ref` from being parsed as a git flag.
      await this.#git(["checkout", "--force", "--detach", "--end-of-options", ref], cwd);
    }
  }

  async #hasRef(cwd: string, ref: string): Promise<boolean> {
    try {
      await this.#git(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], cwd);
      return true;
    } catch {
      return false;
    }
  }
}
