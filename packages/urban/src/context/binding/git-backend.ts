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

/**
 * Redact URL userinfo (`scheme://user:pass@host` → `scheme://***@host`) from a
 * single git argv token. A manifest-supplied remote URL can embed credentials
 * (e.g. `https://x-access-token:TOKEN@github.com/owner/repo`); scrubbing them
 * before the argv is placed in an error message keeps secrets out of logs,
 * telemetry, and user-facing errors. The raw, unredacted args stay on the
 * error's `cause` for local debugging only.
 */
export const redactUrlUserinfo = (arg: string): string =>
  arg.replace(/(\/\/)[^/@\s]+@/g, "$1***@");

const defaultGitRunner: GitRunner = async (args, cwd) => {
  try {
    const { stdout } = await execFileAsync("git", [...args], {
      cwd,
      maxBuffer: 64 * 1024 * 1024,
    });
    return stdout;
  } catch (cause) {
    const label = `git ${args.map(redactUrlUserinfo).join(" ")}`;
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
 * True iff `path` exists and is itself a symlink (inspected with `lstat`, so the
 * link — not its target — is examined). A missing entry (`ENOENT`/`ENOTDIR`) is
 * not a symlink; any other error is re-thrown rather than silently swallowed.
 */
async function isSymlink(path: string): Promise<boolean> {
  try {
    return (await lstat(path)).isSymbolicLink();
  } catch (cause) {
    if (isNodeErrno(cause, "ENOENT") || isNodeErrno(cause, "ENOTDIR")) {
      return false;
    }
    throw new SubstrateResolveError(`substrate path is not accessible: ${path}`, { cause });
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
    // A symlink AT `localPath` would make every subsequent `join(localPath, …)`
    // and git invocation operate on the link's target — which can point outside
    // the cache root at an arbitrary pre-existing working copy. Reject it before
    // it is ever trusted as a clone, so resolution can never escape the cache
    // root via a planted symlink.
    if (await isSymlink(localPath)) {
      throw new SubstrateResolveError(
        `substrate path is a symlink and would escape the cache root: ${localPath}`,
      );
    }
    // Likewise, a `.git` symlink *inside* an otherwise-legitimate `localPath`
    // would make git treat an arbitrary out-of-cache gitdir as this working
    // copy's repository (cache escape). A real clone never has a symlinked
    // `.git`, so reject one before it is trusted as "already cloned".
    const gitDir = join(localPath, ".git");
    if (await isSymlink(gitDir)) {
      throw new SubstrateResolveError(
        `substrate .git is a symlink and would escape the cache root: ${gitDir}`,
      );
    }
    const alreadyCloned = await pathExists(gitDir);

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
