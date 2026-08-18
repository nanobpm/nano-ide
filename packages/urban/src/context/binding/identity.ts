// Slice S1 (binding) — context *identity*: the private-per-app /
// shared-on-same-name semantics.
//
// A context is named by its `(repo, ref)` pair. Two apps (or two Nano
// instances) that name the SAME context — the same normalised repo and the same
// ref — resolve to the SAME shared substrate; a distinct name stays private.
// This module turns a binding into a stable, canonical **identity key** that
// the resolver uses both to memoise in-process and to derive an on-disk
// location, so "same name ⇒ same substrate" holds within a process AND across
// processes/instances that share a cache root.

import { createHash } from "node:crypto";
import { isAbsolute, resolve as resolvePath } from "node:path";
import type { ContextBinding } from "./descriptor.ts";

/**
 * The resolved, canonical identity of a context binding.
 *
 * `key` is a stable, collision-resistant string: two bindings share a substrate
 * **iff** their `key`s are equal. `repo` is the concrete clone URL derived from
 * the binding's (possibly shorthand) `repo`, and `ref` is the pinned ref.
 */
export interface ContextIdentity {
  /**
   * Stable canonical identity key. Equal keys ⇒ same shared substrate; distinct
   * keys ⇒ private substrates. Safe to use as a map key.
   */
  readonly key: string;
  /** The concrete clone URL (or local/`file://` path) for the substrate. */
  readonly repo: string;
  /** The pinned ref (branch / tag / SHA). */
  readonly ref: string;
  /**
   * Filesystem-safe directory name derived deterministically from {@link key}.
   * Two identities with the same key yield the same directory name, so a shared
   * cache root gives them the same on-disk working copy.
   */
  readonly slug: string;
}

const SHORTHAND = /^[\w.-]+\/[\w.-]+$/;
const SCHEME_URL = /^[a-z][a-z0-9+.-]*:\/\//i;
const SCP_LIKE = /^[\w.-]+@([\w.-]+):(.+)$/; // git@github.com:owner/name.git

interface ClassifiedRepo {
  /** URL/path git can clone from. */
  readonly url: string;
  /** Normalised canonical string used for identity (never the clone URL). */
  readonly canonical: string;
}

function stripGitSuffix(value: string): string {
  return value.replace(/\.git$/i, "").replace(/\/+$/, "");
}

/**
 * Classify a binding `repo` field into a concrete clone URL plus a normalised
 * canonical form for identity. Public git is NOT hard-coded: local/`file://`
 * paths and arbitrary git hosts are first-class, leaving a seam for a future
 * PII/mutable or self-hosted substrate backend.
 */
function classifyRepo(repo: string): ClassifiedRepo {
  const raw = repo.trim();

  // Local filesystem path or file:// URL — used for tests and self-hosted
  // substrates. Canonicalised by absolute path so two spellings of one path
  // share identity.
  if (raw.startsWith("file://") || raw.startsWith(".") || isAbsolute(raw)) {
    const fsPath = raw.startsWith("file://") ? raw.slice("file://".length) : raw;
    const abs = resolvePath(fsPath);
    return { url: raw.startsWith("file://") ? raw : abs, canonical: `file:${abs}` };
  }

  // owner/name shorthand ⇒ GitHub HTTPS clone URL.
  if (SHORTHAND.test(raw)) {
    const canonical = `github.com/${stripGitSuffix(raw).toLowerCase()}`;
    return { url: `https://github.com/${stripGitSuffix(raw)}.git`, canonical };
  }

  // scp-like git URL: git@host:owner/name(.git)
  const scp = SCP_LIKE.exec(raw);
  if (scp) {
    const host = scp[1].toLowerCase();
    const path = stripGitSuffix(scp[2]).toLowerCase();
    return { url: raw, canonical: `${host}/${path}` };
  }

  // scheme URL: https://, ssh://, git://, http://
  if (SCHEME_URL.test(raw)) {
    try {
      const parsed = new URL(raw);
      const host = parsed.host.toLowerCase();
      const path = stripGitSuffix(parsed.pathname).replace(/^\/+/, "").toLowerCase();
      return { url: raw, canonical: `${host}/${path}` };
    } catch {
      // Fall through to the opaque case below.
    }
  }

  // Anything else: treat opaquely but still stable.
  return { url: raw, canonical: stripGitSuffix(raw).toLowerCase() };
}

function toSlug(canonical: string, ref: string, hash: string): string {
  const readable = `${canonical}@${ref}`
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return `${readable || "context"}-${hash.slice(0, 12)}`;
}

/**
 * Compute the canonical {@link ContextIdentity} for a binding. Deterministic and
 * pure: equal `(repo, ref)` names (after normalisation) always produce an equal
 * `key` and `slug`, and distinct names never collide.
 */
export function resolveContextIdentity(binding: ContextBinding): ContextIdentity {
  const { url, canonical } = classifyRepo(binding.repo);
  const ref = binding.ref.trim();
  const canonicalName = `${canonical}#${ref}`;
  const key = createHash("sha256").update(canonicalName, "utf8").digest("hex");
  return { key, repo: url, ref, slug: toSlug(canonical, ref, key) };
}

/**
 * The stable identity key of a binding — the sharing primitive. Two bindings
 * resolve to the same shared substrate iff this returns the same value for
 * both.
 */
export function contextIdentityKey(binding: ContextBinding): string {
  return resolveContextIdentity(binding).key;
}

/** `true` iff two bindings name the same shared context (same substrate). */
export function sameContext(a: ContextBinding, b: ContextBinding): boolean {
  return contextIdentityKey(a) === contextIdentityKey(b);
}
