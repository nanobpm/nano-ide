// Slice S1 (binding) — the binding *descriptor*: the manifest shape
// `uses: context: { repo, ref }`.
//
// This is one half of the published contract that the consumer repo
// (nanobpm/nano-workforce#291) builds against, so the shape and the exported
// type name are deliberately **minimal and version-friendly**: a context is
// named by the substrate `repo` it lives in and the `ref` it is pinned to, and
// nothing more is required to bind it. Additional, backward-compatible fields
// may be layered on later without breaking existing manifests.

/**
 * A declared binding to an Urban **context** resource — the manifest shape
 * authored under `uses: { context: { repo, ref } }`.
 *
 * A context is a git-backed, governed memory substrate (see ADR 0051 — a
 * context behaves like an Urban datasource: a declared, bindable resource). The
 * pair `(repo, ref)` is the *name* of the context: two apps that declare the
 * same pair bind the same shared substrate; a different pair is a different,
 * private context (see {@link contextIdentityKey} in `./identity.ts`).
 *
 * The type is intentionally small and additive-friendly — treat it as a stable
 * contract. Unknown extra fields on input are tolerated by the validator but
 * are not part of the guaranteed shape.
 */
export interface ContextBinding {
  /**
   * The substrate repository that stores the context.
   *
   * Accepts an `owner/name` GitHub shorthand (resolved to
   * `https://github.com/owner/name.git`), a full git URL
   * (`https://…`, `ssh://…`, `git@host:owner/name.git`), or a local/`file://`
   * path (used chiefly for tests and self-hosted substrates). A local path must
   * be spelled unambiguously so it is not mistaken for the `owner/name`
   * shorthand: use an absolute path, a `file://…` URL, or a `./`- or
   * `../`-prefixed relative path. A bare relative path such as `subdir/repo`
   * matches the shorthand and is treated as GitHub, not a local path. The MVP
   * substrate is git-only, but resolution does not hard-code *public* git — see
   * the backend seam in `./resolver.ts`.
   */
  readonly repo: string;

  /**
   * The ref the context is **pinned** to: a branch, tag, or commit SHA. First
   * resolution clones the substrate; later resolutions refresh it to this ref.
   */
  readonly ref: string;
}

/** Error thrown when an untrusted value is not a valid {@link ContextBinding}. */
export class ContextBindingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ContextBindingError";
  }
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Validate an untrusted value as a {@link ContextBinding}, throwing a
 * {@link ContextBindingError} with a clear, field-scoped message on failure.
 *
 * Returns a *normalised* binding: `repo` and `ref` are trimmed. Extra fields on
 * the input object are ignored (forward-compatible) — only `repo` and `ref` are
 * carried through.
 */
export function parseContextBinding(value: unknown): ContextBinding {
  if (!isObjectRecord(value)) {
    throw new ContextBindingError(
      `context binding must be an object of the form { repo, ref }, received ${describe(value)}`,
    );
  }
  const record = value;
  if (!("repo" in record) || !isNonEmptyString(record.repo)) {
    throw new ContextBindingError(
      `context binding "repo" is required and must be a non-empty string, received ${describe(record.repo)}`,
    );
  }
  if (!("ref" in record) || !isNonEmptyString(record.ref)) {
    throw new ContextBindingError(
      `context binding "ref" is required and must be a non-empty string, received ${describe(record.ref)}`,
    );
  }
  return { repo: record.repo.trim(), ref: record.ref.trim() };
}

/** Type guard: `true` iff `value` is a valid {@link ContextBinding}. */
export function isContextBinding(value: unknown): value is ContextBinding {
  try {
    parseContextBinding(value);
    return true;
  } catch {
    return false;
  }
}

function describe(value: unknown): string {
  if (typeof value === "string") return JSON.stringify(value);
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}
