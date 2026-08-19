import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, dirname, resolve as resolvePath } from "node:path";
import { promisify } from "node:util";
import { ContextResolver, defaultContextCacheRoot } from "./resolver.ts";
import { GitSubstrateBackend, redactUrlUserinfo } from "./git-backend.ts";
import type { GitRunner } from "./git-backend.ts";
import type {
  ResolvedContextHandle,
  SubstrateBackend,
  SubstrateResolveOptions,
} from "./backend.ts";
import { resolveContextIdentity } from "./identity.ts";
import type { ContextIdentity } from "./identity.ts";

const execFileAsync = promisify(execFile);

/** A backend that records calls instead of touching disk — for sharing tests. */
class RecordingBackend implements SubstrateBackend {
  readonly calls: Array<{ key: string; localPath: string }> = [];
  async materialise(
    identity: ContextIdentity,
    options: SubstrateResolveOptions,
  ): Promise<ResolvedContextHandle> {
    this.calls.push({ key: identity.key, localPath: options.localPath });
    return {
      identity,
      localPath: options.localPath,
      repo: identity.repo,
      ref: identity.ref,
    };
  }
}

test("resolver memoises per identity — same name resolves once, shared handle", async () => {
  const backend = new RecordingBackend();
  const resolver = new ContextResolver({ cacheRoot: "/tmp/urban-cache", backend });
  const first = await resolver.resolve({ repo: "owner/name", ref: "main" });
  const second = await resolver.resolve({ repo: "owner/name", ref: "main" });
  assert.equal(first, second, "same name returns the identical handle");
  assert.equal(backend.calls.length, 1, "substrate materialised exactly once");
});

test("distinct names resolve to distinct, private substrates", async () => {
  const backend = new RecordingBackend();
  const resolver = new ContextResolver({ cacheRoot: "/tmp/urban-cache", backend });
  const a = await resolver.resolve({ repo: "owner/name", ref: "main" });
  const b = await resolver.resolve({ repo: "owner/other", ref: "main" });
  assert.notEqual(a.localPath, b.localPath);
  assert.equal(backend.calls.length, 2);
});

test("localPath is derived deterministically from the identity slug", async () => {
  const backend = new RecordingBackend();
  const resolver = new ContextResolver({ cacheRoot: "/root", backend });
  const handle = await resolver.resolve({ repo: "owner/name", ref: "main" });
  const identity = resolveContextIdentity({ repo: "owner/name", ref: "main" });
  assert.equal(handle.localPath, join("/root", identity.slug));
});

test("a relative cacheRoot is normalised to an absolute localPath", async () => {
  const backend = new RecordingBackend();
  const resolver = new ContextResolver({ cacheRoot: "relative/cache", backend });
  const handle = await resolver.resolve({ repo: "owner/name", ref: "main" });
  assert.equal(isAbsolute(resolver.cacheRoot), true);
  assert.equal(isAbsolute(handle.localPath), true);
  const identity = resolveContextIdentity({ repo: "owner/name", ref: "main" });
  assert.equal(handle.localPath, join(resolvePath("relative/cache"), identity.slug));
});

test("defaultContextCacheRoot honours URBAN_CONTEXT_CACHE_DIR then XDG", () => {
  assert.equal(
    defaultContextCacheRoot({ URBAN_CONTEXT_CACHE_DIR: "/explicit" }),
    "/explicit",
  );
  assert.equal(
    defaultContextCacheRoot({ XDG_CACHE_HOME: "/xdg" }),
    join("/xdg", "urban", "context"),
  );
});

/** A backend whose `materialise` blocks until released — lets tests observe how
 * many materialisations run concurrently for one identity. */
class GatedBackend implements SubstrateBackend {
  calls = 0;
  concurrent = 0;
  maxConcurrent = 0;
  #release!: () => void;
  readonly gate = new Promise<void>((resolve) => {
    this.#release = resolve;
  });
  release(): void {
    this.#release();
  }
  async materialise(
    identity: ContextIdentity,
    options: SubstrateResolveOptions,
  ): Promise<ResolvedContextHandle> {
    this.calls += 1;
    this.concurrent += 1;
    this.maxConcurrent = Math.max(this.maxConcurrent, this.concurrent);
    await this.gate;
    this.concurrent -= 1;
    return {
      identity,
      localPath: options.localPath,
      repo: identity.repo,
      ref: identity.ref,
    };
  }
}

test("concurrent resolves coalesce onto one in-flight materialisation, even with refresh:true", async () => {
  const backend = new GatedBackend();
  const resolver = new ContextResolver({ cacheRoot: "/tmp/urban-cache", backend });
  const binding = { repo: "owner/name", ref: "main" };
  // Fire a default resolve and a refresh:true resolve while the first is still
  // in flight — they must share the single materialisation, never double-clone.
  const p1 = resolver.resolve(binding);
  const p2 = resolver.resolve(binding, { refresh: true });
  backend.release();
  const [a, b] = await Promise.all([p1, p2]);
  assert.equal(backend.calls, 1, "materialise ran exactly once");
  assert.equal(backend.maxConcurrent, 1, "never two materialisations in flight");
  assert.equal(a, b, "both resolves share the same handle");
});

test("refresh:true after a settled resolution re-materialises", async () => {
  const backend = new RecordingBackend();
  const resolver = new ContextResolver({ cacheRoot: "/tmp/urban-cache", backend });
  const binding = { repo: "owner/name", ref: "main" };
  await resolver.resolve(binding);
  await resolver.resolve(binding, { refresh: true });
  assert.equal(backend.calls.length, 2, "explicit refresh forces a fresh materialise");
});

// --- Real git resolution (no network: a local temp repo is the substrate) ---

test("git backend fails clearly when localPath exists but is not a git working copy", async () => {
  const root = await mkdtemp(join(tmpdir(), "urban-ctx-nongit-"));
  try {
    const origin = join(root, "origin");
    const cacheRoot = join(root, "cache");
    await execFileAsync("git", ["init", "-b", "main", origin]);
    await git(origin, "config", "user.email", "t@example.com");
    await git(origin, "config", "user.name", "Test");
    await writeFile(join(origin, "a.txt"), "x\n");
    await git(origin, "add", "a.txt");
    await git(origin, "commit", "-m", "c1");

    const binding = { repo: origin, ref: "main" };
    const identity = resolveContextIdentity(binding);
    // Squat the target path with a non-git directory.
    const localPath = join(cacheRoot, identity.slug);
    await mkdir(localPath, { recursive: true });
    await writeFile(join(localPath, "stray.txt"), "not a clone\n");

    const resolver = new ContextResolver({ cacheRoot });
    await assert.rejects(resolver.resolve(binding), /not a git working copy/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("git backend fails clearly when localPath exists but is a non-directory (file)", async () => {
  const root = await mkdtemp(join(tmpdir(), "urban-ctx-file-"));
  try {
    const cacheRoot = join(root, "cache");
    const binding = { repo: join(root, "origin"), ref: "main" };
    const identity = resolveContextIdentity(binding);
    // Squat the target path with a plain file (not a directory, no `.git`).
    // `git clone` into it would fail with an opaque wrapped error; the backend
    // must detect any pre-existing non-git entry and report it clearly.
    const localPath = join(cacheRoot, identity.slug);
    await mkdir(dirname(localPath), { recursive: true });
    await writeFile(localPath, "i am a file, not a clone\n");

    const resolver = new ContextResolver({ cacheRoot });
    await assert.rejects(resolver.resolve(binding), /not a git working copy/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("git backend rejects a symlink at localPath (dangling) — never trusts a link as a clone", async () => {
  const root = await mkdtemp(join(tmpdir(), "urban-ctx-symlink-"));
  try {
    const cacheRoot = join(root, "cache");
    const binding = { repo: join(root, "origin"), ref: "main" };
    const identity = resolveContextIdentity(binding);
    // Squat the target path with a symlink to a non-existent target. A symlink AT
    // localPath is rejected outright (via `lstat`, which sees the link itself),
    // because trusting it would make every git op operate on the link's target.
    const localPath = join(cacheRoot, identity.slug);
    await mkdir(dirname(localPath), { recursive: true });
    await symlink(join(root, "does-not-exist"), localPath);

    const resolver = new ContextResolver({ cacheRoot });
    await assert.rejects(resolver.resolve(binding), /symlink and would escape the cache root/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("git backend rejects a symlink at localPath pointing to a real working copy (cache escape)", async () => {
  const root = await mkdtemp(join(tmpdir(), "urban-ctx-escape-"));
  try {
    const cacheRoot = join(root, "cache");
    const binding = { repo: join(root, "origin"), ref: "main" };
    const identity = resolveContextIdentity(binding);
    // A symlink whose target is a genuine, existing git working copy OUTSIDE the
    // cache root: `join(localPath, ".git")` would resolve through the link and
    // make the backend treat the foreign copy as an already-cloned substrate,
    // running git operations in it. The symlink guard must reject it up front.
    const foreign = join(root, "foreign");
    await mkdir(join(foreign, ".git"), { recursive: true });
    const localPath = join(cacheRoot, identity.slug);
    await mkdir(dirname(localPath), { recursive: true });
    await symlink(foreign, localPath);

    const resolver = new ContextResolver({ cacheRoot });
    await assert.rejects(resolver.resolve(binding), /symlink and would escape the cache root/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("git backend rejects a real directory whose .git is a symlink escaping the cache root", async () => {
  const root = await mkdtemp(join(tmpdir(), "urban-ctx-gitlink-"));
  try {
    const cacheRoot = join(root, "cache");
    const binding = { repo: join(root, "origin"), ref: "main" };
    const identity = resolveContextIdentity(binding);
    // `localPath` itself is a genuine directory (passing the symlink-at-localPath
    // guard), but its `.git` is a symlink pointing at a foreign gitdir OUTSIDE the
    // cache root. Trusting it as "already cloned" would run fetch/pin against that
    // out-of-cache repository — a cache escape. The `.git`-symlink guard must
    // reject it before the working copy is considered cloned.
    const foreignGit = join(root, "foreign-git");
    await mkdir(foreignGit, { recursive: true });
    const localPath = join(cacheRoot, identity.slug);
    await mkdir(localPath, { recursive: true });
    await symlink(foreignGit, join(localPath, ".git"));

    const resolver = new ContextResolver({ cacheRoot });
    await assert.rejects(resolver.resolve(binding), /\.git is a symlink and would escape the cache root/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("git backend surfaces a non-ENOENT lstat error (unreadable path) instead of treating it as missing", async () => {
  if (typeof process.getuid === "function" && process.getuid() === 0) {
    return; // root bypasses permission bits, so EACCES can't be provoked
  }
  const root = await mkdtemp(join(tmpdir(), "urban-ctx-eacces-"));
  try {
    const cacheRoot = join(root, "cache");
    const binding = { repo: join(root, "origin"), ref: "main" };
    const identity = resolveContextIdentity(binding);
    // Make the substrate dir unsearchable so `lstat(localPath/.git)` fails with
    // EACCES (not ENOENT). An existing-but-unreadable path must NOT be reported
    // as "missing" (which would proceed to clone) — it must surface the error.
    const localPath = join(cacheRoot, identity.slug);
    await mkdir(localPath, { recursive: true });
    await chmod(localPath, 0o000);

    const resolver = new ContextResolver({ cacheRoot });
    await assert.rejects(resolver.resolve(binding), /not accessible/);
  } finally {
    await chmod(join(root, "cache", resolveContextIdentity({ repo: join(root, "origin"), ref: "main" }).slug), 0o755).catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
});

test("git backend passes --end-of-options to rev-parse so an option-like ref can't be a git flag", async () => {
  const root = await mkdtemp(join(tmpdir(), "urban-ctx-refguard-"));
  try {
    const calls: string[][] = [];
    const runner: GitRunner = async (args) => {
      calls.push([...args]);
      return ""; // rev-parse "succeeds" ⇒ ref is treated as a remote branch
    };
    const backend = new GitSubstrateBackend(runner);
    const identity = resolveContextIdentity({ repo: join(root, "origin"), ref: "main" });
    const localPath = join(root, "cache", identity.slug);
    await backend.materialise(identity, { localPath, refresh: true });

    const revParse = calls.find((a) => a[0] === "rev-parse");
    assert.ok(revParse, "rev-parse was invoked during pinning");
    assert.ok(
      revParse.includes("--end-of-options"),
      "rev-parse stops option parsing before the manifest-controlled ref",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("defaultGitRunner redaction scrubs credentialed URLs from error labels", () => {
  assert.equal(
    redactUrlUserinfo("https://x-access-token:SECRET@github.com/o/r.git"),
    "https://***@github.com/o/r.git",
  );
  assert.equal(
    redactUrlUserinfo("ssh://user:pw@host/o/r"),
    "ssh://***@host/o/r",
  );
  // A URL without userinfo, and scp-style `git@host:path` (no `//`), are untouched.
  assert.equal(redactUrlUserinfo("https://github.com/o/r.git"), "https://github.com/o/r.git");
  assert.equal(redactUrlUserinfo("git@github.com:o/r.git"), "git@github.com:o/r.git");
});

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd });
  return stdout.trim();
}

test("git backend clones on first use and re-pins on refresh; cross-instance sharing", async () => {
  const root = await mkdtemp(join(tmpdir(), "urban-ctx-"));
  try {
    const origin = join(root, "origin");
    const cacheRoot = join(root, "cache");
    await execFileAsync("git", ["init", "-b", "main", origin]);
    await git(origin, "config", "user.email", "t@example.com");
    await git(origin, "config", "user.name", "Test");
    await writeFile(join(origin, "note.md"), "v1\n");
    await git(origin, "add", "note.md");
    await git(origin, "commit", "-m", "v1");

    const binding = { repo: origin, ref: "main" };
    const resolver = new ContextResolver({ cacheRoot });
    const handle = await resolver.resolve(binding);

    assert.equal(handle.ref, "main");
    assert.equal(handle.localPath, join(cacheRoot, handle.identity.slug));
    assert.equal((await readFile(join(handle.localPath, "note.md"), "utf8")).trim(), "v1");

    // Advance origin, then refresh the pinned working copy.
    await writeFile(join(origin, "note.md"), "v2\n");
    await git(origin, "commit", "-am", "v2");
    const refreshed = await resolver.resolve(binding, { refresh: true });
    assert.equal(
      (await readFile(join(refreshed.localPath, "note.md"), "utf8")).trim(),
      "v2",
    );

    // Cross-instance: a second resolver on the same cacheRoot reuses the same
    // on-disk substrate (shared-on-same-name across processes/instances).
    const other = new ContextResolver({ cacheRoot });
    const shared = await other.resolve(binding, { refresh: false });
    assert.equal(shared.localPath, handle.localPath);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("git backend treats a `.git` file (worktree/submodule marker) as already cloned", async () => {
  const root = await mkdtemp(join(tmpdir(), "urban-ctx-worktree-"));
  try {
    const cacheRoot = join(root, "cache");
    const binding = { repo: join(root, "origin"), ref: "main" };
    const identity = resolveContextIdentity(binding);
    // A worktree/submodule marks its working copy with a `.git` *file* pointing
    // at the real gitdir, not a `.git` *directory*. The backend must recognise
    // it as a valid clone rather than treating it as an un-cloned/non-git path.
    const localPath = join(cacheRoot, identity.slug);
    await mkdir(localPath, { recursive: true });
    await writeFile(join(localPath, ".git"), "gitdir: /somewhere/else/.git/worktrees/x\n");

    const resolver = new ContextResolver({ cacheRoot });
    // refresh:false so no git runs; the point is it must NOT throw "not a git
    // working copy" — the `.git` file already proves it is a working copy.
    const handle = await resolver.resolve(binding, { refresh: false });
    assert.equal(handle.localPath, localPath);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("git backend pins to a tag (detached), not just branches", async () => {
  const root = await mkdtemp(join(tmpdir(), "urban-ctx-tag-"));
  try {
    const origin = join(root, "origin");
    const cacheRoot = join(root, "cache");
    await execFileAsync("git", ["init", "-b", "main", origin]);
    await git(origin, "config", "user.email", "t@example.com");
    await git(origin, "config", "user.name", "Test");
    await writeFile(join(origin, "a.txt"), "tagged\n");
    await git(origin, "add", "a.txt");
    await git(origin, "commit", "-m", "c1");
    await git(origin, "tag", "v1.0.0");
    // Move main forward so the tag is genuinely an older pin.
    await writeFile(join(origin, "a.txt"), "moved\n");
    await git(origin, "commit", "-am", "c2");

    const resolver = new ContextResolver({ cacheRoot });
    const handle = await resolver.resolve({ repo: origin, ref: "v1.0.0" });
    assert.equal((await readFile(join(handle.localPath, "a.txt"), "utf8")).trim(), "tagged");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
