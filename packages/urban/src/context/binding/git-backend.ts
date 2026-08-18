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
    const alreadyCloned = await isDir(join(localPath, ".git"));

    if (!alreadyCloned) {
      await mkdir(dirname(localPath), { recursive: true });
      await this.#git(["clone", identity.repo, localPath]);
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
      await this.#git(["checkout", "--force", ref], cwd);
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
