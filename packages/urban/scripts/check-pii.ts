// Slice s6-pii-ci — the OUTER, build-time half of the no-PII guard.
//
// The inline, by-construction net already exists: S6-core ships the PII
// classifier + mandatory default-DENY pre-commit guard, and S3 wires that guard
// as the non-optional pre-commit step on every git write path, so PII can never
// be committed through the writer. This script is the SECOND line of defence —
// a build-time scan run in CI (`npm run check:pii --workspace @nanobpm/urban`)
// that walks content ALREADY targeted at a git-backed context (records laid out
// under the S3 path/namespace partitioning) and re-classifies it with the SAME
// S6-core classifier. It exits non-zero on any violation (failing the build) and
// zero on clean content. It never weakens or duplicates the core guard — it
// reuses `classifyPii` verbatim.
//
// Usage:
//   node --experimental-strip-types scripts/check-pii.ts [rootDir ...]
//
// Each `rootDir` (default: the current working directory) is treated as a
// substrate root; the script scans every record file beneath its `records/`
// layout (see @nanobpm/urban/context/git `isRecordPath`). Findings are reported
// with their kind + located field path and a length-only redacted excerpt, so a
// failing run never re-leaks the PII it caught.

import { readFile, readdir } from "node:fs/promises";
import type { Dirent } from "node:fs";
import { join, relative, sep } from "node:path";
import { classifyPii, type PiiFinding } from "../src/context/pii/index.ts";
import { LAYOUT_ROOT, isRecordPath } from "../src/context/git/index.ts";

interface RecordViolation {
  readonly file: string;
  readonly findings: readonly PiiFinding[];
}

/** `true` when a thrown error is a Node "no such file or directory" error. */
function isMissingPath(error: unknown): boolean {
  const code =
    typeof error === "object" && error !== null ? Reflect.get(error, "code") : undefined;
  return code === "ENOENT";
}

/** Narrow an unknown JSON value to a scannable plain object (arrays excluded). */
function isPlainObject(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Walk a substrate root and return every layout record file (absolute paths). */
async function collectRecordFiles(root: string): Promise<string[]> {
  const layoutRoot = join(root, LAYOUT_ROOT);
  const files: string[] = [];
  // A hand-rolled walk (NOT `readdir(recursive: true)`) is mandatory here: the
  // built-in recursive readdir FOLLOWS symlinked directories, so a
  // `records/<scope>` symlink pointing outside the substrate root would have its
  // contents traversed and scanned. We instead read one level with
  // `withFileTypes` and refuse to descend into — or collect — ANY symlink, so no
  // path outside `root` (e.g. a CI secret) can ever be `readFile`d and
  // classified, whether the symlink is an intermediate directory or the final
  // record file.
  async function walk(dir: string): Promise<void> {
    let dirents: Dirent[];
    try {
      dirents = await readdir(dir, { withFileTypes: true });
    } catch (error) {
      // A root with no `records/` directory simply has nothing to scan.
      if (isMissingPath(error)) return;
      throw error;
    }
    for (const dirent of dirents) {
      // Skip symlinks outright (dirs and files alike): descending into or
      // reading one is exactly the escape-outside-root vector we must not allow.
      if (dirent.isSymbolicLink()) continue;
      const absolute = join(dir, dirent.name);
      if (dirent.isDirectory()) {
        await walk(absolute);
        continue;
      }
      if (!dirent.isFile()) continue;
      const relFromRoot = relative(root, absolute).split(sep).join("/");
      if (isRecordPath(relFromRoot)) files.push(absolute);
    }
  }
  await walk(layoutRoot);
  return files;
}

/** Classify one record file, preferring its parsed JSON shape over raw text. */
async function classifyFile(file: string): Promise<readonly PiiFinding[]> {
  const text = await readFile(file, "utf8");
  let candidate: unknown;
  try {
    candidate = JSON.parse(text);
  } catch {
    // A record that is not valid JSON still gets scanned as raw text so PII can
    // never slip through on a malformed file.
    return classifyPii(text).findings;
  }
  if (isPlainObject(candidate)) {
    return classifyPii(candidate).findings;
  }
  return classifyPii(text).findings;
}

async function main(): Promise<number> {
  const roots = process.argv.slice(2);
  if (roots.length === 0) roots.push(process.cwd());

  const violations: RecordViolation[] = [];
  let scanned = 0;
  for (const root of roots) {
    const files = await collectRecordFiles(root);
    for (const file of files) {
      scanned += 1;
      const findings = await classifyFile(file);
      if (findings.length > 0) violations.push({ file, findings });
    }
  }

  if (violations.length > 0) {
    console.error(
      `check:pii — FAILED: PII detected in ${violations.length} of ${scanned} scanned record(s).`,
    );
    for (const { file, findings } of violations) {
      for (const f of findings) {
        const where = f.path ? ` @ ${f.path}` : "";
        console.error(`  ${file}: ${f.kind}${where} (${f.excerpt}) — ${f.reason}`);
      }
    }
    return 1;
  }

  console.log(`check:pii — OK: ${scanned} record(s) scanned, no PII detected.`);
  return 0;
}

const code = await main();
process.exit(code);
