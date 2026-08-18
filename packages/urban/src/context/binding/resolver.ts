// Slice S1 (binding) — the resolver: bind → validate → identity → resolved
// handle, with private-per-app / shared-on-same-name semantics enforced two
// ways:
//
//  1. In-process: a ContextResolver memoises by identity key, so two resolves of
//     the same name return the SAME handle (and never double-clone), while
//     distinct names get distinct handles.
//  2. Across processes/instances: the on-disk location is derived
//     deterministically from the identity slug under a shared cache root, so two
//     Nano instances naming the same context share one working copy on disk.

import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { type ContextBinding, parseContextBinding } from "./descriptor.ts";
import { resolveContextIdentity } from "./identity.ts";
import { GitSubstrateBackend } from "./git-backend.ts";
import type { ResolvedContextHandle, SubstrateBackend } from "./backend.ts";

/** Options for a {@link ContextResolver}. */
export interface ContextResolverOptions {
  /**
   * Root directory under which per-context working copies are cloned. Two
   * resolvers sharing a `cacheRoot` share substrates on disk. Defaults to
   * {@link defaultContextCacheRoot}.
   */
  readonly cacheRoot?: string;
  /**
   * The substrate backend. Defaults to a git backend ({@link GitSubstrateBackend}).
   * Injecting a different backend is the seam for a future PII/mutable or
   * self-hosted substrate.
   */
  readonly backend?: SubstrateBackend;
}

/** Per-resolution overrides. */
export interface ResolveOptions {
  /**
   * When `false`, reuse an existing on-disk working copy without fetching.
   * Defaults to `true` (clone on first use, refresh thereafter).
   */
  readonly refresh?: boolean;
}

/**
 * The default cache root for context working copies. Honours
 * `URBAN_CONTEXT_CACHE_DIR`, then `XDG_CACHE_HOME`, then `~/.cache`, falling
 * back to the OS temp dir when no home directory is available.
 */
export function defaultContextCacheRoot(env: NodeJS.ProcessEnv = process.env): string {
  if (env.URBAN_CONTEXT_CACHE_DIR) return env.URBAN_CONTEXT_CACHE_DIR;
  if (env.XDG_CACHE_HOME) return join(env.XDG_CACHE_HOME, "urban", "context");
  const home = homedir();
  if (home) return join(home, ".cache", "urban", "context");
  return join(tmpdir(), "urban", "context");
}

/**
 * Resolves context bindings to concrete local working copies. A single resolver
 * instance enforces shared-on-same-name in-process by memoising per identity
 * key; distinct names stay private.
 */
export class ContextResolver {
  readonly #cacheRoot: string;
  readonly #backend: SubstrateBackend;
  readonly #inflight = new Map<string, Promise<ResolvedContextHandle>>();

  constructor(options: ContextResolverOptions = {}) {
    this.#cacheRoot = options.cacheRoot ?? defaultContextCacheRoot();
    this.#backend = options.backend ?? new GitSubstrateBackend();
  }

  /** The cache root this resolver clones into. */
  get cacheRoot(): string {
    return this.#cacheRoot;
  }

  /**
   * Resolve a binding (validated first) to a {@link ResolvedContextHandle}. Two
   * bindings that name the same context return the identical handle from this
   * resolver; distinct names return distinct handles.
   */
  async resolve(
    binding: ContextBinding | unknown,
    options: ResolveOptions = {},
  ): Promise<ResolvedContextHandle> {
    const parsed = parseContextBinding(binding);
    const identity = resolveContextIdentity(parsed);
    const localPath = join(this.#cacheRoot, identity.slug);

    // Shared-on-same-name: concurrent or repeated resolves of one identity share
    // a single in-flight materialisation and its resulting handle.
    const existing = this.#inflight.get(identity.key);
    if (existing && options.refresh !== true) return existing;

    const pending = this.#backend
      .materialise(identity, { localPath, refresh: options.refresh })
      .catch((error) => {
        this.#inflight.delete(identity.key);
        throw error;
      });
    this.#inflight.set(identity.key, pending);
    return pending;
  }
}

/**
 * One-shot convenience: resolve a single binding with a fresh resolver. Prefer a
 * long-lived {@link ContextResolver} when resolving many bindings so sharing is
 * memoised across calls.
 */
export function resolveContextBinding(
  binding: ContextBinding | unknown,
  options: ContextResolverOptions & ResolveOptions = {},
): Promise<ResolvedContextHandle> {
  const { cacheRoot, backend, ...resolveOptions } = options;
  return new ContextResolver({ cacheRoot, backend }).resolve(binding, resolveOptions);
}
