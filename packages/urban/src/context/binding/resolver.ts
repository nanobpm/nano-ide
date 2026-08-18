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
import { join, resolve as resolvePath } from "node:path";
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
   * Controls whether a re-resolution re-fetches the substrate. Note the
   * {@link ContextResolver} memoises per identity: once an identity has resolved,
   * repeat resolves return the cached handle and do **not** re-fetch unless you
   * explicitly pass `refresh: true`, which forces a fresh materialisation (a
   * fetch + re-pin on the backend). While a materialisation is still in flight,
   * concurrent resolves — including `refresh: true` — coalesce onto it rather
   * than starting a second one. The backend's own default (fetch on an existing
   * clone) therefore only applies the first time an identity is materialised or
   * when `refresh: true` is passed. Defaults to `undefined` (reuse the memoised
   * handle).
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
  const home = safeHomedir();
  if (home) return join(home, ".cache", "urban", "context");
  return join(tmpdir(), "urban", "context");
}

/** `os.homedir()`, but tolerant: returns `undefined` if the home dir can't be
 * determined (Node can throw here) so callers fall back to the temp dir. */
function safeHomedir(): string | undefined {
  try {
    return homedir() || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Resolves context bindings to concrete local working copies. A single resolver
 * instance enforces shared-on-same-name in-process by memoising per identity
 * key; distinct names stay private.
 */
export class ContextResolver {
  readonly #cacheRoot: string;
  readonly #backend: SubstrateBackend;
  readonly #inflight = new Map<string, { promise: Promise<ResolvedContextHandle>; settled: boolean }>();

  constructor(options: ContextResolverOptions = {}) {
    // Normalise to an absolute path so a relative `cacheRoot` (or a relative
    // `URBAN_CONTEXT_CACHE_DIR`) still yields an absolute `localPath`, honouring
    // `SubstrateResolveOptions.localPath` ("Absolute path…") and keeping the
    // on-disk location deterministic across processes whose CWD differs.
    this.#cacheRoot = resolvePath(options.cacheRoot ?? defaultContextCacheRoot());
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
    // a single materialisation. Coalesce onto an in-flight one regardless of
    // `refresh` — it is already producing a fresh working copy, so starting a
    // second `materialise()` would double-clone into the same `localPath` and
    // break the single-in-flight guarantee. Only re-materialise once the prior
    // resolution has settled AND the caller explicitly asked to `refresh`.
    const existing = this.#inflight.get(identity.key);
    if (existing && (!existing.settled || options.refresh !== true)) {
      return existing.promise;
    }

    const record: { promise: Promise<ResolvedContextHandle>; settled: boolean } = {
      promise: this.#backend
        .materialise(identity, { localPath, refresh: options.refresh })
        .catch((error) => {
          if (this.#inflight.get(identity.key) === record) {
            this.#inflight.delete(identity.key);
          }
          throw error;
        }),
      settled: false,
    };
    this.#inflight.set(identity.key, record);
    record.promise.then(
      () => {
        record.settled = true;
      },
      () => {
        // Rejection is surfaced to the caller via the returned promise; the map
        // entry is already removed in the catch above.
      },
    );
    return record.promise;
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
