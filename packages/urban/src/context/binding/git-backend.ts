// Slice S1 (binding) — the default git substrate backend: clone on first use,
// fetch + re-pin to `ref` thereafter. No write/commit/PR logic lives here (that
// is S3); this only materialises a working copy pinned to the requested ref.

import { execFile } from "node:child_process";
import { lstat, mkdir, readFile, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
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

/**
 * `git` runs against a working copy that lives in a shared, potentially
 * tampered-with cache. Commands like `fetch` and especially `checkout` execute
 * local hooks (e.g. `post-checkout`, `post-merge`) from the working copy's
 * `.git/hooks` if they exist — so a planted hook in a poisoned cache entry is a
 * code-execution vector. Pinning `core.hooksPath` to a path that cannot contain
 * an executable hook (`/dev/null` is not a directory, so `<hooksPath>/<hook>`
 * never resolves) disables hooks entirely for every automated invocation, so
 * resolution can never execute a script from the cached substrate. Single
 * source of truth for the flag: prepended by {@link hardenedGitArgs} to every
 * argv the default runner spawns. `-c <name>=<value>` must precede the
 * subcommand, so it is prepended (not appended).
 */
export const GIT_SAFETY_CONFIG: readonly string[] = ["-c", "core.hooksPath=/dev/null"];

/** Prepend the hook-disabling safety config to a git argv (single source of truth). */
export const hardenedGitArgs = (args: readonly string[]): string[] => [
  ...GIT_SAFETY_CONFIG,
  ...args,
];

const defaultGitRunner: GitRunner = async (args, cwd) => {
  const hardened = hardenedGitArgs(args);
  try {
    const { stdout } = await execFileAsync("git", hardened, {
      cwd,
      maxBuffer: 64 * 1024 * 1024,
    });
    return stdout;
  } catch (cause) {
    const label = `git ${hardened.map(redactUrlUserinfo).join(" ")}`;
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
 * True iff `path` exists and is a real directory (inspected with `lstat`, so a
 * symlink to a directory does not count). A missing entry (`ENOENT`/`ENOTDIR`)
 * is not a directory; any other error is re-thrown rather than silently
 * swallowed, so an unreadable path is never mistaken for "not a directory".
 */
async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await lstat(path)).isDirectory();
  } catch (cause) {
    if (isNodeErrno(cause, "ENOENT") || isNodeErrno(cause, "ENOTDIR")) {
      return false;
    }
    throw new SubstrateResolveError(`substrate path is not accessible: ${path}`, { cause });
  }
}

/** True iff `child` is `root` itself or nested within it (no `..`/absolute escape). */
function isWithin(root: string, child: string): boolean {
  const rel = relative(root, child);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

/**
 * A `.git` *file* (git worktree/submodule marker) points at the real gitdir via
 * a `gitdir: <path>` line rather than being a `.git` directory. Trusting such a
 * working copy as "already cloned" is only safe when that gitdir stays inside
 * the cache root: a marker whose `gitdir:` resolves OUTSIDE the cache root would
 * make every subsequent `git fetch`/`checkout` operate on an out-of-cache
 * repository — a cache escape of the same class as a `.git` symlink.
 *
 * A string-only containment check is insufficient: an in-cache `gitdir:` path
 * can itself be a *symlink* to an out-of-cache repository (git follows it), and a
 * broken/missing `gitdir:` target must not be trusted as a clone either. So the
 * resolved target is canonicalised through `realpath` (collapsing every symlink
 * along the path — including the gitdir itself) and the cache root is likewise
 * canonicalised, before checking containment. Returns true iff the marker is
 * well-formed AND its fully-resolved gitdir is a real directory within the
 * canonical `cacheRoot`; a malformed marker (no `gitdir:` line), a
 * missing/broken target, or one resolving to a non-directory is not trusted.
 */
async function gitFileTargetWithinRoot(
  gitFile: string,
  localPath: string,
  cacheRoot: string,
): Promise<boolean> {
  // Read the marker file through the same error-wrapping discipline as the rest
  // of this module's access guards: a filesystem failure (e.g. EACCES/EPERM on
  // an unreadable marker, or a race that removes it) surfaces as a
  // SubstrateResolveError rather than leaking a raw Node error to the caller.
  let content: string;
  try {
    content = await readFile(gitFile, "utf8");
  } catch (cause) {
    throw new SubstrateResolveError(`substrate .git marker is not readable: ${gitFile}`, { cause });
  }
  const match = content.match(/^gitdir:[ \t]*(.+?)[ \t]*$/m);
  if (match === null) {
    return false;
  }
  // A relative `gitdir:` is interpreted by git relative to the working copy, so
  // resolve it against `localPath` before checking cache-root containment.
  const target = resolve(localPath, match[1]);
  // Canonicalise both sides through `realpath` so any symlink along the path —
  // notably an in-cache `gitdir:` symlinked to an out-of-cache repository that a
  // string check would wrongly trust — is collapsed before the comparison. A
  // missing/broken target (ENOENT/ENOTDIR) is not a real gitdir and is rejected.
  let realTarget: string;
  let realRoot: string;
  try {
    realTarget = await realpath(target);
    realRoot = await realpath(cacheRoot);
  } catch (cause) {
    if (isNodeErrno(cause, "ENOENT") || isNodeErrno(cause, "ENOTDIR")) {
      return false;
    }
    throw new SubstrateResolveError(`substrate .git target is not accessible: ${target}`, { cause });
  }
  return isWithin(realRoot, realTarget) && (await isDirectory(realTarget));
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

  /**
   * Materialise the working copy at `options.localPath`: clone on first use,
   * fetch + re-pin thereafter.
   *
   * Known limitation (deferred past slice S1): materialisation is NOT guarded by
   * an inter-process lock. The resolver's single-flight coalescing only
   * serialises resolves *within one process*, so two Nano instances that share a
   * `cacheRoot` and resolve the same context concurrently can race the
   * first-use `mkdir → clone → pin` (or `fetch → pin`) sequence for the same
   * `localPath` — one process may observe the path as absent or
   * partially-initialised while the other is still cloning, surfacing a spurious
   * "not a git working copy" error or (worse) a half-written working copy.
   * Cross-process sharing is therefore reliable only once the substrate is
   * already materialised; the concurrent *first-use* case is a documented gap. A
   * follow-up slice will add a per-`localPath` inter-process lock (bounded retry
   * + stale-lock reclamation) to close it. See PR #309 / nano-ide binding notes.
   */
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
    // A genuine clone's `.git` is a *directory*. A `.git` that exists as
    // anything else is a git worktree/submodule marker *file* pointing at a real
    // gitdir elsewhere: trust it as "already cloned" only when that gitdir stays
    // inside the cache root, otherwise fetch/pin would run against an
    // out-of-cache repository — a cache escape of the same class as the
    // `.git`-symlink case above.
    let alreadyCloned = await isDirectory(gitDir);
    if (!alreadyCloned && (await pathExists(gitDir))) {
      const cacheRoot = dirname(localPath);
      if (await gitFileTargetWithinRoot(gitDir, localPath, cacheRoot)) {
        alreadyCloned = true;
      } else {
        throw new SubstrateResolveError(
          `substrate .git points outside the cache root and would escape it: ${gitDir}`,
        );
      }
    }

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
