import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve as resolvePath } from "node:path";
import { promisify } from "node:util";
import { ContextResolver, defaultContextCacheRoot } from "./resolver.ts";
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
