// Slice S1 (binding) — the default git substrate backend: clone on first use,
// fetch + re-pin to `ref` thereafter. No write/commit/PR logic lives here (that
// is S3); this only materialises a working copy pinned to the requested ref.

import { execFile } from "node:child_process";
import { lstat, mkdir } from "node:fs/promises";
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

/**
 * True iff `path` exists as any filesystem entry. Uses `lstat` (not `stat`) so
 * the entry itself is inspected without following symlinks — a symlink counts as
 * a pre-existing entry even when its target is missing (a dangling symlink),
 * which `git clone` would otherwise fail on with an opaque error.
 *
 * Only a genuine "not there" (`ENOENT`/`ENOTDIR`) counts as absent; any other
 * error (e.g. `EACCES`/`EPERM` on an existing-but-unreadable entry) is
 * re-thrown rather than silently reported as "missing", so an unreadable path
 * is never mistaken for a clean slate to clone into.
 */
async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (cause) {
    if (isNodeErrno(cause, "ENOENT") || isNodeErrno(cause, "ENOTDIR")) {
      return false;
    }
    throw new SubstrateResolveError(`substrate path is not accessible: ${path}`, { cause });
  }
}

function isNodeErrno(error: unknown, code: string): boolean {
  return (
    error instanceof Error && "code" in error && error.code === code
  );
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
      // A pre-existing entry at `localPath` that is not a git working copy — a
      // non-git directory, or a file/symlink — would make `git clone` fail with
      // an opaque wrapped error. Detect any such entry and report it clearly.
      if (await pathExists(localPath)) {
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
      // `--end-of-options` stops an option-style `ref` (manifest-controlled)
      // from being parsed as a git flag — the same injection guard used by the
      // `clone`/`checkout` paths.
      await this.#git(
        ["rev-parse", "--verify", "--quiet", "--end-of-options", `${ref}^{commit}`],
        cwd,
      );
      return true;
    } catch {
      return false;
    }
  }
}
