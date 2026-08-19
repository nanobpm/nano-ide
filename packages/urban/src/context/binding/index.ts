// @nanobpm/urban/context/binding — slice S1.
//
// The bindable `context` resource: the binding descriptor (`uses: context:
// { repo, ref }`) plus local↔remote resolution to a resolved handle, with
// private-per-app / shared-on-same-name identity semantics. This is one half of
// the published contract nanobpm/nano-workforce#291 builds against.
//
// Downstream: S3 (git substrate/governance) and S4 (retrieval) consume the
// ResolvedContextHandle; the SubstrateBackend interface is the seam for a
// future PII/mutable or self-hosted backend.

export {
  type ContextBinding,
  ContextBindingError,
  isContextBinding,
  parseContextBinding,
} from "./descriptor.ts";

export {
  type ContextIdentity,
  contextIdentityKey,
  resolveContextIdentity,
  sameContext,
} from "./identity.ts";

export {
  type ResolvedContextHandle,
  type SubstrateBackend,
  type SubstrateResolveOptions,
} from "./backend.ts";

export {
  GitSubstrateBackend,
  type GitRunner,
  GIT_SAFETY_CONFIG,
  hardenedGitArgs,
  redactUrlUserinfo,
  SubstrateResolveError,
} from "./git-backend.ts";

export {
  ContextResolver,
  type ContextResolverOptions,
  type ResolveOptions,
  defaultContextCacheRoot,
  resolveContextBinding,
} from "./resolver.ts";
