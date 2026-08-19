import { test } from "node:test";
import assert from "node:assert/strict";
import { resolve as resolvePath } from "node:path";
import {
  contextIdentityKey,
  resolveContextIdentity,
  sameContext,
} from "./identity.ts";

test("same repo+ref ⇒ same identity key (shared-on-same-name)", () => {
  const a = { repo: "owner/name", ref: "main" };
  const b = { repo: "owner/name", ref: "main" };
  assert.equal(contextIdentityKey(a), contextIdentityKey(b));
  assert.equal(sameContext(a, b), true);
});

test("a different ref is a distinct, private context", () => {
  const a = { repo: "owner/name", ref: "main" };
  const b = { repo: "owner/name", ref: "release" };
  assert.notEqual(contextIdentityKey(a), contextIdentityKey(b));
  assert.equal(sameContext(a, b), false);
});

test("a different repo is a distinct, private context", () => {
  const a = { repo: "owner/name", ref: "main" };
  const b = { repo: "owner/other", ref: "main" };
  assert.equal(sameContext(a, b), false);
});

test("shorthand and equivalent HTTPS URL normalise to the same identity", () => {
  const shorthand = resolveContextIdentity({ repo: "Owner/Name", ref: "main" });
  const url = resolveContextIdentity({
    repo: "https://github.com/owner/name.git",
    ref: "main",
  });
  assert.equal(shorthand.key, url.key);
});

test("a trailing slash after .git does not fork identity (canonical drift guard)", () => {
  // `stripGitSuffix` must remove `.git` even when a trailing slash follows it,
  // or `…/name.git/` canonicalises to a different substrate than `…/name`.
  const plain = resolveContextIdentity({ repo: "https://github.com/owner/name", ref: "main" });
  const dotGitSlash = resolveContextIdentity({
    repo: "https://github.com/owner/name.git/",
    ref: "main",
  });
  const scpSlash = resolveContextIdentity({ repo: "git@github.com:owner/name.git/", ref: "main" });
  assert.equal(dotGitSlash.key, plain.key);
  assert.equal(scpSlash.key, plain.key);
});

test("shorthand resolves to a concrete GitHub HTTPS clone URL", () => {
  const identity = resolveContextIdentity({ repo: "owner/name", ref: "main" });
  assert.equal(identity.repo, "https://github.com/owner/name.git");
});

test("scp-like and https URLs for the same repo share identity", () => {
  const scp = resolveContextIdentity({ repo: "git@github.com:owner/name.git", ref: "v2" });
  const https = resolveContextIdentity({ repo: "https://github.com/owner/name", ref: "v2" });
  assert.equal(scp.key, https.key);
});

test("ssh://, scp-like and https URLs for one repo all share identity", () => {
  const ssh = resolveContextIdentity({ repo: "ssh://git@github.com/owner/name.git", ref: "v2" });
  const scp = resolveContextIdentity({ repo: "git@github.com:owner/name.git", ref: "v2" });
  const https = resolveContextIdentity({ repo: "https://github.com/owner/name", ref: "v2" });
  assert.equal(ssh.key, scp.key);
  assert.equal(ssh.key, https.key);
});

test("embedded credentials and explicit default port do not affect identity", () => {
  const plain = resolveContextIdentity({ repo: "https://github.com/owner/name.git", ref: "main" });
  const creds = resolveContextIdentity({
    repo: "https://user:token@github.com/owner/name.git",
    ref: "main",
  });
  const port = resolveContextIdentity({
    repo: "https://github.com:443/owner/name.git",
    ref: "main",
  });
  assert.equal(creds.key, plain.key);
  assert.equal(port.key, plain.key);
});

test("ssh:// explicit default port (22) does not affect identity", () => {
  const plain = resolveContextIdentity({ repo: "ssh://git@github.com/owner/name.git", ref: "main" });
  const port = resolveContextIdentity({
    repo: "ssh://git@github.com:22/owner/name.git",
    ref: "main",
  });
  assert.equal(port.key, plain.key);
});

test("non-default ports produce DISTINCT identities (no cross-repo collision)", () => {
  const plain = resolveContextIdentity({ repo: "https://host.example/owner/name.git", ref: "main" });
  const alt = resolveContextIdentity({
    repo: "https://host.example:8443/owner/name.git",
    ref: "main",
  });
  const other = resolveContextIdentity({
    repo: "https://host.example:9443/owner/name.git",
    ref: "main",
  });
  assert.notEqual(alt.key, plain.key);
  assert.notEqual(alt.key, other.key);
  // ssh non-default ports must distinguish too.
  const ssh = resolveContextIdentity({ repo: "ssh://git@host.example/owner/name.git", ref: "main" });
  const sshPort = resolveContextIdentity({
    repo: "ssh://git@host.example:2222/owner/name.git",
    ref: "main",
  });
  assert.notEqual(ssh.key, sshPort.key);
});

test("local file paths canonicalise by absolute path", () => {
  const relative = resolveContextIdentity({ repo: "./sub/../sub/repo", ref: "main" });
  const absolute = resolveContextIdentity({
    repo: resolvePath("sub/repo"),
    ref: "main",
  });
  const fileUrl = resolveContextIdentity({
    repo: `file://${resolvePath("sub/repo")}`,
    ref: "main",
  });
  assert.equal(relative.key, absolute.key);
  assert.equal(absolute.key, fileUrl.key);
});

test("file:// host component and percent-encoding canonicalise to one identity", () => {
  const abs = resolvePath("sub/repo");
  const plain = resolveContextIdentity({ repo: `file://${abs}`, ref: "main" });
  // `file://localhost/…` (explicit localhost host) is equivalent to `file:///…`.
  const localhost = resolveContextIdentity({ repo: `file://localhost${abs}`, ref: "main" });
  assert.equal(plain.key, localhost.key);
});

test("percent-encoded file:// path canonicalises to the decoded path identity", () => {
  const dir = resolvePath("with space/repo");
  const decoded = resolveContextIdentity({ repo: `file://${dir}`, ref: "main" });
  const encoded = resolveContextIdentity({
    repo: `file://${dir.replace(/ /g, "%20")}`,
    ref: "main",
  });
  assert.equal(decoded.key, encoded.key);
});

test("slug is filesystem-safe and identity-stable", () => {
  const a = resolveContextIdentity({ repo: "owner/name", ref: "feature/x" });
  const b = resolveContextIdentity({ repo: "owner/name", ref: "feature/x" });
  assert.equal(a.slug, b.slug);
  assert.match(a.slug, /^[a-z0-9-]+$/);
});

test("slug suffix is the full identity key ⇒ distinct keys never share a localPath", () => {
  // The on-disk working copy is `join(cacheRoot, slug)`, so the slug's uniqueness
  // must be exactly as strong as the identity key — a truncated hash suffix would
  // let two distinct keys collide onto one directory. Guard that the slug embeds
  // the whole sha256 key (64 hex chars), not a truncated prefix.
  const identity = resolveContextIdentity({ repo: "owner/name", ref: "main" });
  assert.match(identity.key, /^[0-9a-f]{64}$/);
  assert.ok(
    identity.slug.endsWith(`-${identity.key}`),
    "slug must be suffixed with the full identity key",
  );
});
