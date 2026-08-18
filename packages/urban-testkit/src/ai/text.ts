// Shared helper for rendering arbitrary text inside error messages (issue #297, slice S1).
//
// The single canonical implementation used everywhere an untrusted/unbounded string
// (a verdict blob, a cassette key carrying a full serialized prompt + base64 image data)
// is interpolated into a thrown Error. Keeping ONE implementation avoids drift between
// the verdict parser and the record/replay adapters (AGENTS.md: derivation over duplication).

/**
 * Renders arbitrary text for an error message: JSON-quoted (so newlines/control characters
 * can't mangle logs) and length-capped (so a huge blob — e.g. a long prompt or base64 image
 * payload — can't drown the message). Callers should attach the untruncated original via the
 * error's `cause` when they need it for debugging.
 */
export function describeText(text: string, maxLength = 200): string {
  const quoted = JSON.stringify(text);
  return quoted.length > maxLength ? `${quoted.slice(0, maxLength)}…` : quoted;
}
