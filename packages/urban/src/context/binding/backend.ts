// Slice S1 (binding) — the resolution seam: types shared by the resolver and
// any substrate backend.
//
// Resolution turns a validated binding into a concrete local working copy of
// the substrate, returning a **resolved handle** (local path + repo/ref
// identity). Downstream slices consume the handle: S3 (git substrate /
// governance) writes append-via-commit into `localPath`, and S4 (retrieval)
// reads from it. S1 owns clone/pull wiring ONLY — it exposes a clean handle and
// deliberately contains no commit/PR/write or governance logic.
//
// The `SubstrateBackend` interface is the seam that keeps resolution from
// hard-coding "the substrate is exclusively a public git repo": the default
// backend is git, but a future PII/mutable or self-hosted backend can implement
// the same interface without touching the resolver or callers.

import type { ContextIdentity } from "./identity.ts";

/**
 * A concrete, resolved handle to a context substrate: a local working copy
 * pinned to `ref`, plus its repo/ref identity. This is the value S3 and S4
 * build on.
 */
export interface ResolvedContextHandle {
  /** Canonical identity of the bound context (see {@link ContextIdentity}). */
  readonly identity: ContextIdentity;
  /** Absolute path to the local working copy of the substrate. */
  readonly localPath: string;
  /** The concrete substrate repo URL/path that was cloned. */
  readonly repo: string;
  /** The ref the working copy is pinned to. */
  readonly ref: string;
}

/** Options passed to a backend when materialising a substrate working copy. */
export interface SubstrateResolveOptions {
  /**
   * Absolute path the working copy MUST live at. The resolver derives this
   * deterministically from the identity so that the same name maps to the same
   * on-disk substrate (shared-on-same-name).
   */
  readonly localPath: string;
  /**
   * When `true`, refresh an already-present working copy (fetch + re-pin to
   * `ref`). When `false`, an existing working copy is reused as-is without
   * touching the network. Defaults to `true`.
   */
  readonly refresh?: boolean;
}

/**
 * A pluggable substrate backend. The default is git (see `./git-backend.ts`),
 * but this interface is the seam for a future PII/mutable or self-hosted
 * backend — the resolver and its callers depend only on this contract.
 */
export interface SubstrateBackend {
  /**
   * Materialise (clone on first use, refresh thereafter) the substrate for
   * `identity` at `options.localPath`, pinned to `identity.ref`, and return the
   * resolved handle.
   */
  materialise(
    identity: ContextIdentity,
    options: SubstrateResolveOptions,
  ): Promise<ResolvedContextHandle>;
}
