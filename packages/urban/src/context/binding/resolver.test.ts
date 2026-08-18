import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

// --- Real git resolution (no network: a local temp repo is the substrate) ---

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
