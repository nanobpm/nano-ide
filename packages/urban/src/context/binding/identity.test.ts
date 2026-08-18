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

test("shorthand resolves to a concrete GitHub HTTPS clone URL", () => {
  const identity = resolveContextIdentity({ repo: "owner/name", ref: "main" });
  assert.equal(identity.repo, "https://github.com/owner/name.git");
});

test("scp-like and https URLs for the same repo share identity", () => {
  const scp = resolveContextIdentity({ repo: "git@github.com:owner/name.git", ref: "v2" });
  const https = resolveContextIdentity({ repo: "https://github.com/owner/name", ref: "v2" });
  assert.equal(scp.key, https.key);
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

test("slug is filesystem-safe and identity-stable", () => {
  const a = resolveContextIdentity({ repo: "owner/name", ref: "feature/x" });
  const b = resolveContextIdentity({ repo: "owner/name", ref: "feature/x" });
  assert.equal(a.slug, b.slug);
  assert.match(a.slug, /^[a-z0-9-]+$/);
});
