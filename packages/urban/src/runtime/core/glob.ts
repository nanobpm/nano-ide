// A deliberately tiny glob: resolves patterns of the form "dir/*.ext" (a single directory
// plus a `*.ext` or `*` leaf) against the host filesystem. This covers the manifest
// `models` patterns (e.g. "processes/*.bpmn") without pulling in a glob dependency, keeping
// core runtime-agnostic. A literal path (no `*`) resolves to itself if it exists.

import type { HostContext } from "./host.ts";

function joinPath(a: string, b: string): string {
  if (!a) return b;
  return `${a.replace(/\/+$/, "")}/${b.replace(/^\/+/, "")}`;
}

/** Expand a single pattern (relative to `root`) to a sorted list of matching file paths. */
export async function expandPattern(
  host: HostContext,
  root: string,
  pattern: string,
): Promise<string[]> {
  if (!pattern.includes("*")) {
    const p = joinPath(root, pattern);
    return (await host.exists(p)) ? [p] : [];
  }
  const slash = pattern.lastIndexOf("/");
  const dirPart = slash >= 0 ? pattern.slice(0, slash) : "";
  const leaf = slash >= 0 ? pattern.slice(slash + 1) : pattern;
  const dir = joinPath(root, dirPart);

  let re: RegExp;
  if (leaf === "*") {
    re = /.*/;
  } else if (leaf.startsWith("*.")) {
    const ext = leaf.slice(1); // ".bpmn"
    re = new RegExp(`${ext.replace(/[.]/g, "\\.")}$`);
  } else {
    // Fall back to translating a simple leaf glob (`*` → `.*`).
    re = new RegExp(`^${leaf.replace(/[.]/g, "\\.").replace(/\*/g, ".*")}$`);
  }

  const names = await host.listDir(dir);
  return names
    .filter((n) => re.test(n))
    .sort()
    .map((n) => joinPath(dir, n));
}

/** Expand many patterns, de-duplicating while preserving first-seen order. */
export async function expandPatterns(
  host: HostContext,
  root: string,
  patterns: string[] | undefined,
): Promise<string[]> {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const pat of patterns ?? []) {
    for (const p of await expandPattern(host, root, pat)) {
      if (!seen.has(p)) {
        seen.add(p);
        out.push(p);
      }
    }
  }
  return out;
}

/**
 * Discover deployables under a convention directory (`resources/`), **shallow, one level deep**:
 * the files directly under `dir` plus the files one sub-directory down (`dir/<subdir>/*`), but
 * never deeper. The shallow bound is deliberate — deploy dedupes by basename (filename only), so a
 * deep recursive walk would reintroduce cross-directory basename-collision risk. Sub-directory
 * descent needs `host.listSubdirs`; a host that can't enumerate directories yields only the
 * top-level files. Returns root-prefixed paths, sorted for determinism.
 */
export async function discoverResources(
  host: HostContext,
  root: string,
  dir: string,
): Promise<string[]> {
  const base = joinPath(root, dir);
  const out: string[] = [];
  for (const name of await host.listDir(base)) out.push(joinPath(base, name));
  const subdirs = host.listSubdirs ? await host.listSubdirs(base) : [];
  for (const sub of subdirs.slice().sort()) {
    const subBase = joinPath(base, sub);
    for (const name of await host.listDir(subBase)) out.push(joinPath(subBase, name));
  }
  return out.sort();
}
